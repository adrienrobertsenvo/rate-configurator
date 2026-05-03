// Upload the 3-part benuta contract (XLSX + PDF + XLSX) as a single contract.
//
// Run: npx tsx scripts/upload_benuta.ts
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { db } from "../app/lib/db";
import { extractContract, type ExtractedContract, type SourceFile } from "../app/lib/carriers/dhl-express/extract";

const FILES: { path: string; kind: "pdf" | "xlsx" | "csv" }[] = [
  { path: "/Users/mariekober/Downloads/Carrier_Preisinformation_2026_DHL_Express_1_02.02.26 (1).XLSX", kind: "xlsx" },
  { path: "/Users/mariekober/Downloads/Carrier_Preisinformation_2026_DHL_Express_2_02.02.26 (2).PDF", kind: "pdf" },
  { path: "/Users/mariekober/Downloads/Carrier_Preisinformation_2026_DHL_Express_3_02.02.26 (2).xlsx", kind: "xlsx" },
];

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const ZONE_GROUP_BY_PRODUCT: Record<string, string> = {
  "Express Worldwide Export":        "worldwide",
  "Express Worldwide Import":        "worldwide",
  "Express Worldwide Third Country": "worldwide",
  "Express 12:00 (Document)":        "worldwide",
  "Economy Select Export":           "economy",
  "Economy Select Import":           "economy",
  "Express Domestic":                "domestic",
};

async function saveExtracted(e: ExtractedContract, sources: SourceFile[]): Promise<number> {
  const catalog = await db.catalogSurcharge.findMany({ where: { carrier: e.carrier } });
  const codeByNormName = new Map<string, string>();
  for (const c of catalog) codeByNormName.set(normalizeName(c.name), c.code);

  function resolveAddonCode(extractorCode: string | null, name: string): string {
    if (extractorCode && extractorCode.length <= 4) return extractorCode;
    const canonical = codeByNormName.get(normalizeName(name));
    if (canonical) return canonical;
    return extractorCode ?? `UNK-${name.slice(0, 6)}`;
  }

  const created = await db.contract.create({
    data: {
      name: e.name, carrier: e.carrier, billing_country: e.billing_country.toUpperCase(),
      currency_code: e.currency_code || "EUR",
      volumetric_divisor: e.volumetric_divisor || 5000,
      valid_from: e.valid_from, valid_until: e.valid_until,
      addons: { create: e.addons.map((a) => ({
        code: resolveAddonCode(a.code ?? null, a.name),
        name: a.name, kind: a.kind, amount: a.amount,
      })) },
    },
    select: { id: true },
  });

  for (let pi = 0; pi < e.freight.length; pi++) {
    const p = e.freight[pi];
    const product = await db.freightProduct.create({
      data: { contractId: created.id, name: p.name, order: pi, zone_group: ZONE_GROUP_BY_PRODUCT[p.name] ?? "default" },
      select: { id: true },
    });
    for (let si = 0; si < p.sub_products.length; si++) {
      const sp = p.sub_products[si];
      const sub = await db.subProduct.create({
        data: { productId: product.id, name: sp.name, description: sp.description, codes: sp.codes.length ? sp.codes.join(",") : null, order: si },
        select: { id: true },
      });
      for (const z of sp.zones) {
        let order = 0;
        for (const b of z.bands) {
          await db.priceBand.create({
            data: {
              subProductId: sub.id, zone: z.zone, order: order++,
              weight_start: b.weight_start_g, weight_end: b.weight_end_g,
              price: b.price, per_kg: b.per_kg, step: b.step_kg, confidence: b.confidence,
            },
          });
        }
      }
    }
  }

  for (const f of sources) {
    await db.contractSource.create({
      data: {
        contractId: created.id,
        filename: f.name, kind: f.kind, size_bytes: f.bytes.byteLength,
        sha256: createHash("sha256").update(f.bytes).digest("hex"),
        bytes: f.bytes,
      },
    });
  }

  return created.id;
}

async function main() {
  const sources: SourceFile[] = FILES.map(({ path, kind }) => ({
    name: path.split("/").pop()!,
    kind,
    bytes: readFileSync(path),
  }));
  console.log(`Extracting ${sources.length} files together as one contract:`);
  for (const s of sources) console.log(`  - ${s.name} (${(s.bytes.byteLength / 1024).toFixed(1)} KB ${s.kind})`);
  const extracted = await extractContract(sources);
  console.log(`\nname="${extracted.name}"`);
  console.log(`carrier=${extracted.carrier} billing_country=${extracted.billing_country} currency=${extracted.currency_code}`);
  console.log(`valid: ${extracted.valid_from} → ${extracted.valid_until}`);
  console.log(`freight products=${extracted.freight.length}, surcharges=${extracted.addons.length}`);
  if (extracted.notes) console.log(`notes: ${extracted.notes.slice(0, 500)}${extracted.notes.length > 500 ? "…" : ""}`);
  const id = await saveExtracted(extracted, sources);
  console.log(`\nsaved as contract #${id}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

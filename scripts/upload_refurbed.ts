// One-off: upload the three Refurbed XLSX rate cards (DE, GB, FR) as separate
// contracts via the existing extraction pipeline. Records source documents.
//
// Run: npx tsx scripts/upload_refurbed.ts
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { db } from "../app/lib/db";
import { extractContract, type ExtractedContract } from "../app/lib/extract";

const FILES = [
  // DE saved #8, FR saved #9 already; only GB needs to be retried (with bumped max_tokens).
  "/Users/mariekober/Downloads/ID_106459_01_EMEA_V01_Refurbed_GB_20251024-112327-414.xlsx",
];

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function saveExtracted(e: ExtractedContract, sources: { name: string; bytes: Buffer }[]): Promise<number> {
  const catalog = await db.catalogSurcharge.findMany({ where: { carrier: e.carrier } });
  const codeByNormName = new Map<string, string>();
  for (const c of catalog) codeByNormName.set(normalizeName(c.name), c.code);

  function resolveAddonCode(extractorCode: string | null, name: string): string {
    if (extractorCode && extractorCode.length <= 4) return extractorCode;
    const canonical = codeByNormName.get(normalizeName(name));
    if (canonical) return canonical;
    return extractorCode ?? `UNK-${name.slice(0, 6)}`;
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

  const created = await db.contract.create({
    data: {
      name: e.name, carrier: e.carrier, billing_country: e.billing_country.toUpperCase(),
      currency_code: e.currency_code || "EUR",
      volumetric_divisor: e.volumetric_divisor || 5000,
      valid_from: e.valid_from, valid_until: e.valid_until,
      addons: {
        create: e.addons.map((a) => ({
          code: resolveAddonCode(a.code ?? null, a.name),
          name: a.name, kind: a.kind, amount: a.amount,
        })),
      },
    },
    select: { id: true },
  });

  for (let pi = 0; pi < e.freight.length; pi++) {
    const p = e.freight[pi];
    const product = await db.freightProduct.create({
      data: {
        contractId: created.id, name: p.name, order: pi,
        zone_group: ZONE_GROUP_BY_PRODUCT[p.name] ?? "default",
      },
      select: { id: true },
    });
    for (let si = 0; si < p.sub_products.length; si++) {
      const sp = p.sub_products[si];
      const sub = await db.subProduct.create({
        data: {
          productId: product.id, name: sp.name, description: sp.description,
          codes: sp.codes.length ? sp.codes.join(",") : null, order: si,
        },
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
        filename: f.name, kind: "xlsx", size_bytes: f.bytes.byteLength,
        sha256: createHash("sha256").update(f.bytes).digest("hex"),
        bytes: f.bytes,
      },
    });
  }

  return created.id;
}

async function main() {
  for (const path of FILES) {
    const filename = path.split("/").pop()!;
    const bytes = readFileSync(path);
    console.log(`\n→ ${filename} (${(bytes.byteLength / 1024).toFixed(1)} KB)`);
    try {
      const extracted = await extractContract([{ name: filename, kind: "xlsx", bytes }]);
      console.log(`  name="${extracted.name}"`);
      console.log(`  carrier=${extracted.carrier} billing_country=${extracted.billing_country}`);
      console.log(`  valid_from=${extracted.valid_from} valid_until=${extracted.valid_until}`);
      console.log(`  freight products=${extracted.freight.length}, surcharges=${extracted.addons.length}`);
      if (extracted.notes) console.log(`  notes: ${extracted.notes.slice(0, 400)}${extracted.notes.length > 400 ? "…" : ""}`);
      const id = await saveExtracted(extracted, [{ name: filename, bytes }]);
      console.log(`  saved as contract #${id}`);
    } catch (e) {
      console.log(`  FAILED: ${(e as Error).message?.slice(0, 200) ?? e}`);
    }
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

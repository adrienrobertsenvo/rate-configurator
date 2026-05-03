// Extract the 2026 UPS contract for everstox (price list + additional services)
// and save it as a new Contract row linked to the existing everstox Customer.
//
// Two files, treated as ONE contract — the LLM merges rates from the price
// list with the surcharge metadata from the additional-services doc.
//
// Run: npx tsx scripts/upload_ups_everstox_2026.ts
//      (requires .env with ANTHROPIC_API_KEY loaded; tsx doesn't auto-load
//       it, so prefix with `set -a && source .env && set +a &&`).
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { db } from "../app/lib/db";
import { extractContract, type ExtractedContract, type SourceFile } from "../app/lib/carriers/ups";

const FILES: { path: string; kind: "pdf" | "xlsx" | "csv" }[] = [
  // We feed BOTH the rates XLSX and the surcharges PDF — sheet structure of
  // the XLSX gives the LLM exact cell values; the PDF has the surcharges in
  // narrative form which the XLSX doesn't replicate cleanly.
  { path: "/tmp/ups/contracts/INTERNAL_senvo_2026_UPS_General price list.xlsx", kind: "xlsx" },
  { path: "/tmp/ups/contracts/INTERNAL_senvo_2026_UPS_Additional Services and Charges_en.pdf", kind: "pdf" },
];

const EVERSTOX_CUSTOMER_CODE = "everstox";
const CONTRACT_NAME = "UPS Germany — everstox GmbH 2026";

// Account numbers from the user's screenshot of the Senvo UPS tenant for
// everstox. UPS shows them in the short form (no leading zeros) in their UI;
// the CSV pads with leading zeros to 10 chars. We store the SHORT form.
const ACCOUNT_NUMBERS = ["0FF320", "0FV055", "0FV384", "0W896E", "0X008W", "0X032R", "62W6X8", "889AW6"];

// Most UPS contracts use one zone group across all products. If the contract
// has a separate "international zones" vs "European zones" split, we'll
// surface that in the extracted data; for now keep all products on the
// same zone group so the engine doesn't need to disambiguate.
const ZONE_GROUP_BY_PRODUCT: Record<string, string> = {};

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function saveExtracted(
  e: ExtractedContract,
  sources: SourceFile[],
  customerId: number,
): Promise<number> {
  // Resolve UPS surcharge codes against the catalog. We seed UPS-specific
  // catalog rows when none exist so the extractor's free-text codes get a
  // canonical home. Unlike DHL we don't have a populated CatalogSurcharge yet
  // for UPS — fallback path is "use the extracted code as-is".
  const catalog = await db.catalogSurcharge.findMany({ where: { carrier: e.carrier } });
  const codeByNormName = new Map<string, string>();
  for (const c of catalog) codeByNormName.set(normalizeName(c.name), c.code);

  function resolveAddonCode(extractorCode: string | null, name: string): string {
    if (extractorCode && extractorCode.length <= 5) return extractorCode;
    const canonical = codeByNormName.get(normalizeName(name));
    if (canonical) return canonical;
    return extractorCode ?? `UNK-${name.slice(0, 6)}`;
  }

  const created = await db.contract.create({
    data: {
      name: CONTRACT_NAME,
      carrier: e.carrier,
      billing_country: e.billing_country.toUpperCase(),
      currency_code: e.currency_code || "EUR",
      volumetric_divisor: e.volumetric_divisor || 5000,
      valid_from: e.valid_from,
      valid_until: e.valid_until,
      customerId,
      account_numbers: JSON.stringify(ACCOUNT_NUMBERS.sort()),
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
  const customer = await db.customer.findUnique({ where: { code: EVERSTOX_CUSTOMER_CODE }, select: { id: true } });
  if (!customer) throw new Error(`Customer "${EVERSTOX_CUSTOMER_CODE}" not found`);

  const sources: SourceFile[] = FILES.map(({ path, kind }) => ({
    name: path.split("/").pop()!,
    kind,
    bytes: readFileSync(path),
  }));
  console.log(`Extracting UPS contract from ${sources.length} files:`);
  for (const s of sources) console.log(`  - ${s.name} (${(s.bytes.byteLength / 1024).toFixed(1)} KB ${s.kind})`);

  const extracted = await extractContract(sources);
  console.log(`\n  → name="${extracted.name}"  carrier=${extracted.carrier}  ${extracted.billing_country}/${extracted.currency_code}`);
  console.log(`  → valid: ${extracted.valid_from} → ${extracted.valid_until}`);
  console.log(`  → freight=${extracted.freight.length} surcharges=${extracted.addons.length}`);
  for (const p of extracted.freight) {
    const totalBands = p.sub_products.reduce((acc, sp) => acc + sp.zones.reduce((a2, z) => a2 + z.bands.length, 0), 0);
    console.log(`    · ${p.name} — ${p.sub_products.length} sub-product(s), ${totalBands} band(s)`);
  }
  if (extracted.notes) console.log(`  notes: ${extracted.notes.slice(0, 500)}${extracted.notes.length > 500 ? "…" : ""}`);

  const id = await saveExtracted(extracted, sources, customer.id);
  console.log(`\n✓ Saved contract #${id}`);
  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });

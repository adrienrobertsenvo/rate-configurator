// Replace contract #16's freight rate cards with the deterministic XLSX
// parser output. Keeps the LLM-extracted surcharges (108 of them) + account
// numbers + customer linkage intact.
//
// Why: the LLM detail pass missed bands for most products (Standard Single,
// Express Saver, etc.) — got 0 zones for them. The XLSX has a regular
// structure that parses cleanly without an LLM, recovering ~1,148 bands.
//
// Run: npx tsx scripts/replace_ups_freight_bands.ts
import { readFileSync } from "node:fs";
import { db } from "../app/lib/db";
import { parseUpsRateXlsx, type ParsedSheet } from "../app/lib/carriers/ups/extract-rates-xlsx";

const CONTRACT_ID = 16;
const PRICE_LIST_PATH = "/tmp/ups/contracts/INTERNAL_senvo_2026_UPS_General price list.xlsx";

// Sheet → product/sub-product/code mapping. Each rate sheet becomes one
// FreightProduct + SubProduct combo. UPS service codes match what the
// billing CSVs actually use — single Std covers both 011 (Standard) and 003
// (Domestic Standard); the import sheets share the same UPS codes since the
// audit engine doesn't currently dispatch on direction.
interface SheetMapping {
  sheet_name: string;
  product_name: string;       // canonical name for the FreightProduct row
  sub_product_name: string;
  codes: string[];            // UPS service codes that map here
  zone_group: string;         // groups products that share a zone table
}

const SHEET_MAPPINGS: SheetMapping[] = [
  { sheet_name: "DE E-Express",          product_name: "Worldwide Express (Export)",         sub_product_name: "Package", codes: ["007"], zone_group: "ww-export" },
  { sheet_name: "DE E-Express Saver",    product_name: "Worldwide Express Saver (Export)",   sub_product_name: "Package", codes: ["069", "065"], zone_group: "ww-export" },
  { sheet_name: "DE E-Standard Single",  product_name: "Standard Single (Export)",           sub_product_name: "Package", codes: ["011", "003"], zone_group: "tb-export" },
  { sheet_name: "DE E-Standard Multi",   product_name: "Standard Multi (Export)",            sub_product_name: "Package", codes: ["011", "003"], zone_group: "tb-export" },
  { sheet_name: "DE I-Express",          product_name: "Worldwide Express (Import)",         sub_product_name: "Package", codes: ["007"], zone_group: "ww-import" },
  { sheet_name: "DE I-Express Saver",    product_name: "Worldwide Express Saver (Import)",   sub_product_name: "Package", codes: ["069", "065"], zone_group: "ww-import" },
  { sheet_name: "DE I-Standard Single",  product_name: "Standard Single (Import)",           sub_product_name: "Package", codes: ["011", "003"], zone_group: "tb-import" },
  { sheet_name: "DE I-Standard Multi",   product_name: "Standard Multi (Import)",            sub_product_name: "Package", codes: ["011", "003"], zone_group: "tb-import" },
];

async function main() {
  const sheets = parseUpsRateXlsx(readFileSync(PRICE_LIST_PATH));
  const bySheetName = new Map<string, ParsedSheet>(sheets.map((s) => [s.sheet_name, s]));

  // Sanity check that every mapping has a parsed sheet.
  const missing = SHEET_MAPPINGS.filter((m) => !bySheetName.has(m.sheet_name));
  if (missing.length) throw new Error(`Sheets not found in XLSX: ${missing.map((m) => m.sheet_name).join(", ")}`);

  // Wipe the existing freight side of the contract — keep addons, sources,
  // account_numbers, customerId, valid_from/until.
  console.log(`Wiping freight on contract #${CONTRACT_ID}…`);
  await db.priceBand.deleteMany({
    where: { subProduct: { product: { contractId: CONTRACT_ID } } },
  });
  await db.subProduct.deleteMany({
    where: { product: { contractId: CONTRACT_ID } },
  });
  await db.freightProduct.deleteMany({
    where: { contractId: CONTRACT_ID },
  });

  let totalBands = 0;
  for (let pi = 0; pi < SHEET_MAPPINGS.length; pi++) {
    const m = SHEET_MAPPINGS[pi];
    const parsed = bySheetName.get(m.sheet_name)!;
    const product = await db.freightProduct.create({
      data: {
        contractId: CONTRACT_ID,
        name: m.product_name,
        order: pi,
        zone_group: m.zone_group,
      },
      select: { id: true },
    });
    const sub = await db.subProduct.create({
      data: {
        productId: product.id,
        name: m.sub_product_name,
        description: parsed.product_name,  // raw "UPS Standard Single" etc.
        codes: m.codes.join(","),
        order: 0,
      },
      select: { id: true },
    });
    let bands = 0;
    for (const z of parsed.zones) {
      let order = 0;
      for (const b of z.bands) {
        await db.priceBand.create({
          data: {
            subProductId: sub.id,
            zone: z.zone,
            order: order++,
            weight_start: b.weight_start_g,
            weight_end: b.weight_end_g,
            price: b.price,
            per_kg: b.per_kg,
            step: b.step_kg,
          },
        });
        bands++;
      }
    }
    totalBands += bands;
    console.log(`  ✓ ${m.product_name}  ←  ${m.sheet_name}  (${parsed.zones.length} zones, ${bands} bands, codes=${m.codes.join("/")})`);
  }
  console.log(`\nDONE: replaced freight on contract #${CONTRACT_ID} — ${SHEET_MAPPINGS.length} products, ${totalBands} bands.`);

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

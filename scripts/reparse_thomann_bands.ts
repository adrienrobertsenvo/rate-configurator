// Re-parse Thomann rate cards with the fixed asNumber (German decimal commas
// now correctly handled) and replace the freight bands on contract #18.
import { readFileSync } from "node:fs";
import { db } from "../app/lib/db";
import { parseUpsRateXlsx, type ParsedSheet } from "../app/lib/carriers/ups/extract-rates-xlsx";

const CONTRACT_ID = 18;
const PRICE_LIST_PATH = "/tmp/ups/thomann/UPS Preisliste ab 01.07.2025.xlsx";

const SHEET_TO_PRODUCT: Record<string, string> = {
  "DE E-Express":                 "Worldwide Express (Export)",
  "DE E-Express Saver":           "Worldwide Express Saver (Export)",
  "DE E-Standard Single Lane":    "Standard Single (Export)",
  "DE E-Standard Multi Lane":     "Standard Multi (Export)",
  "DE E-Expedited":               "Worldwide Expedited (Export)",
  "DE I-Express":                 "Worldwide Express (Import)",
  "DE I-Express Saver":           "Worldwide Express Saver (Import)",
  "DE I-Standard Single Lane":    "Standard Single (Import)",
  "DE I-Standard Multi Lane":     "Standard Multi (Import)",
  "DE I-Expedited":               "Worldwide Expedited (Import)",
};

async function main() {
  const sheets = parseUpsRateXlsx(readFileSync(PRICE_LIST_PATH));
  const bySheet = new Map<string, ParsedSheet>(sheets.map((s) => [s.sheet_name, s]));

  for (const [sheetName, productName] of Object.entries(SHEET_TO_PRODUCT)) {
    const parsed = bySheet.get(sheetName);
    if (!parsed) continue;
    const product = await db.freightProduct.findFirst({
      where: { contractId: CONTRACT_ID, name: productName },
      select: { id: true, sub_products: { select: { id: true } } },
    });
    if (!product) { console.log(`  ⚠ no FreightProduct "${productName}" — skip`); continue; }
    // Wipe + repopulate the bands; keep the SubProduct row (and its codes).
    const subId = product.sub_products[0]?.id;
    if (!subId) continue;
    await db.priceBand.deleteMany({ where: { subProductId: subId } });
    let bands = 0;
    for (const z of parsed.zones) {
      let order = 0;
      for (const b of z.bands) {
        await db.priceBand.create({
          data: {
            subProductId: subId, zone: z.zone, order: order++,
            weight_start: b.weight_start_g, weight_end: b.weight_end_g,
            price: b.price, per_kg: b.per_kg, step: b.step_kg,
          },
        });
        bands++;
      }
    }
    console.log(`  ✓ ${productName}  ${parsed.zones.length} zones, ${bands} bands`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

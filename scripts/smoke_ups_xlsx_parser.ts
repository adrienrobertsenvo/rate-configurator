// Sanity-check the deterministic UPS rate-card parser. Lists every sheet,
// product, and band count so we can compare against the LLM extraction.
import { readFileSync } from "node:fs";
import { parseUpsRateXlsx } from "../app/lib/carriers/ups/extract-rates-xlsx";

const sheets = parseUpsRateXlsx(readFileSync("/tmp/ups/contracts/INTERNAL_senvo_2026_UPS_General price list.xlsx"));
console.log(`Parsed ${sheets.length} rate sheets:`);
let totalBands = 0;
for (const s of sheets) {
  const bands = s.zones.reduce((acc, z) => acc + z.bands.length, 0);
  totalBands += bands;
  const zoneList = s.zones.map((z) => z.zone).join(", ");
  console.log(`  · ${s.sheet_name}  →  "${s.product_name}" (${s.movement})`);
  console.log(`      zones: ${s.zones.length}  bands: ${bands}`);
  console.log(`      [${zoneList}]`);
}
console.log(`\nTotal bands across all sheets: ${totalBands}`);

// Spot-check one sheet's first band per zone.
const sample = sheets.find((s) => s.sheet_name.includes("Standard Single") && s.movement === "Sending");
if (sample) {
  console.log(`\nSample first 3 bands per zone in "${sample.sheet_name}":`);
  for (const z of sample.zones) {
    console.log(`  ${z.zone}:`);
    for (const b of z.bands.slice(0, 3)) {
      console.log(`    ${b.weight_start_g}-${b.weight_end_g ?? "∞"}g  €${b.price ?? "—"} / per_kg=${b.per_kg ?? "—"}`);
    }
  }
}

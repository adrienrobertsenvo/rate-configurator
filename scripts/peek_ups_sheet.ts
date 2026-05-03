// Dump one sheet of the UPS General Price List as CSV so we can see the
// rate-card layout in full and design a deterministic parser.
import * as XLSX from "xlsx";
import { readFileSync, writeFileSync } from "node:fs";

const SHEET_NAME = process.argv[2] || "DE E-Standard Single";
const wb = XLSX.read(readFileSync("/tmp/ups/contracts/INTERNAL_senvo_2026_UPS_General price list.xlsx"), { type: "buffer" });
const ws = wb.Sheets[SHEET_NAME];
if (!ws) throw new Error(`No sheet "${SHEET_NAME}". Available: ${wb.SheetNames.join(", ")}`);
const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
const out = `/tmp/ups/sheet-${SHEET_NAME.replace(/\s+/g, "_")}.csv`;
writeFileSync(out, csv);
console.log(`Wrote ${out}`);
console.log(`First 50 rows:`);
const rows = csv.split("\n").slice(0, 50);
for (const [i, r] of rows.entries()) console.log(`  ${String(i + 1).padStart(2)}: ${r.slice(0, 200)}`);

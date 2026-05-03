// Inspect the structure of the UPS General Price List XLSX so we can see
// which sheets the extractor missed.
import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";

const wb = XLSX.read(readFileSync("/tmp/ups/contracts/INTERNAL_senvo_2026_UPS_General price list.xlsx"), { type: "buffer" });
console.log(`Sheets (${wb.SheetNames.length}):`);
for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false }) as unknown[][];
  const rows = data.length;
  const cols = Math.max(0, ...data.map((r) => r.length));
  // First non-empty cell of first 3 rows for a hint at content
  const preview = data.slice(0, 3).map((r) =>
    r.slice(0, 6).map((c) => (c == null ? "" : String(c).slice(0, 30))).join(" | ")
  ).join("\n     ");
  console.log(`\n  · "${name}"  (${rows}r × ${cols}c)\n     ${preview}`);
}

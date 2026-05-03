// One-shot helper: dump the UPS forwarding-data-dictionary XLS so we can read
// the column → meaning mapping for the invoice CSV parser. Run once at design
// time, no DB writes.
//
// Run: npx tsx scripts/peek_ups_dict.ts
import * as XLSX from "xlsx";
import { readFileSync, writeFileSync } from "node:fs";

const SRC = "/tmp/ups/docs-forwarding_data_dictionary.xls";
const OUT = "/tmp/ups/data-dictionary.txt";

const wb = XLSX.read(readFileSync(SRC), { type: "buffer" });
const out: string[] = [];
out.push(`Sheets in ${SRC}:`);
for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1:A1");
  const rows = (range.e.r - range.s.r + 1);
  out.push(`  ${name}  (${rows} rows)`);
}
out.push("");

// Dump every sheet as plain text so we can grep for column meanings.
for (const name of wb.SheetNames) {
  out.push("");
  out.push(`========== Sheet: ${name} ==========`);
  const ws = wb.Sheets[name];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false }) as unknown[][];
  for (const row of data) {
    const line = row.map((c) => (c == null ? "" : String(c).replace(/\s+/g, " ").trim())).join(" | ");
    if (line.replace(/\s|\|/g, "")) out.push(line);
  }
}

writeFileSync(OUT, out.join("\n"));
console.log(`Wrote ${OUT}  (${out.length} lines)`);

// Quick reader: dump sheet names + first few rows from a ContractSource XLSX.
// Used to locate the country-zone tab in Refurbed FR + everstox 2026 contracts.
//
// Run: npx tsx scripts/inspect_contract_xlsx.ts <contractId>
import * as XLSX from "xlsx";
import { db } from "../app/lib/db";

async function main() {
  const contractId = Number(process.argv[2]);
  if (!Number.isFinite(contractId)) throw new Error("usage: inspect_contract_xlsx.ts <contractId>");
  const sources = await db.contractSource.findMany({
    where: { contractId, kind: "xlsx" },
    select: { id: true, filename: true, bytes: true },
  });
  for (const s of sources) {
    if (!s.bytes) { console.log(`#${s.id} ${s.filename}: no bytes`); continue; }
    const buf = Buffer.from(s.bytes as Uint8Array);
    const wb = XLSX.read(buf, { type: "buffer" });
    console.log(`\n=== ContractSource #${s.id} · ${s.filename} ===`);
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1:A1");
      const rows = (range.e.r - range.s.r + 1);
      const cols = (range.e.c - range.s.c + 1);
      const data = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false }) as unknown[][];
      const preview = data.slice(0, 3).map((r) => r.slice(0, 8).map(String).join(" | ")).join("\n      ");
      console.log(`  · "${name}"  (${rows}r × ${cols}c)\n      ${preview}`);
    }
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

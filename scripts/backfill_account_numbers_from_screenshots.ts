// User-supplied account → contract mapping per the 2026-05-03 screenshots.
// Fills in account numbers we hadn't backfilled yet (the originals only had
// what was on already-stored invoices, which is incomplete).
//
// Run: npx tsx scripts/backfill_account_numbers_from_screenshots.ts

import { db } from "../app/lib/db";

interface Update { contractId: number; label: string; accounts: string[] }

const UPDATES: Update[] = [
  {
    contractId: 8,
    label: "Refurbed DHL Express Germany",
    accounts: ["145081054", "148194546"],
  },
  {
    contractId: 15,
    label: "everstox 2026 (v2)",
    accounts: [
      "143510453", "143830687", "143928065",
      "144551947", "144679418", "144799972",
      "144957752", "145506391", "145698870",
      "145778763", "145868639", "145920405",
      "146085880", "146285224", "146737006",
      "146848564", "146973415", "147353016",
      "147917515", "147990996", "148315949",
      "148426241", "148525832", "148542901",
      "148546284", "148594746", "148677513",
    ],
  },
];

async function main() {
  for (const u of UPDATES) {
    const cur = await db.contract.findUnique({ where: { id: u.contractId }, select: { name: true, account_numbers: true } });
    if (!cur) { console.log(`#${u.contractId}: not found, skip`); continue; }
    const existing: string[] = cur.account_numbers ? JSON.parse(cur.account_numbers) : [];
    const merged = Array.from(new Set([...existing, ...u.accounts])).sort();
    await db.contract.update({ where: { id: u.contractId }, data: { account_numbers: JSON.stringify(merged) } });
    const added = merged.filter((a) => !existing.includes(a));
    console.log(`#${u.contractId} ${u.label}: ${existing.length} → ${merged.length} accounts (+${added.length} new: ${added.join(", ")})`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

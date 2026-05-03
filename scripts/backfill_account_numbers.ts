// Read the original CSV stored on each Invoice, pull "Billing Account" (the
// numeric account, column 12 of row 2) and roll up the unique account numbers
// per contract → store as JSON in Contract.account_numbers. Idempotent.
//
// Run: npx tsx scripts/backfill_account_numbers.ts
import { db } from "../app/lib/db";

// Row 2 of every DHL invoice CSV is the "I" line. Columns (1-indexed):
//   1 Line Type, 2 Billing Source, 3 Original Invoice Number,
//   4 Invoice Number, 5 Station Code, 6 Invoice Identifier, 7 Invoice Type,
//   8 Invoice Date, 9 Payment Terms, 10 Due Date,
//   11 Parent Account, 12 Billing Account, 13 Billing Account Name, …
const ACCOUNT_RE = /^"[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","([^"]*)"/;

async function main() {
  const invoices = await db.invoice.findMany({
    where: { source_bytes: { not: null }, contractId: { not: null } },
    select: { id: true, contractId: true, source_bytes: true },
  });

  const byContract = new Map<number, Set<string>>();
  for (const inv of invoices) {
    if (!inv.source_bytes || !inv.contractId) continue;
    const text = Buffer.from(inv.source_bytes as Uint8Array).toString("utf8");
    const row2 = text.split(/\r?\n/, 2)[1];
    const m = ACCOUNT_RE.exec(row2 ?? "");
    const acct = (m?.[1] ?? "").trim();
    if (!acct) continue;
    let set = byContract.get(inv.contractId);
    if (!set) { set = new Set(); byContract.set(inv.contractId, set); }
    set.add(acct);
  }

  let updated = 0;
  for (const [contractId, accts] of byContract) {
    const sorted = Array.from(accts).sort();
    const json = JSON.stringify(sorted);
    const cur = await db.contract.findUnique({ where: { id: contractId }, select: { account_numbers: true, name: true } });
    if (cur?.account_numbers === json) continue;
    await db.contract.update({ where: { id: contractId }, data: { account_numbers: json } });
    console.log(`#${contractId}  ${cur?.name}  ← [${sorted.join(", ")}]`);
    updated++;
  }
  console.log(`\nupdated ${updated} contracts`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

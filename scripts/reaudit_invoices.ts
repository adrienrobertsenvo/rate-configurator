// Re-run the audit pipeline on a set of invoices. Useful after schema/zone
// changes so existing rows pick up the new lookups. Safe + idempotent.
//
// Run: npx tsx scripts/reaudit_invoices.ts <contractId>...
// Example: npx tsx scripts/reaudit_invoices.ts 9 10 11
import { db } from "../app/lib/db";
import { rerunAudit } from "../app/actions/invoice";

async function main() {
  const ids = process.argv.slice(2).map((x) => Number(x)).filter(Number.isFinite);
  if (ids.length === 0) { console.log("usage: reaudit_invoices.ts <contractId>..."); return; }
  const invoices = await db.invoice.findMany({
    where: { contractId: { in: ids } },
    select: { id: true, invoice_number: true, contractId: true },
  });
  console.log(`Re-auditing ${invoices.length} invoices across contracts ${ids.join(", ")}`);
  for (const inv of invoices) {
    try {
      await rerunAudit(inv.id);
      const stats = await db.invoiceLine.groupBy({
        by: ["audit_status"],
        _count: true,
        where: { invoiceId: inv.id },
      });
      const s = Object.fromEntries(stats.map((r) => [r.audit_status ?? "unresolved", r._count]));
      console.log(`  #${inv.id} ${inv.invoice_number} (contract #${inv.contractId})  ok=${s.ok ?? 0} over=${s.over ?? 0} under=${s.under ?? 0} unresolved=${s.unresolved ?? 0}`);
    } catch (e) {
      console.log(`  #${inv.id} FAILED: ${(e as Error).message}`);
    }
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

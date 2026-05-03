// Once the new 2026 contracts land (byrd #13, gocase #14, everstox 2026 = #15
// when extraction finishes), pin the old superseded contracts so the
// time-bound rate engine knows to use the newer one for shipments dated
// 2026-01-01 onwards. We just set valid_until = "2025-12-31" on the old ones.
//
// Run: npx tsx scripts/retire_old_contracts.ts
import { db } from "../app/lib/db";

// Map: old contract id → reason. We keep the row + invoices intact so historic
// audits remain readable; we just stop the engine from picking it for any 2026+
// shipment.
const TO_RETIRE: { id: number; reason: string; supersededBy: number | "auto" }[] = [
  { id: 4, reason: "everstox 2026 contract supersedes this", supersededBy: "auto" /* find #15+ named "everstox" */ },
  { id: 7, reason: "byrd 2026 contract supersedes this", supersededBy: 13 },
];

async function main() {
  const supersededByEverstox = await db.contract.findFirst({
    where: { name: { contains: "everstox" }, valid_from: { gte: "2026-01-01" }, id: { not: 4 } },
    orderBy: { id: "desc" },
    select: { id: true, name: true },
  });
  for (const r of TO_RETIRE) {
    const cur = await db.contract.findUnique({ where: { id: r.id }, select: { name: true, valid_from: true, valid_until: true } });
    if (!cur) { console.log(`#${r.id}: not found, skip`); continue; }
    let successor: { id: number; name: string } | null = null;
    if (r.supersededBy === "auto") successor = supersededByEverstox;
    else successor = await db.contract.findUnique({ where: { id: r.supersededBy }, select: { id: true, name: true } });
    if (!successor) {
      console.log(`#${r.id} ${cur.name}: successor not found yet (waiting on extraction?), skip`);
      continue;
    }
    if (cur.valid_until === "2025-12-31") { console.log(`#${r.id} ${cur.name}: already retired (valid_until=2025-12-31)`); continue; }
    await db.contract.update({ where: { id: r.id }, data: { valid_until: "2025-12-31" } });
    console.log(`#${r.id} ${cur.name}: valid_until ${cur.valid_until} → 2025-12-31  (superseded by #${successor.id} ${successor.name})`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

// Build a ZoneMap for UPS-DE by aggregating (dest_country, zone) pairs we
// see on real UPS invoice lines for everstox. Each country gets the MODE of
// the zones billed to it across all shipments — robust to occasional noise
// (e.g. an extended-area variant on one shipment).
//
// Three ZoneMaps emitted:
//   - ups-standard-export (covers products 011/003 sent from DE → intra-Europe)
//   - ups-express-export  (007/069 sent from DE → worldwide)
//   - ups-standard-import (011/003 received into DE)
//
// Why three? UPS uses different zone tables per product, unlike DHL. The
// Standard Single sheet has 8 zones (1, 3, 31, 4, 41, 5, 6, 704) while
// Express has 16 (1, 2, 3, 4, 41, 42, 5, 6, 7, 703, 8, 9, 10, 11, 12, 505,
// …). Splitting zone groups gives accurate audit lookup AND a clean view
// on the /zones page.
//
// Run: npx tsx scripts/derive_ups_zonemap_from_invoices.ts
import { db } from "../app/lib/db";

const CONTRACT_ID = 16;
const CARRIER = "UPS-DE";
const BILLING_COUNTRY = "DE";

interface Bucket {
  zoneGroup: string;
  description: string;
  productCodes: string[];           // route only shipments whose product is in this set
  direction: "export" | "import";   // origin == DE → export
}

const BUCKETS: Bucket[] = [
  { zoneGroup: "ups-standard-export", description: "UPS Standard Sending (011/003 from DE)", productCodes: ["011", "003"], direction: "export" },
  { zoneGroup: "ups-express-export",  description: "UPS Express Sending (007/069 from DE)",  productCodes: ["007", "069"], direction: "export" },
  { zoneGroup: "ups-standard-import", description: "UPS Standard Receiving (011/003 into DE)", productCodes: ["011", "003"], direction: "import" },
  { zoneGroup: "ups-express-import",  description: "UPS Express Receiving (007/069 into DE)", productCodes: ["007", "069"], direction: "import" },
];

async function main() {
  // Pull every UPS line that has both a dest_country AND a zone populated.
  const lines = await db.invoiceLine.findMany({
    where: {
      invoice: { contractId: CONTRACT_ID },
      dest_country: { not: null },
      product_code: { not: null },
      // SQLite Prisma doesn't have a direct way to filter on a derived field,
      // so we filter zone>"" in JS below.
    },
    select: { product_code: true, origin_country: true, dest_country: true, matched_zone: true,
              // matched_zone is what the engine resolved; fall back to nothing
              // if missing. Note: we can't read line.zone (parsed-only field)
              // — instead reconstruct it via the engine's matched_zone.
            },
  });

  // Aggregate per bucket.
  for (const b of BUCKETS) {
    // dest_country → zone → count
    const counts = new Map<string, Map<string, number>>();
    for (const l of lines) {
      const code = (l.product_code ?? "").toUpperCase();
      if (!b.productCodes.includes(code)) continue;
      const isImport = (l.origin_country ?? "").toUpperCase() !== BILLING_COUNTRY
        && (l.dest_country ?? "").toUpperCase() === BILLING_COUNTRY;
      if (b.direction === "export" && isImport) continue;
      if (b.direction === "import" && !isImport) continue;
      const country = (b.direction === "import" ? l.origin_country : l.dest_country)?.toUpperCase();
      const zone = l.matched_zone;
      if (!country || !zone) continue;
      let m = counts.get(country); if (!m) { m = new Map(); counts.set(country, m); }
      m.set(zone, (m.get(zone) ?? 0) + 1);
    }
    if (counts.size === 0) {
      console.log(`  (skip ${b.zoneGroup} — no lines)`);
      continue;
    }
    // Pick mode zone per country.
    const countryZones: { country: string; zone: number }[] = [];
    for (const [country, zoneCounts] of counts) {
      let bestZone = "", bestN = 0;
      for (const [z, n] of zoneCounts) if (n > bestN) { bestZone = z; bestN = n; }
      // Convert "Zone 4" → 4, "Zone 41" → 41, etc. ZoneMap.zone is an Int.
      const num = Number(bestZone.replace(/^zone\s*/i, "").replace(/\D/g, ""));
      if (Number.isFinite(num)) countryZones.push({ country, zone: num });
    }
    if (countryZones.length === 0) continue;

    // Upsert ZoneMap.
    const existing = await db.zoneMap.findFirst({
      where: { carrier: CARRIER, billing_country: BILLING_COUNTRY, zone_group: b.zoneGroup, contractId: null },
      select: { id: true },
    });
    let zoneMapId: number;
    if (existing) {
      await db.countryZone.deleteMany({ where: { zoneMapId: existing.id } });
      await db.zoneMap.update({
        where: { id: existing.id },
        data: { spec_name: `${CARRIER} ${b.zoneGroup} (derived from billings)`, valid_from: "2026-01-01", currency_code: "EUR" },
      });
      zoneMapId = existing.id;
    } else {
      const created = await db.zoneMap.create({
        data: { carrier: CARRIER, billing_country: BILLING_COUNTRY, zone_group: b.zoneGroup, contractId: null,
                spec_name: `${CARRIER} ${b.zoneGroup} (derived from billings)`, valid_from: "2026-01-01", currency_code: "EUR" },
        select: { id: true },
      });
      zoneMapId = created.id;
    }
    await db.countryZone.createMany({
      data: countryZones.map((cz) => ({ zoneMapId, country: cz.country, zone: cz.zone })),
    });
    const dist = new Map<number, number>();
    for (const cz of countryZones) dist.set(cz.zone, (dist.get(cz.zone) ?? 0) + 1);
    const distStr = [...dist].sort((a, b) => a[0] - b[0]).map(([z, n]) => `z${z}:${n}`).join(" ");
    console.log(`  ✓ ${b.zoneGroup}  →  ${countryZones.length} countries  (${distStr})`);
  }

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

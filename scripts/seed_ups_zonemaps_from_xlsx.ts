// Seed UPS-DE ZoneMaps directly from the contract's General Price List XLSX.
// Each rate sheet has German country names listed above the Zone header row;
// we parse those lists into ISO-2 codes and emit one ZoneMap per
// (product, direction).
//
// Run: npx tsx scripts/seed_ups_zonemaps_from_xlsx.ts
import { readFileSync } from "node:fs";
import { db } from "../app/lib/db";
import { parseUpsZonesXlsx } from "../app/lib/carriers/ups/extract-zones-xlsx";

const PRICE_LIST_PATH = "/tmp/ups/contracts/INTERNAL_senvo_2026_UPS_General price list.xlsx";

interface SheetMapping {
  sheet_name: string;
  zone_group: string;
  spec_name: string;
}

const MAPPINGS: SheetMapping[] = [
  { sheet_name: "DE E-Express",         zone_group: "ups-express-export",  spec_name: "UPS Express Sending (DE)" },
  { sheet_name: "DE E-Express Saver",   zone_group: "ups-saver-export",    spec_name: "UPS Express Saver Sending (DE)" },
  { sheet_name: "DE E-Standard Single", zone_group: "ups-standard-export", spec_name: "UPS Standard Sending (DE)" },
  { sheet_name: "DE I-Express",         zone_group: "ups-express-import",  spec_name: "UPS Express Receiving (DE)" },
  { sheet_name: "DE I-Express Saver",   zone_group: "ups-saver-import",    spec_name: "UPS Express Saver Receiving (DE)" },
  { sheet_name: "DE I-Standard Single", zone_group: "ups-standard-import", spec_name: "UPS Standard Receiving (DE)" },
];

async function main() {
  const sheets = parseUpsZonesXlsx(readFileSync(PRICE_LIST_PATH));
  const bySheet = new Map(sheets.map((s) => [s.sheet_name, s]));

  for (const m of MAPPINGS) {
    const parsed = bySheet.get(m.sheet_name);
    if (!parsed) { console.log(`  (skip ${m.sheet_name} — not parsed)`); continue; }

    // Convert "Zone 4" → 4. Drop labels that don't reduce to an integer
    // (e.g. lane-specific Zone 41, 31 stay as separate ints; Zone "Z703" is
    // also an int once we pull the digits).
    const seenCountryZone = new Map<string, number>();  // country → zone (mode preserved by first-write-wins after dedupe)
    for (const e of parsed.entries) {
      const num = Number(e.zone.replace(/^zone\s*/i, "").replace(/\D/g, ""));
      if (!Number.isFinite(num)) continue;
      // Same country can appear in multiple zone columns (different lanes).
      // Pick the LOWEST zone (cheapest tier) — typical UPS convention.
      if (!seenCountryZone.has(e.country) || num < (seenCountryZone.get(e.country) ?? Infinity)) {
        seenCountryZone.set(e.country, num);
      }
    }
    if (seenCountryZone.size === 0) continue;

    const existing = await db.zoneMap.findFirst({
      where: { carrier: "UPS-DE", billing_country: "DE", zone_group: m.zone_group, contractId: null },
      select: { id: true },
    });
    let zoneMapId: number;
    if (existing) {
      await db.countryZone.deleteMany({ where: { zoneMapId: existing.id } });
      await db.zoneMap.update({
        where: { id: existing.id },
        data: { spec_name: m.spec_name, valid_from: "2026-01-01", currency_code: "EUR" },
      });
      zoneMapId = existing.id;
    } else {
      const created = await db.zoneMap.create({
        data: {
          carrier: "UPS-DE", billing_country: "DE", zone_group: m.zone_group, contractId: null,
          spec_name: m.spec_name, valid_from: "2026-01-01", currency_code: "EUR",
        },
        select: { id: true },
      });
      zoneMapId = created.id;
    }
    await db.countryZone.createMany({
      data: [...seenCountryZone].map(([country, zone]) => ({ zoneMapId, country, zone })),
    });
    const dist = new Map<number, number>();
    for (const z of seenCountryZone.values()) dist.set(z, (dist.get(z) ?? 0) + 1);
    const distStr = [...dist].sort((a, b) => a[0] - b[0]).map(([z, n]) => `z${z}:${n}`).join(" ");
    console.log(`  ✓ ${m.zone_group}  ${seenCountryZone.size} countries  ${distStr}`);
    if (parsed.unrecognized.length) {
      console.log(`     ⚠ ${parsed.unrecognized.length} unrecognized cell(s) (ignored): ${parsed.unrecognized.slice(0, 6).join(", ")}${parsed.unrecognized.length > 6 ? "…" : ""}`);
    }
  }

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

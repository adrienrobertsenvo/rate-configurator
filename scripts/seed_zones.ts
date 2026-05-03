// Apply the 3 zone CSVs in prisma/seed-data/ as global (contractId=NULL)
// ZoneMaps. Pre-existing ZoneMaps with the same (carrier, billing_country,
// zone_group, contractId=NULL) get their countries replaced — this script is
// idempotent and re-runnable.
//
// Run: npx tsx scripts/seed_zones.ts
import { readFileSync } from "node:fs";
import { db } from "../app/lib/db";

interface Job {
  csv: string;
  carrier: string;
  billing_country: string;
  zone_group: string;
  spec_name: string;
  valid_from: string;
  currency_code: string;
}

const JOBS: Job[] = [
  {
    csv: "prisma/seed-data/zones-gb-worldwide.csv",
    carrier: "DHL-EXPRESS-GB",
    billing_country: "GB",
    zone_group: "worldwide",
    spec_name: "DHL-Express GB worldwide (atlanticbros 2025 baseline; sub-zones squashed to 9)",
    valid_from: "2025-01-01",
    currency_code: "GBP",
  },
  {
    csv: "prisma/seed-data/zones-fr-worldwide.csv",
    carrier: "DHL-EXPRESS-FR",
    billing_country: "FR",
    zone_group: "worldwide",
    spec_name: "DHL-Express FR worldwide (extracted from Refurbed FR contract XLSX)",
    valid_from: "2026-01-01",
    currency_code: "EUR",
  },
  {
    csv: "prisma/seed-data/zones-de-economy.csv",
    carrier: "DHL-EXPRESS-DE",
    billing_country: "DE",
    zone_group: "economy",
    spec_name: "DHL-Express DE economy (extracted from BA Logistics 2026 contract XLSX)",
    valid_from: "2026-01-01",
    currency_code: "EUR",
  },
];

interface CsvRow { country: string; iso: string; zone: number; note: string }

function parseCsv(text: string): CsvRow[] {
  const lines = text.trim().split(/\r?\n/);
  const out: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    // Naive split is fine here — our generator quotes any field containing a
    // comma, but none of the country names actually do.
    const cells = splitCsvLine(lines[i]);
    if (cells.length < 3) continue;
    const [country, iso, zoneStr, note] = cells;
    if (!iso || !zoneStr) continue;
    const zone = Number(zoneStr);
    if (!Number.isInteger(zone)) continue;
    out.push({ country: country.trim(), iso: iso.trim().toUpperCase(), zone, note: (note ?? "").trim() });
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuote = false; }
      else cur += ch;
    } else {
      if (ch === ",") { out.push(cur); cur = ""; }
      else if (ch === '"' && cur === "") inQuote = true;
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function applyJob(job: Job): Promise<void> {
  const text = readFileSync(job.csv, "utf8");
  const rows = parseCsv(text);
  console.log(`\n=== ${job.billing_country}/${job.zone_group} · ${rows.length} rows ===`);

  const existing = await db.zoneMap.findFirst({
    where: { carrier: job.carrier, billing_country: job.billing_country, zone_group: job.zone_group, contractId: null },
    select: { id: true, spec_name: true, _count: { select: { countries: true } } },
  });
  let zoneMapId: number;
  if (existing) {
    console.log(`  replacing existing #${existing.id} ("${existing.spec_name}", ${existing._count.countries} countries)`);
    await db.countryZone.deleteMany({ where: { zoneMapId: existing.id } });
    await db.zoneMap.update({
      where: { id: existing.id },
      data: { spec_name: job.spec_name, valid_from: job.valid_from, currency_code: job.currency_code },
    });
    zoneMapId = existing.id;
  } else {
    const created = await db.zoneMap.create({
      data: {
        carrier: job.carrier, billing_country: job.billing_country, zone_group: job.zone_group,
        contractId: null, spec_name: job.spec_name, valid_from: job.valid_from, currency_code: job.currency_code,
      },
      select: { id: true },
    });
    console.log(`  created new #${created.id}`);
    zoneMapId = created.id;
  }

  // De-dupe by ISO (CSV may contain duplicates from messy XLSX layouts).
  const byIso = new Map<string, number>();
  for (const r of rows) if (!byIso.has(r.iso)) byIso.set(r.iso, r.zone);
  await db.countryZone.createMany({
    data: Array.from(byIso).map(([country, zone]) => ({ zoneMapId, country, zone })),
  });
  const dist = new Map<number, number>();
  for (const z of byIso.values()) dist.set(z, (dist.get(z) ?? 0) + 1);
  const distStr = Array.from(dist).sort((a, b) => a[0] - b[0]).map(([z, n]) => `z${z}:${n}`).join(" ");
  console.log(`  ✓ wrote ${byIso.size} CountryZone rows (${distStr})`);
}

async function main() {
  for (const job of JOBS) {
    try { await applyJob(job); } catch (e) { console.error(`  ✗ ${job.csv}: ${(e as Error).message}`); }
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

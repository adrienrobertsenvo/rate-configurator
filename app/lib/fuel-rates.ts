// DHL Express Germany fuel surcharge rates, by effective date and fuel class.
// AIR  — applies to international Express (S, U, T, Y, P).
// ROAD — applies to Domestic Express (E) and Economy Select (V, N, W, H).
//
// Source: dhl.de fuel-surcharge pages, cross-validated against ~7k invoice lines.
// Rates are decimal (0.30 = 30%). Each entry takes effect on its `effective_from`
// date (inclusive) and stays in force until superseded by a later entry.
//
// IMPORTANT TIMING NOTE — this used to be keyed by ISO week (entries were
// "YYYY-Www" and we mapped via isoWeekFromDate at lookup time). Real billing
// data showed that DHL DOES NOT always switch on the Monday of the new ISO
// week: at month boundaries the new rate appears to apply from the 1st of the
// new month rather than the preceding Monday. Specifically: shipments dated
// 2026-03-30 / 2026-03-31 (Mon/Tue of W14) are billed at the W13 rate, and
// the new W14 rate only kicks in on Wed 2026-04-01. So the W14 entries below
// are dated 2026-04-01 instead of 2026-03-30. Other entries use the Monday of
// the relevant ISO week unless future evidence proves otherwise.
//
// If a future month-edge transition causes systematic "under" deltas around
// the 1st, shift the relevant entry's effective_from to the 1st of that month
// (this is documented as the "Apr 1 rule" on the Rules page).

export type FuelClass = "AIR" | "ROAD";

export interface FuelRateEntry {
  effective_from: string; // ISO date YYYY-MM-DD (inclusive). Used by lookupFuelRate.
  rate: number;
  // Human-readable label for the source ISO week — kept on every entry so
  // existing UI (Rules page, simulator) can still display "2026-W14" without
  // re-deriving it. When effective_from has been shifted (e.g. month-edge), the
  // iso_week still reflects the published week the rate is associated with.
  iso_week: string;
}

export const FUEL_RATES: Record<FuelClass, FuelRateEntry[]> = {
  AIR: [
    { effective_from: "2025-11-10", iso_week: "2025-W46", rate: 0.3000 },
    { effective_from: "2025-11-17", iso_week: "2025-W47", rate: 0.3000 },
    { effective_from: "2025-11-24", iso_week: "2025-W48", rate: 0.3000 },
    { effective_from: "2025-12-01", iso_week: "2025-W49", rate: 0.3150 },
    { effective_from: "2025-12-08", iso_week: "2025-W50", rate: 0.3150 },
    { effective_from: "2026-01-12", iso_week: "2026-W03", rate: 0.3000 },
    { effective_from: "2026-01-19", iso_week: "2026-W04", rate: 0.3000 },
    { effective_from: "2026-01-26", iso_week: "2026-W05", rate: 0.3000 },
    { effective_from: "2026-02-02", iso_week: "2026-W06", rate: 0.2875 },
    { effective_from: "2026-02-09", iso_week: "2026-W07", rate: 0.2875 },
    { effective_from: "2026-02-16", iso_week: "2026-W08", rate: 0.2875 },
    { effective_from: "2026-02-23", iso_week: "2026-W09", rate: 0.2875 },
    { effective_from: "2026-03-02", iso_week: "2026-W10", rate: 0.3050 },
    { effective_from: "2026-03-09", iso_week: "2026-W11", rate: 0.3050 },
    { effective_from: "2026-03-16", iso_week: "2026-W12", rate: 0.3050 },
    { effective_from: "2026-03-23", iso_week: "2026-W13", rate: 0.3050 },
    // Month-edge: W14 is Mon Mar 30, but billing data shows DHL applied the
    // new rate from Apr 1 only. Shifted to keep the audit honest.
    { effective_from: "2026-04-01", iso_week: "2026-W14", rate: 0.3900 },
    { effective_from: "2026-04-06", iso_week: "2026-W15", rate: 0.3900 },
    { effective_from: "2026-04-13", iso_week: "2026-W16", rate: 0.4600 },
    { effective_from: "2026-04-20", iso_week: "2026-W17", rate: 0.4775 },
    { effective_from: "2026-04-27", iso_week: "2026-W18", rate: 0.4800 },
    { effective_from: "2026-05-04", iso_week: "2026-W19", rate: 0.4700 },
    { effective_from: "2026-05-11", iso_week: "2026-W20", rate: 0.4675 },
  ],
  ROAD: [
    { effective_from: "2025-12-01", iso_week: "2025-W49", rate: 0.1925 },
    { effective_from: "2025-12-08", iso_week: "2025-W50", rate: 0.1925 },
    { effective_from: "2026-01-19", iso_week: "2026-W04", rate: 0.1825 },
    { effective_from: "2026-01-26", iso_week: "2026-W05", rate: 0.1825 },
    { effective_from: "2026-02-02", iso_week: "2026-W06", rate: 0.1675 },
    { effective_from: "2026-02-09", iso_week: "2026-W07", rate: 0.1675 },
    { effective_from: "2026-02-16", iso_week: "2026-W08", rate: 0.1675 },
    { effective_from: "2026-02-23", iso_week: "2026-W09", rate: 0.1675 },
    { effective_from: "2026-03-02", iso_week: "2026-W10", rate: 0.1800 },
    { effective_from: "2026-03-09", iso_week: "2026-W11", rate: 0.1800 },
    { effective_from: "2026-03-16", iso_week: "2026-W12", rate: 0.1800 },
    { effective_from: "2026-03-23", iso_week: "2026-W13", rate: 0.1825 },
    // Month-edge: see AIR W14 note above. Same shift.
    { effective_from: "2026-04-01", iso_week: "2026-W14", rate: 0.2750 },
    { effective_from: "2026-04-06", iso_week: "2026-W15", rate: 0.2750 },
    { effective_from: "2026-04-13", iso_week: "2026-W16", rate: 0.3450 },
    { effective_from: "2026-04-20", iso_week: "2026-W17", rate: 0.3650 },
    { effective_from: "2026-04-27", iso_week: "2026-W18", rate: 0.3675 },
    { effective_from: "2026-05-04", iso_week: "2026-W19", rate: 0.3525 },
    { effective_from: "2026-05-11", iso_week: "2026-W20", rate: 0.3450 },
  ],
};

function isoWeek(d: Date): string {
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(((target.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function isoWeekFromDate(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return isoWeek(d);
}

export function lookupFuelRate(klass: FuelClass, shipDate: string | Date): { rate: number; iso_week: string; effective_from: string } | null {
  // Compare on the ISO date string (YYYY-MM-DD). Works because lexicographic
  // sort on that format == chronological sort.
  const target = typeof shipDate === "string"
    ? shipDate.slice(0, 10)
    : shipDate.toISOString().slice(0, 10);
  const table = FUEL_RATES[klass];
  let best: FuelRateEntry | null = null;
  for (const entry of table) {
    if (entry.effective_from <= target) {
      if (!best || entry.effective_from > best.effective_from) best = entry;
    }
  }
  if (!best) return null;
  return { rate: best.rate, iso_week: best.iso_week ?? isoWeek(new Date(best.effective_from)), effective_from: best.effective_from };
}

export function fuelClassForProduct(productCode: string): FuelClass | null {
  const c = productCode.toUpperCase();
  if (c === "S" || c === "U" || c === "T" || c === "Y" || c === "P") return "AIR";
  // Economy Select Export (V/N) and Import (W/H) and Domestic (E) all use ROAD fuel.
  if (c === "E" || c === "V" || c === "N" || c === "W" || c === "H") return "ROAD";
  return null;
}

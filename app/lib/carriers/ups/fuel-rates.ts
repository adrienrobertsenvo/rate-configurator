// UPS Germany fuel surcharge rates. UPS calls the row "FSC" (Fuel Surcharge)
// in the billing CSV. Two service classes:
//   - AIR    — Worldwide Express, Express Saver, Express Plus, Express 12:00,
//              Worldwide Expedited, WW Economy DDU/DDP. Driven by US Gulf
//              Coast jet-fuel prices (2-week lag per UPS docs).
//   - GROUND — UPS Standard, Domestic Standard. Driven by EU Commission
//              Directorate General for Energy diesel prices, weekly.
//
// Like DHL (and per the calendar-month note we discovered for DHL fuel),
// rates may not change strictly on Monday. UPS publishes new rates weekly
// but the actual billed rate trails the published one slightly. So we key
// by `effective_from` (an ISO date), not ISO week.
//
// IMPORTANT: This file is seeded from the implied rates we backed out of
// real everstox billings (FSC / (WC + fuelable surcharges)) since the UPS
// public fuel-surcharge page wouldn't load via WebFetch. As more billings
// flow in, refine each entry to match the median observed rate. The
// scripts/derive_ups_fuel_rates.ts tool prints the per-month medians.

export type UpsFuelClass = "AIR" | "GROUND";

export interface UpsFuelRateEntry {
  effective_from: string; // ISO date (inclusive) — applies until superseded
  rate: number;           // decimal, e.g. 0.18 = 18%
  source: string;         // human-readable provenance for audit traceability
}

export const UPS_FUEL_RATES: Record<UpsFuelClass, UpsFuelRateEntry[]> = {
  // GROUND — Standard / Domestic Standard. Implied medians from billings:
  //   2025-12 → 17.65%, 2026-01 → 17.60%, 2026-02 → 18.01%, 2026-03 → 17.79%.
  // Stable around 17.5–18.0% in this window. Slot in the median as a single
  // ~3-month entry; refine if drift appears.
  GROUND: [
    { effective_from: "2025-12-01", rate: 0.1765, source: "median of everstox billings 2025-12" },
    { effective_from: "2026-01-01", rate: 0.1760, source: "median of everstox billings 2026-01" },
    { effective_from: "2026-02-01", rate: 0.1801, source: "median of everstox billings 2026-02" },
    { effective_from: "2026-03-01", rate: 0.1779, source: "median of everstox billings 2026-03" },
    { effective_from: "2026-04-01", rate: 0.1780, source: "extrapolation — confirm against Apr billings" },
  ],
  // AIR — Worldwide services. Sparse sample in everstox dataset (≤2 lines per
  // month) so these are placeholders. Update once we have more AIR billings.
  AIR: [
    { effective_from: "2025-12-01", rate: 0.2718, source: "1 sample, low confidence" },
    { effective_from: "2026-01-01", rate: 0.2423, source: "1 sample, low confidence" },
    { effective_from: "2026-02-01", rate: 0.2700, source: "extrapolation" },
    { effective_from: "2026-03-01", rate: 0.3300, source: "2 samples, mean of 32.88%" },
    { effective_from: "2026-04-01", rate: 0.3200, source: "extrapolation — confirm" },
  ],
};

export function lookupUpsFuelRate(klass: UpsFuelClass, shipDate: string | Date): { rate: number; effective_from: string; source: string } | null {
  const target = typeof shipDate === "string" ? shipDate.slice(0, 10) : shipDate.toISOString().slice(0, 10);
  const table = UPS_FUEL_RATES[klass];
  let best: UpsFuelRateEntry | null = null;
  for (const e of table) {
    if (e.effective_from <= target) {
      if (!best || e.effective_from > best.effective_from) best = e;
    }
  }
  return best ? { rate: best.rate, effective_from: best.effective_from, source: best.source } : null;
}

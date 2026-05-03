// UPS Germany fuel surcharge rates (PUBLISHED tariff). Each contract may
// negotiate a percent-off discount that the engine applies via
// `Contract.fuel_multiplier` (e.g. 0.80 for "20% off"). The audit therefore
// computes:
//
//   expected_FSC = base × published_rate × fuel_multiplier
//
// where base = freight charge + Σ fuelable accessorials, mirroring the DHL
// fuel formula. This split lets us put the same rate table in front of every
// customer and capture per-customer discounts in the Contract row.
//
// Two service classes per UPS:
//   GROUND — applies to UPS Standard / Dom. Standard. Indexed against EU
//            diesel prices (Oil Bulletin), updated Mondays. Includes a
//            Germany toll adjustment per the 3-Dec-2023 note in the source.
//   AIR    — applies to all Express services AND Expedited Service. Indexed
//            against US Gulf Coast jet fuel, updated Mondays. The published
//            page splits "within EU" vs "outside EU" but the rates are
//            identical in every row so one entry per week suffices.
//
// Source: UPS Germany Fuel Surcharge page (https://www.ups.com/de/en/support/
//         shipping-support/shipping-costs-rates/fuel-surcharges) saved to PDF
//         and read on 2026-05-03. Rolling 90-day history below; older rates
//         are placeholders we keep the engine from blowing up on shipments
//         dated before our published-history cutoff.

export type UpsFuelClass = "AIR" | "GROUND";

export interface UpsFuelRateEntry {
  effective_from: string; // ISO date (inclusive). Each Monday in UPS's table.
  rate: number;           // decimal, e.g. 0.2975 = 29.75%
  source: string;
}

// Each entry is published rate (PRE-discount). Per-contract discount applied
// in the engine via fuel_multiplier.
export const UPS_FUEL_RATES: Record<UpsFuelClass, UpsFuelRateEntry[]> = {
  // GROUND — UPS Standard, Dom. Standard (Treibstoffzuschlag Boden).
  // Older history (pre Feb 2026) is back-fitted from invoice-derived medians
  // since the public page only retains a rolling 90 days.
  GROUND: [
    // Pre-90-day history: best-effort placeholders. Refine when older
    // billings come in.
    { effective_from: "2025-12-01", rate: 0.2200, source: "extrapolated — pre-history" },
    { effective_from: "2026-01-01", rate: 0.2200, source: "extrapolated — pre-history" },
    // Published 90-day history (read 2026-05-03):
    { effective_from: "2026-02-09", rate: 0.2225, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-02-16", rate: 0.2250, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-02-23", rate: 0.2250, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-03-02", rate: 0.2200, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-03-09", rate: 0.2225, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-03-16", rate: 0.2275, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-03-23", rate: 0.2550, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-03-30", rate: 0.2875, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-04-06", rate: 0.2975, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-04-13", rate: 0.3000, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-04-20", rate: 0.3075, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-04-27", rate: 0.3075, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-05-04", rate: 0.2975, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
  ],
  // AIR — All Express + Expedited services.
  AIR: [
    { effective_from: "2025-12-01", rate: 0.3275, source: "extrapolated — pre-history" },
    { effective_from: "2026-01-01", rate: 0.3275, source: "extrapolated — pre-history" },
    { effective_from: "2026-02-09", rate: 0.3275, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-02-16", rate: 0.3225, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-02-23", rate: 0.3225, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-03-02", rate: 0.3400, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-03-09", rate: 0.3525, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-03-16", rate: 0.4050, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-03-23", rate: 0.4350, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-03-30", rate: 0.4825, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-04-06", rate: 0.4800, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-04-13", rate: 0.4850, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-04-20", rate: 0.4975, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-04-27", rate: 0.4800, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
    { effective_from: "2026-05-04", rate: 0.4975, source: "ups.com fuel surcharge page (PDF dated 2026-05-03)" },
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

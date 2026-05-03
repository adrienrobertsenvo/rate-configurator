// DHL Express Demand Surcharge ("NX" code) — externally-published rate that
// changes a few times per year. We mirror the published matrix here so audits
// can compare what DHL bills against what they say they should bill.
//
// Source: https://www.dhl.de/en/geschaeftskunden/express/produkte-und-services/zuschlaege.html#demand-surcharge
//
// Pricing model (per the published page):
//   • Time Definite International (TDI)  — €/kg billing weight, varies by O-D matrix
//   • Day Definite International  (DDI)  — flat €0.15/kg
//   • Domestic Time Definite      (DOM)  — flat €0.10/kg
//
// Each "schedule" entry is a closed interval [valid_from, valid_until] with the
// matrix in effect during that window. The lookup picks the one that contains
// the shipment's date. Outside any window → null (no demand surcharge expected).

import { type DemandRegion, regionFor } from "./region-map";

type ProductClass = "TDI" | "DDI" | "DOM";

interface DemandSchedule {
  valid_from: string;   // inclusive ISO date
  valid_until: string;  // inclusive ISO date
  source_url: string;
  notes?: string;
  // Matrix is partial. Missing cells default to FALLBACK below.
  tdi: Partial<Record<DemandRegion, Partial<Record<DemandRegion, number>>>>;
  ddi_flat_per_kg: number;
  dom_flat_per_kg: number;
}

// Some cells in the published matrix are blank ("—"). Real billing data shows
// DHL still applies a demand surcharge for those origin/dest pairs, defaulting
// to the same rate as same-region traffic. We capture that as a fallback the
// engine consults when a cell is missing.
const FALLBACK_TDI_PER_KG = 0.30;

const SCHEDULES: DemandSchedule[] = [
  {
    valid_from: "2025-10-01",
    valid_until: "2026-02-16",
    source_url: "https://www.dhl.de/en/geschaeftskunden/express/produkte-und-services/zuschlaege.html#demand-surcharge",
    notes: "Winter peak season schedule (Oct 2025 → Feb 16, 2026)",
    ddi_flat_per_kg: 0.15,
    dom_flat_per_kg: 0.10,
    tdi: {
      "CN-HK": { "CN-HK": 0.10, "ROA": 0.10, "OCE": 0.30, "EUR": 1.90, "AMS": 1.70, "MENA": 1.40, "ROW": 0.80 },
      "SAS":   { "CN-HK": 0.10, "ROA": 0.10, "OCE": 0.30, "EUR": 1.10, "AMS": 1.40, "MENA": 0.50, "ROW": 0.80 },
      "ROA":   { "CN-HK": 0.10, "ROA": 0.10, "OCE": 0.30, "EUR": 1.10, "AMS": 1.30, "MENA": 0.80, "ROW": 0.80 },
      "EUR":   {                              "OCE": 0.30, "EUR": 0.30, "AMS": 0.50,              "ROW": 0.80 },
      "AMS":   {                                                        "AMS": 0.30,              "ROW": 0.80 },
      "MENA":  {                              "OCE": 0.30, "EUR": 0.80, "AMS": 1.10, "MENA": 0.10, "ROW": 0.80 },
      "ROW":   { "CN-HK": 0.80, "SAS": 0.80, "ROA": 0.80, "OCE": 0.80, "EUR": 0.80, "AMS": 0.80, "MENA": 0.80, "ROW": 0.80 },
    },
  },
];

// Map a DHL product code to one of the three demand-surcharge classes:
//   TDI = Time Definite International (Express WW, Express 12:00, etc.)
//   DDI = Day Definite International  (Economy Select, Economy Breakbulk)
//   DOM = Domestic Time Definite      (any same-country shipment, regardless of code)
//
// Per real billing samples, same-country shipments are billed at the DOM flat
// rate even when the product is Economy. So we check origin==dest first.
export function demandClassForShipment(productCode: string | null | undefined, origin: string | null | undefined, dest: string | null | undefined): ProductClass {
  if (origin && dest && origin.toUpperCase() === dest.toUpperCase()) return "DOM";
  const code = (productCode ?? "").toUpperCase();
  // Economy products are day-definite international
  if (["E", "N", "H", "V", "W"].includes(code)) {
    // W and V are also used for Express Worldwide imports — but they're billed
    // as TDI not DDI. Distinguishing reliably from a single letter is hard;
    // callers that have product NAMES should use those instead. Since the
    // demand surcharge difference is small (€0.30 vs €0.15 for europe→europe)
    // we accept the ambiguity here and treat W/V as TDI to match the dominant
    // case on real invoices.
    if (code === "W" || code === "V") return "TDI";
    return "DDI";
  }
  return "TDI";
}

// Find the schedule active on `dateIso`. Returns null if none.
function pickSchedule(dateIso: string): DemandSchedule | null {
  for (const s of SCHEDULES) {
    if (dateIso >= s.valid_from && dateIso <= s.valid_until) return s;
  }
  return null;
}

// Look up the per-kg demand rate for a shipment. Returns null when:
//   • shipment date is outside any published schedule (no surcharge expected),
//   • inputs are incomplete.
export function demandRatePerKg(args: {
  shipment_date: string | null | undefined;
  product_code: string | null | undefined;
  origin_country: string | null | undefined;
  dest_country: string | null | undefined;
}): { rate: number; klass: ProductClass; origin_region: DemandRegion; dest_region: DemandRegion; source_url: string } | null {
  if (!args.shipment_date) return null;
  const sched = pickSchedule(args.shipment_date);
  if (!sched) return null;
  const klass = demandClassForShipment(args.product_code, args.origin_country, args.dest_country);
  if (klass === "DOM") {
    return { rate: sched.dom_flat_per_kg, klass, origin_region: "EUR", dest_region: "EUR", source_url: sched.source_url };
  }
  if (klass === "DDI") {
    const o = regionFor(args.origin_country);
    const d = regionFor(args.dest_country);
    return { rate: sched.ddi_flat_per_kg, klass, origin_region: o, dest_region: d, source_url: sched.source_url };
  }
  // TDI: matrix lookup. The published matrix collapses South Asia + Rest of
  // Asia into ONE destination column ("Asia"), but keeps them as DISTINCT
  // origin rows. So we canonicalize SAS → ROA on the destination side only.
  const o = regionFor(args.origin_country);
  const dRaw = regionFor(args.dest_country);
  const d: DemandRegion = dRaw === "SAS" ? "ROA" : dRaw;
  const cell = sched.tdi[o]?.[d];
  return { rate: cell ?? FALLBACK_TDI_PER_KG, klass, origin_region: o, dest_region: d, source_url: sched.source_url };
}

// For UI / debug: list all known schedules so the simulator/admin can preview
// upcoming or past windows.
export function allDemandSchedules(): DemandSchedule[] {
  return SCHEDULES;
}

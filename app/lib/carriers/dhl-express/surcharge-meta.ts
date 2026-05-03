// DHL Express Germany surcharge catalog with the metadata the pricing engine
// needs. `fuelable: true` means the surcharge is part of the base on which the
// fuel surcharge is computed — sourced from DHL's published list, cross-checked
// against ~7k invoice lines where the fit collapses to a single weekly rate
// once these (and only these) are summed with the weight charge.

export type SurchargeKind =
  | "flat"
  | "per_shipment"
  | "per_kg"
  | "percent"
  | "passthrough";

export interface SurchargeMeta {
  code: string;
  name: string;
  kind: SurchargeKind;
  fuelable: boolean;
  notes?: string;
}

export const SURCHARGES: SurchargeMeta[] = [
  // Fuel surcharge itself — calculated, not configured.
  { code: "FF", name: "Fuel Surcharge",                   kind: "percent",      fuelable: false, notes: "Computed by pricing engine, see fuel-rates.ts." },

  // Fuelable surcharges (per dhl.de road/air pages).
  { code: "NX", name: "Demand Surcharge",                  kind: "per_kg",       fuelable: true,  notes: "Peak / demand. Per-kg rate varies by season; flat per-shipment in some contracts." },
  { code: "OO", name: "Remote Area Delivery",              kind: "flat",         fuelable: true,  notes: "Flat €24 international, ~€3.90 domestic in BA Logistics 2026 contract." },
  { code: "YL", name: "Non-Conveyable Piece — Irregular",  kind: "flat",         fuelable: true,  notes: "Flat €20." },
  { code: "YO", name: "Non-Conveyable Piece — Weight",     kind: "flat",         fuelable: true,  notes: "Flat €20." },
  { code: "YB", name: "Oversize Piece",                    kind: "flat",         fuelable: true,  notes: "Flat €2 for Economy/Domestic in observed invoices." },
  { code: "CA", name: "Elevated Risk",                     kind: "flat",         fuelable: true,  notes: "Flat €30." },
  { code: "YK", name: "Premium 12:00",                     kind: "flat",         fuelable: true,  notes: "Flat €5; only on T product." },
  { code: "OB", name: "Remote Area Pickup",                kind: "flat",         fuelable: true,  notes: "Sibling of OO — same fuelable status, applies on pickup-side remote addresses." },
  { code: "YY", name: "Overweight Piece",                  kind: "flat",         fuelable: true,  notes: "Flat fee for pieces > 70 kg. Per DHL's published page this is part of the fuel base." },
  { code: "WP", name: "Restricted Destination",            kind: "flat",         fuelable: true,  notes: "Per dhl.de Restricted Destination list (sanctioned/permit-only countries). In fuel base." },

  // Non-fuelable surcharges.
  { code: "FD", name: "GoGreen Plus — Carbon Reduced",     kind: "per_kg",       fuelable: false, notes: "Optional, rate varies by destination/contract." },
  { code: "MA", name: "Address Correction",                kind: "flat",         fuelable: false, notes: "Flat €11." },
  { code: "RD", name: "Toll Surcharge",                    kind: "per_shipment", fuelable: false, notes: "Domestic only; small variable amount per shipment, not in fuel base." },

  // Z-product (Duties & Taxes invoice line) surcharges — pass-through, not on real shipments.
  { code: "XB", name: "Import Export Taxes",               kind: "passthrough",  fuelable: false, notes: "VAT/duty pass-through, not a real surcharge." },
  { code: "XX", name: "Import Export Duties",              kind: "passthrough",  fuelable: false },
  { code: "XK", name: "Regulatory Charges",                kind: "passthrough",  fuelable: false },
  { code: "XS", name: "Excise Tax",                        kind: "passthrough",  fuelable: false },
  { code: "XE", name: "Merchandise Process",               kind: "passthrough",  fuelable: false },
  { code: "DD", name: "Duty Tax Paid",                     kind: "flat",         fuelable: false, notes: "DTP processing fee, observed at €5 flat." },
];

export const SURCHARGE_BY_CODE = new Map(SURCHARGES.map((s) => [s.code, s]));

export function isFuelable(code: string): boolean {
  return SURCHARGE_BY_CODE.get(code)?.fuelable ?? false;
}

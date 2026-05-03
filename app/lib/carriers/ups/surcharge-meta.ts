// UPS surcharge catalog — code → name + audit metadata. Codes are 3-letter
// (vs DHL's 2-letter). The fuelable flag determines whether the surcharge is
// part of the FSC base (per UPS Service Guide; rough mapping for now,
// validated against contract docs in a follow-up pass).
//
// Cross-validated against everstox sample invoices: codes that actually appear
// have notes referencing observed real-world amounts and frequency.

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
  { code: "FSC", name: "Fuel Surcharge",                kind: "percent",      fuelable: false, notes: "Computed by pricing engine: rate × (FRT + fuelable accessorials). Latin-1 source: 'Treibstoffzuschl.'." },

  // Surcharges that are subject to fuel per UPS Service Guide.
  // (To be confirmed against the contract's Additional Services document; until
  // then we mark the major ones fuelable based on UPS's published convention.)
  { code: "RES", name: "Residential Delivery",          kind: "flat",         fuelable: true,  notes: "Per delivery to a residential address. Latin-1: 'Privatzustellung'." },
  { code: "PFR", name: "Surge Fee — Residential",       kind: "flat",         fuelable: true,  notes: "Peak/demand surcharge for residential deliveries. Latin-1: 'Surge Fee - Privatkunde'." },
  { code: "PFC", name: "Surge Fee — Commercial",        kind: "flat",         fuelable: true,  notes: "Peak/demand surcharge for commercial deliveries. Latin-1: 'Surge Fee - Firmenkunde'." },
  { code: "ESD", name: "Extended Area Surcharge — Delivery", kind: "flat",   fuelable: true,  notes: "Outlying delivery area. Latin-1: 'Aussengebiet Zuschlag - Zustellung'." },
  { code: "LTG", name: "Lithium Battery — Ground",      kind: "flat",         fuelable: true,  notes: "Dangerous goods handling for ground lithium battery shipments. Latin-1: 'DGoods Ground Lithium Batterie'." },
  { code: "PIF", name: "Prohibited Items Fee",          kind: "flat",         fuelable: true,  notes: "Charge for shipments flagged as prohibited goods. Latin-1: 'Gebühr für verbotene Güter'." },

  // Non-fuelable accessorials (admin / pickup / declared value).
  { code: "EVS", name: "Declared Value",                kind: "percent_of_value" as SurchargeKind, fuelable: false, notes: "Charged on shipments with a declared value above standard insurance. Latin-1: 'Deklarierter Wert'." },
  { code: "F/D", name: "Customs Duty/Tax Handling",     kind: "flat",         fuelable: false, notes: "UPS's brokerage / customs-clearance fee. Latin-1: 'Gebühr Zölle und Steuern'." },
  { code: "OSW", name: "Same-Day Pickup (Electronic)",  kind: "flat",         fuelable: false, notes: "Latin-1: 'Abholung gleicher Tag - elektr.'." },
  { code: "OFW", name: "Next-Day Pickup (Electronic)",  kind: "flat",         fuelable: false, notes: "Latin-1: 'Abholung nächster Tag - elektr.'." },
  { code: "CIS", name: "Paper Commercial Invoice",      kind: "flat",         fuelable: false, notes: "Latin-1: 'Zuschlag für Papier-Handelsrechnung'." },

  // MSC (Miscellaneous) — invoice-level fees, not per-shipment.
  { code: "DSC", name: "Daily Service Fee",             kind: "flat",         fuelable: false, notes: "Latin-1: 'Tägliche Servicepauschale'. Carried on invoice-level pseudo-shipment." },
  { code: "GWN", name: "Weekly Service Fee",            kind: "flat",         fuelable: false, notes: "Latin-1: 'Wöchentliche Servicepauschale'. Carried on invoice-level pseudo-shipment." },
  { code: "MSC", name: "Late Payment Fee",              kind: "flat",         fuelable: false, notes: "Latin-1: 'Säumnisgebühr ( 8.00%)'. 8% of overdue balance." },
];

export const SURCHARGE_BY_CODE = new Map(SURCHARGES.map((s) => [s.code, s]));

export function isFuelable(code: string): boolean {
  return SURCHARGE_BY_CODE.get(code)?.fuelable ?? false;
}

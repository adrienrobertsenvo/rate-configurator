// UPS audit engine — minimal first cut. Mirrors the DHL Express engine's
// public surface (computeLine, computeCustomsLine) but uses UPS-specific
// conventions for service codes, fuel base, and surcharge handling.
//
// FIRST-CUT SCOPE — what this version does and doesn't do:
//   ✓ Resolve product/service via UPS 3-digit code (069 = WW Express Saver,
//     011 = TB Standard, etc.). Look up matching FreightProduct/SubProduct.
//   ✓ Look up the rate band by zone + weight, same shape as DHL.
//   ✓ Verify net amount (col 53) against contract band — comparable to
//     DHL's weight-charge audit.
//   ✓ Pass surcharges through using a placeholder `unresolved` until each
//     code has a contract rule extracted.
//   ✗ Fuel surcharge audit — needs UPS fuel-rate publication scraped /
//     extracted from the contract. Returns "unresolved" for FSC for now so
//     audits don't false-flag fuel as wrong.
//   ✗ Cascade detection — implement once fuel is in.
//   ✗ Tax — UPS rolls VAT into the row stream as a TAX charge code. We pass
//     the value through and audit equality, no rate computation yet.
//
// Schema reuse: the snapshot shape (ContractSnapshot, Catalog, ZoneMaps,
// TaxTable, Band, EngineResult) is shared with DHL Express via the carrier
// abstraction in `app/lib/carriers/types.ts`.

import type { ParsedShipmentRow } from "../dhl-express/invoice-parse";
import type {
  ContractSnapshot,
  Catalog,
  ZoneMaps,
  TaxTable,
  EngineResult,
  Band,
  ExpectedSurcharge,
  AuditStatus,
  MatchedBand,
} from "../dhl-express/rate-engine";

const TOLERANCE_EUR = 0.05;

function classifyDelta(delta: number): AuditStatus {
  if (Math.abs(delta) <= TOLERANCE_EUR) return "ok";
  return delta > 0 ? "over" : "under";
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

// Map UPS service codes to a fuel class. UPS Air services use a different fuel
// rate than UPS Ground. International services (Worldwide Express*, Saver,
// Standard cross-border) typically use Air-equivalent rates.
//   003 — UPS Ground (domestic NA — but here used as "Dom. Standard" in DE)
//   011 — UPS Standard (TB Standard, ground intra-Europe)
//   069 — Worldwide Express Saver (Air)
//   021 — UPS Economy (cross-border economy)
//   017 — UPS WW Economy DDU
//   072 — UPS WW Economy DDP
export type UpsFuelClass = "AIR" | "GROUND";
export function fuelClassForUpsService(code: string): UpsFuelClass | null {
  if (!code) return null;
  const c = code.toUpperCase();
  if (c === "003" || c === "011") return "GROUND";
  // Treat all WW Express variants and Economy services as Air for fuel.
  if (["069", "070", "066", "072", "021", "017", "001", "007", "013", "014", "054"].includes(c)) return "AIR";
  return null;
}

// Type guards for the Band discriminated union — the type is either a fixed
// "tier" band ({weight_start, weight_end, price}) or an "extrapolation" band
// ({weight_start, per_kg, step?}). DHL's engine uses the same shape; we just
// have to narrow before accessing variant-only fields.
type FixedBand = Extract<Band, { price: number }>;
type PerKgBand = Extract<Band, { per_kg: number }>;
function isFixed(b: Band): b is FixedBand { return (b as FixedBand).price !== undefined; }
function isPerKg(b: Band): b is PerKgBand { return (b as PerKgBand).per_kg !== undefined; }

function findBand(bands: Band[], weightKg: number, shipDate: string | null): { band: Band; chargeable_kg: number } | null {
  if (!bands.length) return null;
  const candidates = shipDate
    ? bands.filter((b) =>
        (!b.valid_from || b.valid_from <= shipDate) &&
        (!b.valid_until || b.valid_until >= shipDate)
      )
    : bands;
  if (!candidates.length) return null;

  const grams = Math.max(0, Math.ceil(weightKg * 1000));
  const sorted = [...candidates].sort((a, b) => a.weight_start - b.weight_start);
  let chosen: Band | null = null;
  for (const b of sorted) {
    const end = isFixed(b) ? b.weight_end : null;
    if (b.weight_start <= grams && (end == null || grams <= end)) chosen = b;
  }
  if (!chosen) {
    // Fall through to the last per-kg extrapolation band when weight exceeds
    // the last fixed bracket. UPS rate cards typically end with such a band.
    const last = sorted[sorted.length - 1];
    if (last && isPerKg(last)) chosen = last;
  }
  if (!chosen) return null;
  const chargeable_kg = isFixed(chosen) ? chosen.weight_end / 1000 : weightKg;
  return { band: chosen, chargeable_kg };
}

export function computeUpsLine(
  line: ParsedShipmentRow,
  contract: ContractSnapshot,
  _catalog: Catalog,
  zoneMaps: ZoneMaps,
  _tax: TaxTable,
): EngineResult {
  const notes: string[] = [];
  const result: EngineResult = {
    matched_product: null,
    matched_sub_product: null,
    matched_zone: null,
    matched_band: null,
    expected_weight_charge: null,
    expected_surcharges: [],
    expected_tax: null,
    expected_total: null,
    delta: null,
    tax_delta: null,
    surcharge_delta: null,
    status: "unresolved",
    tax_status: "unresolved",
    surcharge_status: "unresolved",
    notes,
  };

  // Synthetic "INV" pseudo-shipment from invoice-level fees — pass through.
  if (line.product_code === "INV") {
    result.status = "passthrough";
    result.expected_total = line.charged_amount;
    result.delta = 0;
    notes.push("Invoice-level fees (MSC) — passed through, no contract audit.");
    return result;
  }

  const productCode = (line.product_code ?? "").toUpperCase();
  if (!productCode) {
    notes.push("No product/service code on shipment — cannot resolve rate band.");
    return result;
  }

  // Find the FreightProduct/SubProduct whose `codes` list includes this UPS
  // service code (e.g. "069" → "Worldwide Express Saver"). Same lookup pattern
  // as DHL but operating on UPS code strings.
  let matchedSub: { id: number; name: string; codes: string[]; zones: Record<string, Band[]> } | null = null;
  let matchedProduct: string | null = null;
  outer: for (const product of contract.freight) {
    for (const sub of product.sub_products) {
      if (sub.codes.includes(productCode) || sub.codes.includes(line.product_code ?? "")) {
        matchedSub = sub;
        matchedProduct = product.name;
        break outer;
      }
    }
  }

  if (!matchedSub) {
    notes.push(`No contract sub-product carries UPS service code '${productCode}'.`);
    // Pass surcharges through as unresolved so analytics still capture them.
    result.expected_surcharges = line.surcharges.map((s) => ({
      code: s.code, name: s.name, expected: 0, actual: s.charge, delta: 0, status: "unresolved" as AuditStatus,
    }));
    return result;
  }

  result.matched_product = matchedProduct;
  result.matched_sub_product = matchedSub.name;

  // Zone lookup. UPS uses the Zone column in the CSV directly when populated;
  // otherwise we'd derive it from origin/dest country via ZoneMap. Keep it
  // simple for now: if zone is empty on the parsed row, fall back to the
  // contract's default zone group.
  const productMeta = contract.freight.find((p) => p.name === matchedProduct);
  const zoneGroup = productMeta?.zone_group ?? "default";
  const zones = matchedSub.zones;
  // Build zone-key candidates. UPS pads zones with leading zeros on the wire
  // (e.g. "009", "01") while the contract may store them as "Zone 9" or just
  // "9". Try every reasonable spelling so the lookup succeeds regardless of
  // which side normalizes.
  const candidateZones: string[] = [];
  const lineZone = (line.zone ?? "").trim();
  if (lineZone) {
    candidateZones.push(lineZone);                          // raw, e.g. "009"
    const stripped = lineZone.replace(/^0+/, "") || "0";    // "9"
    candidateZones.push(stripped);
    candidateZones.push(`Zone ${stripped}`);                 // "Zone 9"
  }
  if (line.dest_country) {
    const map = zoneMaps.byGroup.get(zoneGroup);
    const z = map?.get(line.dest_country.toUpperCase());
    if (z != null) {
      candidateZones.push(String(z));
      candidateZones.push(`Zone ${z}`);
    }
  }
  let zoneKey: string | null = null;
  for (const candidate of candidateZones) {
    if (zones[candidate]?.length) { zoneKey = candidate; break; }
  }
  if (!zoneKey) {
    // No band coverage anywhere for any candidate. Surface the candidates we
    // tried so the audit_notes column points the operator at the right gap.
    notes.push(`No zone matched (tried: ${candidateZones.join(", ") || "—"}).`);
    result.expected_surcharges = line.surcharges.map((s) => ({
      code: s.code, name: s.name, expected: 0, actual: s.charge, delta: 0, status: "unresolved" as AuditStatus,
    }));
    return result;
  }
  if (!zoneKey) {
    notes.push(`No zone matched (tried: ${candidateZones.join(", ") || "—"}).`);
    return result;
  }
  result.matched_zone = zoneKey;

  if (line.weight_kg == null) {
    notes.push("No weight on shipment — cannot price freight charge.");
    return result;
  }

  const found = findBand(zones[zoneKey], line.weight_kg, line.shipment_date);
  if (!found) {
    notes.push(`No price band covers ${line.weight_kg}kg in zone ${zoneKey}.`);
    return result;
  }
  const { band, chargeable_kg } = found;
  const expected_wc = isFixed(band)
    ? band.price
    : roundCents(band.per_kg * (band.step ? Math.ceil(chargeable_kg / band.step) * band.step : chargeable_kg));

  result.expected_weight_charge = expected_wc;
  const matched: MatchedBand = {
    weight_start: band.weight_start,
    weight_end: isFixed(band) ? band.weight_end : null,
    price: isFixed(band) ? band.price : null,
    per_kg: isPerKg(band) ? band.per_kg : null,
    step: isPerKg(band) ? (band.step ?? null) : null,
    chargeable_kg,
  };
  result.matched_band = matched;

  // Pass surcharges + FSC through as unresolved for now — placeholder until
  // the surcharge meta and fuel rate logic are populated for UPS.
  const expectedSurcharges: ExpectedSurcharge[] = line.surcharges.map((s) => ({
    code: s.code, name: s.name, expected: 0, actual: s.charge, delta: 0, status: "unresolved" as AuditStatus,
  }));
  result.expected_surcharges = expectedSurcharges;

  const wcActual = line.weight_charge ?? 0;
  const wcDelta = roundCents(wcActual - expected_wc);
  const wcStatus: AuditStatus = classifyDelta(wcDelta);

  // Total expected = WC + surcharges (unresolved, but use actual for now so
  // delta isolates the WC error). When surcharges are wired up, this becomes
  // sum of expected.
  const surchargesActual = line.surcharges.reduce((acc, s) => acc + s.charge, 0);
  result.expected_total = roundCents(expected_wc + surchargesActual + (line.total_tax ?? 0));
  result.delta = roundCents((line.charged_amount ?? 0) - (result.expected_total ?? 0));
  result.surcharge_delta = 0;
  result.tax_delta = 0;
  result.surcharge_status = "unresolved";
  result.tax_status = "unresolved";

  // Line-level status: WC status dominates for now since surcharges/fuel/tax
  // are unresolved by design. Keeps the audit informative without false-flags.
  if (wcStatus === "ok") result.status = "ok";
  else result.status = wcStatus;

  if (wcStatus === "over") notes.push(`WC overcharged by €${wcDelta.toFixed(2)}`);
  else if (wcStatus === "under") notes.push(`WC undercharged by €${Math.abs(wcDelta).toFixed(2)}`);
  return result;
}

// UPS doesn't separate customs into its own invoice the way DHL does — its
// duty/tax handling comes through as F/D accessorials on the regular freight
// row. So computeUpsCustomsLine is a thin pass-through that routes back to
// computeUpsLine. The CarrierEngine interface still requires the method.
export function computeUpsCustomsLine(line: ParsedShipmentRow, _contract: ContractSnapshot): EngineResult {
  return {
    matched_product: null,
    matched_sub_product: null,
    matched_zone: null,
    matched_band: null,
    expected_weight_charge: null,
    expected_surcharges: line.surcharges.map((s) => ({
      code: s.code, name: s.name, expected: s.charge, actual: s.charge, delta: 0, status: "passthrough" as AuditStatus,
    })),
    expected_tax: line.total_tax,
    expected_total: line.charged_amount,
    delta: 0,
    tax_delta: 0,
    surcharge_delta: 0,
    status: "passthrough",
    tax_status: "passthrough",
    surcharge_status: "passthrough",
    notes: ["UPS doesn't have a separate customs invoice type — handled as F/D accessorial on freight rows."],
  };
}

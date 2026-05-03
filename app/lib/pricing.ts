// Pure pricing engine for the simulator. Given a contract snapshot and a
// shipment description, returns a stepped breakdown matching how DHL Express
// invoices actually compute totals.

import { fuelClassForProduct, lookupFuelRate, type FuelClass } from "./fuel-rates";
import { SURCHARGE_BY_CODE, isFuelable } from "./surcharge-meta";
import { resolveCountryCode } from "./country-aliases";
import type { Catalog, ContractSnapshot, ZoneMaps, TaxTable, MatchedBand, Band } from "./rate-engine";

export interface OptionalSurcharge {
  code: string;
  amount?: number; // override (otherwise contract amount is used)
}

export interface SimulateInput {
  contract: ContractSnapshot;
  catalog: Catalog;
  zoneMaps: ZoneMaps;
  tax: TaxTable;
  productCode: string;
  origin: string;       // ISO-2
  destination: string;  // ISO-2
  weight_kg: number;
  length_cm?: number;
  width_cm?: number;
  height_cm?: number;
  ship_date: string;    // ISO date "YYYY-MM-DD"
  declared_value?: number; // declared customs value, used by II Shipment Insurance
  optional_surcharges?: OptionalSurcharge[]; // codes the user toggled on (e.g. OO, CA, YK, MA, FD, RD…)
  tax_code?: string;    // override (otherwise inferred: domestic/EU = "A" 19%, intl export = "C" 0%)
  volumetric_divisor?: number; // default 5000
}

export type SimulateStep =
  | { kind: "weight"; actual_kg: number; volumetric_kg: number | null; chargeable_kg: number; flag: "A" | "V" | "B" }
  | { kind: "lookup"; product: string; sub_product: string; zone: string; band: MatchedBand }
  | { kind: "weight_charge"; amount: number }
  | { kind: "surcharge"; code: string; name: string; amount: number; fuelable: boolean; basis: string }
  | { kind: "fuel_base"; components: { label: string; amount: number }[]; total: number }
  | { kind: "fuel"; klass: FuelClass; iso_week: string; rate: number; base: number; amount: number }
  | { kind: "subtotal"; label: string; amount: number }
  | { kind: "tax"; code: string; rate: number; base: number; amount: number }
  | { kind: "total"; amount: number }
  | { kind: "warning"; message: string };

export interface SimulateResult {
  steps: SimulateStep[];
  weight_charge: number;
  fuelable_base: number;
  fuel_amount: number;
  total_excl_vat: number;
  tax_amount: number;
  total_incl_vat: number;
  fuel_class: FuelClass | null;
  iso_week: string | null;
  warnings: string[];
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

function priceFor(bands: Band[], weight_g: number): { price: number; band: MatchedBand } | null {
  for (const b of bands) {
    if ("price" in b) {
      const hit = (weight_g >= b.weight_start && weight_g < b.weight_end) || (weight_g === b.weight_end && b.weight_end > 0);
      if (hit) {
        return {
          price: b.price,
          band: { weight_start: b.weight_start, weight_end: b.weight_end, price: b.price, per_kg: null, step: null },
        };
      }
    }
  }
  const tails = bands.filter((b): b is Extract<Band, { per_kg: number }> => "per_kg" in b);
  tails.sort((a, b) => b.weight_start - a.weight_start);
  for (const t of tails) {
    if (weight_g >= t.weight_start) {
      if (t.step) {
        const chargeableKg = Math.ceil(weight_g / 1000 / t.step) * t.step;
        return {
          price: chargeableKg * t.per_kg,
          band: { weight_start: t.weight_start, weight_end: null, price: null, per_kg: t.per_kg, step: t.step, chargeable_kg: chargeableKg },
        };
      }
      const chargeableKg = weight_g / 1000;
      return {
        price: chargeableKg * t.per_kg,
        band: { weight_start: t.weight_start, weight_end: null, price: null, per_kg: t.per_kg, step: null, chargeable_kg: chargeableKg },
      };
    }
  }
  return null;
}

function inferTaxCode(billing_country: string, dest: string): string {
  // Pragmatic default: domestic shipments = local VAT; intl exports outside EU = zero-rated.
  // For Germany: A (19%) for DE→DE, C (0%) for non-EU export.
  // EU cross-border B2B is normally also zero-rated, but DHL invoices in our data show A for many EU lines —
  // probably because the carrier doesn't know the buyer's tax status. We default to A for EU and let user override.
  const bc = billing_country.toUpperCase();
  if (dest.toUpperCase() === bc) return "A";
  const eu = new Set([
    "AT","BE","BG","CY","CZ","DE","DK","EE","ES","FI","FR","GR","HR","HU","IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK"
  ]);
  if (eu.has(dest.toUpperCase())) return "A";
  return "C";
}

function amountForOptionalSurcharge(
  code: string,
  contractRule: { amount: number | null; kind: string; min_amount?: number | null } | undefined,
  override: number | undefined,
  weight_kg: number,
  declared_value: number,
): { amount: number; basis: string } | null {
  if (override != null) return { amount: roundCents(override), basis: `user-supplied €${override.toFixed(2)}` };
  if (!contractRule) {
    const meta = SURCHARGE_BY_CODE.get(code);
    if (!meta) return null;
    const def: Record<string, number> = { OO: 24, MA: 11, YL: 20, YO: 20, YB: 2, CA: 30, YK: 5, DD: 5 };
    if (def[code] != null) return { amount: def[code], basis: `default €${def[code].toFixed(2)} (no contract value, observed flat)` };
    return null;
  }
  const amt = contractRule.amount ?? 0;
  const min = contractRule.min_amount ?? null;
  switch (contractRule.kind) {
    case "flat":
    case "per_shipment":
      return { amount: roundCents(amt), basis: `flat €${amt.toFixed(2)}` };
    case "per_kg": {
      const computed = amt * weight_kg;
      if (min != null) {
        const final = Math.max(computed, min);
        return { amount: roundCents(final), basis: `max(€${amt.toFixed(2)}/kg × ${weight_kg.toFixed(2)} kg = €${computed.toFixed(2)}, min €${min.toFixed(2)})` };
      }
      return { amount: roundCents(computed), basis: `€${amt.toFixed(2)}/kg × ${weight_kg.toFixed(2)} kg` };
    }
    case "percent": {
      const rate = amt > 1 ? amt / 100 : amt;
      return { amount: roundCents(amt), basis: `${(rate * 100).toFixed(2)}% (flat representation)` };
    }
    case "percent_of_value": {
      if (declared_value <= 0) return { amount: min ?? 0, basis: `min €${(min ?? 0).toFixed(2)} (no declared value to compute %)` };
      const rate = amt > 1 ? amt / 100 : amt;
      const computed = declared_value * rate;
      if (min != null && computed < min) {
        return { amount: roundCents(min), basis: `${(rate * 100).toFixed(2)}% × €${declared_value.toFixed(2)} = €${computed.toFixed(2)} → min €${min.toFixed(2)}` };
      }
      return { amount: roundCents(computed), basis: `${(rate * 100).toFixed(2)}% × declared value €${declared_value.toFixed(2)}` };
    }
    default:
      return null;
  }
}

export function simulateShipment(input: SimulateInput): SimulateResult {
  const steps: SimulateStep[] = [];
  const warnings: string[] = [];
  const divisor = input.volumetric_divisor ?? 5000;

  // Step 1: chargeable weight
  let volumetric_kg: number | null = null;
  if (input.length_cm && input.width_cm && input.height_cm) {
    volumetric_kg = (input.length_cm * input.width_cm * input.height_cm) / divisor;
  }
  const chargeable_kg = Math.max(input.weight_kg, volumetric_kg ?? 0);
  const flag: "A" | "V" | "B" =
    volumetric_kg == null
      ? "A"
      : Math.abs(input.weight_kg - volumetric_kg) < 0.001
      ? "B"
      : volumetric_kg > input.weight_kg
      ? "V"
      : "A";
  steps.push({ kind: "weight", actual_kg: input.weight_kg, volumetric_kg, chargeable_kg, flag });

  // Step 2: catalog lookup
  const catalogEntries = input.catalog.entries.get(input.productCode);
  const direction = input.origin.toUpperCase() === input.contract.billing_country.toUpperCase() ? "export" : "any";
  const mapping = catalogEntries?.find((e) => e.direction === direction) ?? catalogEntries?.find((e) => e.direction === "any") ?? catalogEntries?.[0];
  if (!mapping) {
    warnings.push(`Unknown product code '${input.productCode}'`);
    steps.push({ kind: "warning", message: `No catalog entry for product code '${input.productCode}'` });
    return collect(steps, 0, 0, 0, 0, null, null, warnings);
  }
  const product = input.contract.freight.find((p) => p.name === mapping.product_name);
  const sub = product?.sub_products.find((s) => s.name === mapping.sub_product_name);
  if (!product || !sub) {
    warnings.push(`Contract is missing ${mapping.product_name} / ${mapping.sub_product_name}`);
    steps.push({ kind: "warning", message: `Contract has no rate table for ${mapping.product_name} → ${mapping.sub_product_name}` });
    return collect(steps, 0, 0, 0, 0, null, null, warnings);
  }
  const groupKey = product.zone_group || "default";
  const group = input.zoneMaps.byGroup.get(groupKey) ?? input.zoneMaps.byGroup.get("default");
  const zoneNum = group?.get(resolveCountryCode(input.destination)) ?? null;
  if (zoneNum == null) {
    warnings.push(`No zone for destination '${input.destination}'`);
    steps.push({ kind: "warning", message: `Destination '${input.destination}' is not in zone map '${groupKey}'` });
    return collect(steps, 0, 0, 0, 0, null, null, warnings);
  }
  const zoneKey = `Zone ${zoneNum}`;
  const bands = sub.zones[zoneKey] ?? [];
  const weight_g = Math.round(chargeable_kg * 1000);
  const priced = priceFor(bands, weight_g);
  if (!priced) {
    warnings.push(`No rate band covers ${chargeable_kg.toFixed(2)} kg in ${zoneKey}`);
    steps.push({ kind: "warning", message: `No band for ${chargeable_kg.toFixed(2)} kg in ${zoneKey}` });
    return collect(steps, 0, 0, 0, 0, null, null, warnings);
  }
  steps.push({ kind: "lookup", product: mapping.product_name, sub_product: mapping.sub_product_name, zone: zoneKey, band: priced.band });
  const weight_charge = roundCents(priced.price);
  steps.push({ kind: "weight_charge", amount: weight_charge });

  // Step 3: optional surcharges
  const ruleByCode = new Map(input.contract.surcharges.map((r) => [r.code, r]));
  const surchargeLines: { code: string; name: string; amount: number; fuelable: boolean }[] = [];
  for (const opt of input.optional_surcharges ?? []) {
    if (opt.code === "FF") continue; // computed
    const meta = SURCHARGE_BY_CODE.get(opt.code);
    const rule = ruleByCode.get(opt.code);
    const calc = amountForOptionalSurcharge(opt.code, rule, opt.amount, chargeable_kg, input.declared_value ?? 0);
    if (!calc) {
      warnings.push(`Cannot price surcharge '${opt.code}'`);
      continue;
    }
    const fuelable = meta?.fuelable ?? false;
    const name = meta?.name ?? rule?.name ?? opt.code;
    surchargeLines.push({ code: opt.code, name, amount: calc.amount, fuelable });
    steps.push({ kind: "surcharge", code: opt.code, name, amount: calc.amount, fuelable, basis: calc.basis });
  }

  // Step 4: fuel surcharge
  const klass = fuelClassForProduct(input.productCode);
  let fuel_amount = 0;
  let fuelable_base = weight_charge;
  let iso_week: string | null = null;
  if (klass) {
    const fuelable_components = surchargeLines.filter((s) => s.fuelable);
    fuelable_base = roundCents(weight_charge + fuelable_components.reduce((a, s) => a + s.amount, 0));
    const components = [
      { label: "Weight charge", amount: weight_charge },
      ...fuelable_components.map((s) => ({ label: `${s.code} ${s.name}`, amount: s.amount })),
    ];
    steps.push({ kind: "fuel_base", components, total: fuelable_base });
    const fuel = lookupFuelRate(klass, input.ship_date);
    if (!fuel) {
      warnings.push(`No fuel rate for ${klass} on ${input.ship_date}`);
      steps.push({ kind: "warning", message: `No fuel rate for ${klass} class on ${input.ship_date}` });
    } else {
      iso_week = fuel.iso_week;
      // Apply contract-level fuel multiplier (e.g. Refurbed 50% off → 0.5).
      const effectiveRate = fuel.rate * (input.contract.fuel_multiplier ?? 1);
      fuel_amount = roundCents(fuelable_base * effectiveRate);
      steps.push({ kind: "fuel", klass, iso_week: fuel.iso_week, rate: effectiveRate, base: fuelable_base, amount: fuel_amount });
    }
  } else {
    warnings.push(`Unknown fuel class for product '${input.productCode}' — fuel skipped`);
  }

  const surcharge_total = surchargeLines.reduce((a, s) => a + s.amount, 0);
  const total_excl_vat = roundCents(weight_charge + surcharge_total + fuel_amount);
  steps.push({ kind: "subtotal", label: "Total (excl. VAT)", amount: total_excl_vat });

  // Step 5: tax
  const tax_code = input.tax_code ?? inferTaxCode(input.contract.billing_country, input.destination);
  const tax_rate = input.tax.rateByCode.get(tax_code) ?? 0;
  const tax_amount = roundCents(total_excl_vat * tax_rate);
  steps.push({ kind: "tax", code: tax_code, rate: tax_rate, base: total_excl_vat, amount: tax_amount });

  const total_incl_vat = roundCents(total_excl_vat + tax_amount);
  steps.push({ kind: "total", amount: total_incl_vat });

  return collect(steps, weight_charge, fuelable_base, fuel_amount, total_excl_vat, klass, iso_week, warnings, tax_amount, total_incl_vat);
}

function collect(
  steps: SimulateStep[],
  weight_charge: number,
  fuelable_base: number,
  fuel_amount: number,
  total_excl_vat: number,
  klass: FuelClass | null,
  iso_week: string | null,
  warnings: string[],
  tax_amount = 0,
  total_incl_vat = 0,
): SimulateResult {
  return {
    steps,
    weight_charge,
    fuelable_base,
    fuel_amount,
    total_excl_vat,
    tax_amount,
    total_incl_vat,
    fuel_class: klass,
    iso_week,
    warnings,
  };
}

import type { ParsedShipmentRow } from "./invoice-parse";
import { fuelClassForProduct, lookupFuelRate } from "./fuel-rates";
import { isFuelable } from "./surcharge-meta";
import { resolveCountryCode } from "../../country-aliases";
import { demandRatePerKg } from "./demand-surcharge";

export interface ContractSnapshot {
  id: number;
  carrier: string;
  billing_country: string;
  // Multiplier applied to the published fuel rate. 1.0 = standard. Customers like
  // Refurbed have a "50% off prevailing fuel" clause → 0.5.
  fuel_multiplier: number;
  freight: {
    name: string;
    zone_group: string;
    sub_products: {
      id: number;
      name: string;
      codes: string[];
      zones: Record<string, Band[]>;
    }[];
  }[];
  surcharges: SurchargeRule[];
}

export interface SurchargeRule {
  code: string;
  name: string;
  kind: string;
  amount: number | null;
  // Optional per-kg minimum: expected = max(amount × weight, min_amount).
  min_amount?: number | null;
  // "any" | "domestic" | "international" — when multiple rules share a code,
  // the engine picks the one whose scope matches the line's product class.
  applies_to?: "any" | "domestic" | "international" | null;
}

// Bands gain optional validity dates so a single contract can carry multiple
// rate sets that take effect at different times (e.g. a "New Offer" replacing
// the published rate mid-year). NULL on either bound = unbounded on that side.
export type Band =
  | { weight_start: number; weight_end: number; price: number; valid_from?: string | null; valid_until?: string | null }
  | { weight_start: number; per_kg: number; step?: number | null; valid_from?: string | null; valid_until?: string | null };

export interface CatalogEntry {
  product_name: string;
  sub_product_name: string;
  direction: "export" | "import" | "any";
  // Non-empty = substring that must be present in the invoice's product_name
  // (case-insensitive) for this entry to match. Used for code H disambiguation.
  name_filter?: string;
}

export interface Catalog {
  entries: Map<string, CatalogEntry[]>;
  // Surcharge code → canonical name (from CatalogSurcharge). Used to bridge
  // invoice billing codes (e.g. "CA") to contract rules whose code may be a
  // placeholder ("UNK-Elevat") but whose name matches ("Elevated Risk").
  surchargeNames?: Map<string, string>;
}

export interface ZoneMaps {
  byGroup: Map<string, Map<string, number>>;
}

export interface TaxTable {
  rateByCode: Map<string, number>;
}

export type AuditStatus = "ok" | "over" | "under" | "cascade" | "passthrough" | "unresolved";

export interface ExpectedSurcharge {
  code: string;
  name: string;
  expected: number;
  actual: number;
  delta: number;
  status: AuditStatus;
}

export interface MatchedBand {
  weight_start: number;
  weight_end: number | null;
  price: number | null;
  per_kg: number | null;
  step: number | null;
  chargeable_kg?: number;
}

export interface EngineResult {
  expected_weight_charge: number | null;
  expected_total: number | null;
  expected_tax: number | null;
  expected_surcharges: ExpectedSurcharge[];
  delta: number | null;
  tax_delta: number | null;
  surcharge_delta: number | null;
  status: AuditStatus;
  tax_status: AuditStatus;
  surcharge_status: AuditStatus;
  notes: string[];
  matched_product: string | null;
  matched_sub_product: string | null;
  matched_zone: string | null;
  matched_band: MatchedBand | null;
}

const TOLERANCE_EUR = 0.05;

function resolveDirection(
  billing_country: string,
  origin: string | null,
  dest: string | null,
): "export" | "import" | "any" {
  const bc = billing_country.toUpperCase();
  if (origin && origin.toUpperCase() === bc) return "export";
  if (dest && dest.toUpperCase() === bc) return "import";
  return "any";
}

function pickCatalogEntry(
  entries: CatalogEntry[] | undefined,
  direction: "export" | "import" | "any",
  product_name?: string | null,
): CatalogEntry | undefined {
  if (!entries || entries.length === 0) return undefined;

  const nameNorm = product_name ? product_name.toLowerCase().replace(/\s+/g, " ").trim() : "";

  // Name-filtered entries take priority — try exact direction match first, then "any".
  if (nameNorm) {
    const namedExact = entries.find(
      (e) => e.name_filter && e.direction === direction && nameNorm.includes(e.name_filter.toLowerCase()),
    );
    if (namedExact) return namedExact;
    const namedAny = entries.find(
      (e) => e.name_filter && e.direction === "any" && nameNorm.includes(e.name_filter.toLowerCase()),
    );
    if (namedAny) return namedAny;
  }

  // Standard direction match on entries without a name_filter.
  const exact = entries.find((e) => !e.name_filter && e.direction === direction);
  if (exact) return exact;
  const any = entries.find((e) => !e.name_filter && e.direction === "any");
  if (any) return any;
  return entries.find((e) => !e.name_filter) ?? entries[0];
}

function classifyDelta(delta: number): AuditStatus {
  if (Math.abs(delta) <= TOLERANCE_EUR) return "ok";
  return delta > 0 ? "over" : "under";
}

// Codes that represent HMRC pass-throughs on UK Duty/VAT customs invoices —
// these aren't carrier-attributable, the audit just tags them as "passthrough".
const CUSTOMS_PASSTHROUGH_CODES = new Set(["XB", "XX", "XC", "XS", "XK", "XE"]);

// Codes treated as DHL admin fees on customs / Z-product passthrough lines.
// Context determines the meaning:
//   - WC on UK customs invoice = "Duty Tax Importer" (NOT Weight Charge)
//   - DD on a freight invoice's Z line = "Duty Tax Paid" (DE equivalent of WC)
//   - WD/WE = clearance / multiline admin fees
const CUSTOMS_ADMIN_CODES = new Set(["WC", "WD", "WE", "DD"]);

export function computeCustomsLine(
  line: ParsedShipmentRow,
  contract: ContractSnapshot,
): EngineResult {
  const notes: string[] = [];
  const result: EngineResult = {
    expected_weight_charge: null,
    expected_total: null,
    expected_tax: null,
    expected_surcharges: [],
    delta: null,
    tax_delta: null,
    surcharge_delta: null,
    status: "unresolved",
    tax_status: "unresolved",
    surcharge_status: "unresolved",
    notes,
    matched_product: null,
    matched_sub_product: null,
    matched_zone: null,
    matched_band: null,
  };

  // Sum of HMRC pass-throughs (XB Vat + XX Duty + XC Other levy …) — used as
  // the base for the "Duty Tax Importer" admin fee (typically 2.5% × this).
  const taxesBase = line.surcharges
    .filter((s) => CUSTOMS_PASSTHROUGH_CODES.has(s.code))
    .reduce((acc, s) => acc + s.charge, 0);

  // Resolve a contract rule by code; falls back to name match using the catalog
  // (same logic as the freight path, kept tight here).
  const ruleByCode = new Map<string, SurchargeRule[]>();
  const ruleByName = new Map<string, SurchargeRule>();
  for (const r of contract.surcharges) {
    if (!ruleByCode.has(r.code)) ruleByCode.set(r.code, []);
    ruleByCode.get(r.code)!.push(r);
    ruleByName.set(normalizeName(r.name), r);
  }

  const items: ExpectedSurcharge[] = [];
  for (const actual of line.surcharges) {
    const isPassthrough = CUSTOMS_PASSTHROUGH_CODES.has(actual.code);
    if (isPassthrough) {
      // HMRC duty / VAT / levy — not auditable, just record it.
      items.push({
        code: actual.code, name: actual.name,
        expected: actual.charge, actual: actual.charge, delta: 0,
        status: "passthrough",
      });
      continue;
    }

    // Admin fee path: WC / WD / WE — try contract rule by code, else by name.
    const candidates = ruleByCode.get(actual.code);
    const rule = candidates?.[0] ?? ruleByName.get(normalizeName(actual.name));
    if (!rule) {
      items.push({ code: actual.code, name: actual.name, expected: 0, actual: actual.charge, delta: actual.charge, status: "unresolved" });
      notes.push(`no contract rule for customs surcharge '${actual.code}'`);
      continue;
    }

    let expected: number | null = null;
    if (rule.kind === "percent_of_taxes") {
      // expected = max(rate × (XB + XX + XC), min_amount)
      // Used for "Duty Tax Importer" (DHL UK) and similar fees. amount is the
      // percentage (1 = 1%, 0.025 = 2.5%); min_amount is the floor.
      if (rule.amount != null && taxesBase > 0) {
        const rate = rule.amount > 1 ? rule.amount / 100 : rule.amount;
        const computed = taxesBase * rate;
        expected = rule.min_amount != null ? Math.max(computed, rule.min_amount) : computed;
      } else if (rule.min_amount != null) {
        expected = rule.min_amount;
      }
    } else {
      expected = expectedSurchargeAmount(rule, 0, line.weight_kg, line.declared_value);
    }

    if (expected == null) {
      items.push({ code: actual.code, name: rule.name, expected: 0, actual: actual.charge, delta: 0, status: "unresolved" });
      notes.push(`customs '${actual.code}': no amount configured`);
      continue;
    }
    const exp = roundCents(expected);
    const delta = roundCents(actual.charge - exp);
    items.push({ code: actual.code, name: rule.name, expected: exp, actual: actual.charge, delta, status: classifyDelta(delta) });
  }

  result.expected_surcharges = items;

  // Total = sum of expected (actual for passthroughs / unresolved).
  const expectedTotal = items.reduce(
    (acc, i) => acc + (i.status === "unresolved" ? i.actual : i.expected),
    0,
  );
  result.expected_total = roundCents(expectedTotal);

  if (line.charged_amount != null) {
    const delta = line.charged_amount - result.expected_total;
    result.delta = roundCents(delta);
    // Line status: pick the highest-priority verdict across the admin-fee rows
    // (passthroughs are noise here).
    const adminItems = items.filter((i) => CUSTOMS_ADMIN_CODES.has(i.code));
    const priority: AuditStatus[] = ["over", "under", "cascade", "unresolved", "ok"];
    let chosen: AuditStatus = "ok";
    for (const p of priority) {
      if (adminItems.some((i) => i.status === p)) { chosen = p; break; }
    }
    if (chosen === "ok" && Math.abs(result.delta) > TOLERANCE_EUR) {
      chosen = result.delta > 0 ? "over" : "under";
    }
    result.status = chosen;
    result.surcharge_status = chosen;
    result.surcharge_delta = roundCents(adminItems.reduce((a, i) => a + i.delta, 0));
    if (chosen === "over") notes.push(`customs admin fees overcharged by €${result.delta.toFixed(2)}`);
    else if (chosen === "under") notes.push(`customs admin fees undercharged by €${Math.abs(result.delta).toFixed(2)}`);
  }
  result.tax_status = "ok"; // VAT is not separately audited on customs invoices

  return result;
}

export function computeLine(
  line: ParsedShipmentRow,
  contract: ContractSnapshot,
  catalog: Catalog,
  zoneMaps: ZoneMaps,
  tax: TaxTable,
): EngineResult {
  // Z-product = "Duties & Taxes (pass-through)". Line has no weight/zone — it's
  // duty/VAT DHL paid on the shipper's behalf plus an admin fee (DD). Route it
  // through the customs path which handles passthroughs + admin-fee audit.
  if ((line.product_code ?? "").toUpperCase() === "Z") {
    return computeCustomsLine(line, contract);
  }
  const notes: string[] = [];
  const result: EngineResult = {
    expected_weight_charge: null,
    expected_total: null,
    expected_tax: null,
    expected_surcharges: [],
    delta: null,
    tax_delta: null,
    surcharge_delta: null,
    status: "unresolved",
    tax_status: "unresolved",
    surcharge_status: "unresolved",
    notes,
    matched_product: null,
    matched_sub_product: null,
    matched_zone: null,
    matched_band: null,
  };

  if (!line.product_code) {
    notes.push("line has no product code");
    return result;
  }
  if (!line.dest_country) {
    notes.push("line has no destination country");
    return result;
  }
  if (line.weight_kg == null) {
    notes.push("line has no weight");
    return result;
  }

  const direction = resolveDirection(contract.billing_country, line.origin_country, line.dest_country);
  const mapping = pickCatalogEntry(catalog.entries.get(line.product_code), direction, line.product_name);
  if (!mapping) {
    notes.push(`unknown product code '${line.product_code}'`);
    return result;
  }
  result.matched_product = mapping.product_name;
  result.matched_sub_product = mapping.sub_product_name;

  const product = contract.freight.find((p) => p.name === mapping.product_name);
  if (!product) {
    notes.push(`contract has no freight product '${mapping.product_name}'`);
    return result;
  }
  const sub = product.sub_products.find((s) => s.name === mapping.sub_product_name);
  if (!sub) {
    notes.push(`product '${mapping.product_name}' has no sub-product '${mapping.sub_product_name}'`);
    return result;
  }

  const groupKey = product.zone_group || "default";
  const group = zoneMaps.byGroup.get(groupKey) ?? zoneMaps.byGroup.get("default");
  if (!group) {
    notes.push(`no zone map for group '${groupKey}'`);
    return result;
  }
  // For import lines (X → DE on a DE-billed contract), the zone is determined by
  // where goods come FROM, not where they go to. For export/any lines we use
  // destination. The catalog entry's direction tells us which.
  const lookupCountry = mapping.direction === "import"
    ? (line.origin_country ?? line.dest_country)
    : (line.dest_country ?? line.origin_country);
  const zoneNum = group.get(resolveCountryCode(lookupCountry));
  if (zoneNum == null) {
    const where = mapping.direction === "import" ? "origin" : "destination";
    notes.push(`no zone mapping for ${where} '${lookupCountry}' in group '${groupKey}'`);
    return result;
  }
  const zoneKey = `Zone ${zoneNum}`;
  result.matched_zone = zoneKey;

  const bands = sub.zones[zoneKey] ?? [];
  if (bands.length === 0) {
    notes.push(`contract has no bands for ${mapping.sub_product_name} ${zoneKey}`);
    return result;
  }

  const weight_g = Math.round(line.weight_kg * 1000);
  // Filter bands by shipment-date validity so dual-rate-card contracts (e.g.
  // published vs "New Offer") pick the right set automatically.
  const eligibleBands = filterBandsByDate(bands, line.shipment_date);
  const priced = priceFor(eligibleBands, weight_g);
  if (priced == null) {
    notes.push(`no band covers weight ${line.weight_kg} kg (${weight_g} g) in ${zoneKey}`);
    return result;
  }
  result.expected_weight_charge = roundCents(priced.price);
  result.matched_band = priced.band;

  const surchargeCheck = verifySurcharges(
    line,
    contract.surcharges,
    result.expected_weight_charge,
    line.weight_kg,
    line.product_code,
    line.shipment_date,
    catalog,
    contract.fuel_multiplier ?? 1,
  );
  result.expected_surcharges = surchargeCheck.items;
  result.surcharge_status = surchargeCheck.status;
  result.surcharge_delta = roundCents(surchargeCheck.totalDelta);
  for (const n of surchargeCheck.notes) notes.push(n);

  // For the line-level expected total, fall back to the actual amount when a
  // surcharge rule isn't configured ("unresolved") so the rollup isn't
  // dominated by gaps in contract setup. The per-surcharge row still shows
  // unresolved on its own.
  const expectedSurchargeTotal = surchargeCheck.items.reduce(
    (acc, s) => acc + (s.status === "unresolved" ? s.actual : s.expected),
    0,
  );
  result.expected_total = roundCents(priced.price + expectedSurchargeTotal);

  if (line.charged_amount != null) {
    const delta = line.charged_amount - result.expected_total;
    result.delta = roundCents(delta);
    // Provisional status from total delta — the priority-based rule below
    // refines it using per-row statuses (so a WC-under line keeps its under
    // verdict even when downstream FF/VAT cascade).
    result.status = classifyDelta(delta);
  } else if (line.weight_charge != null) {
    const delta = line.weight_charge - result.expected_weight_charge;
    result.delta = roundCents(delta);
    result.status = classifyDelta(delta);
    notes.push("invoice amount missing — comparing weight-charge only");
  }

  if (line.tax_code) {
    const rate = tax.rateByCode.get(line.tax_code);
    if (rate == null) {
      notes.push(`unknown tax code '${line.tax_code}'`);
    } else if (result.expected_total != null) {
      result.expected_tax = roundCents(result.expected_total * rate);
      if (line.total_tax != null) {
        const td = line.total_tax - result.expected_tax;
        result.tax_delta = roundCents(td);
        let taxStatus: AuditStatus = classifyDelta(td);

        // VAT cascade: if the carrier applied the right tax rate to their (wrong)
        // total, the VAT delta is fully downstream of an upstream error.
        if (taxStatus !== "ok" && line.charged_amount != null && line.charged_amount > 0) {
          const carrierImpliedTaxRate = line.total_tax / line.charged_amount;
          const taxRateMatches = Math.abs(carrierImpliedTaxRate - rate) < 0.005;
          const totalDeltaSig =
            result.expected_total != null && Math.abs(line.charged_amount - result.expected_total) > TOLERANCE_EUR;
          if (taxRateMatches && totalDeltaSig) {
            taxStatus = "cascade";
            notes.push(`VAT: rate ${(rate * 100).toFixed(0)}% applied correctly, but total was wrong upstream`);
          }
        }
        result.tax_status = taxStatus;
        if (taxStatus === "over") notes.push(`VAT overcharged by €${td.toFixed(2)}`);
        else if (taxStatus === "under") notes.push(`VAT undercharged by €${Math.abs(td).toFixed(2)}`);
      }
    }
  }

  // Line-level status: pick the highest-priority status across WC + every
  // surcharge row + tax. Genuine over/under always wins over cascade.
  if (result.delta != null) {
    const wcStatus: AuditStatus = (() => {
      if (result.expected_weight_charge == null || line.weight_charge == null) return "unresolved";
      const d = line.weight_charge - result.expected_weight_charge;
      return classifyDelta(d);
    })();
    const rowStatuses: AuditStatus[] = [wcStatus, ...result.expected_surcharges.map((i) => i.status), result.tax_status];
    const priority: AuditStatus[] = ["over", "under", "cascade", "unresolved", "ok"];
    let chosen: AuditStatus = "ok";
    for (const p of priority) {
      if (rowStatuses.includes(p)) { chosen = p; break; }
    }
    // If everything is ok per row but the total has a delta, still mark ok-tolerant.
    if (chosen === "ok" && Math.abs(result.delta) > TOLERANCE_EUR) {
      chosen = result.delta > 0 ? "over" : "under";
    }
    result.status = chosen;
    if (chosen === "over") notes.push(`invoice overcharged by €${result.delta.toFixed(2)}`);
    else if (chosen === "under") notes.push(`invoice undercharged by €${Math.abs(result.delta).toFixed(2)}`);
    else if (chosen === "cascade") notes.push(`invoice off by €${result.delta.toFixed(2)} due to upstream cascade`);
  }

  return result;
}

function verifySurcharges(
  line: ParsedShipmentRow,
  rules: SurchargeRule[],
  expectedWeightCharge: number,
  weightKg: number | null,
  productCode: string | null,
  shipDate: string | null,
  catalog?: Catalog,
  fuelMultiplier: number = 1,
): { items: ExpectedSurcharge[]; totalDelta: number; status: AuditStatus; notes: string[] } {
  const notes: string[] = [];
  // Group rules by code so multiple OO/etc rows can be scope-filtered, plus a
  // name index for the catalog/name fallback.
  const rulesByCode = new Map<string, SurchargeRule[]>();
  const ruleByName = new Map<string, SurchargeRule>();
  for (const r of rules) {
    if (!rulesByCode.has(r.code)) rulesByCode.set(r.code, []);
    rulesByCode.get(r.code)!.push(r);
    ruleByName.set(normalizeName(r.name), r);
  }

  // Resolve a contract rule for an invoice surcharge. Tries (1) exact code
  // match (with scope filter), then (2) catalog: invoice code → canonical
  // name → rule by name, then (3) direct name match. Step (2) handles
  // contracts where extraction produced placeholder codes like "UNK-Elevat"
  // but the human name on the rule is "Elevated Risk" (canonical for "CA").
  function resolveRule(actualCode: string, actualName: string): SurchargeRule | undefined {
    const byCode = rulesByCode.get(actualCode);
    if (byCode) return pickRuleByScope(byCode, productCode);
    const canonicalName = catalog?.surchargeNames?.get(actualCode);
    if (canonicalName) {
      const byCanonical = ruleByName.get(normalizeName(canonicalName));
      if (byCanonical) return byCanonical;
    }
    return ruleByName.get(normalizeName(actualName));
  }

  const items: ExpectedSurcharge[] = [];

  // Pass 1: price every surcharge except FF (fuel) — fuel needs the others first.
  for (const actual of line.surcharges) {
    if (actual.code === "FF") continue;
    const rule = resolveRule(actual.code, actual.name);

    // Demand Surcharge (NX) — the rate is published externally and changes
    // every few months, so the engine looks it up regardless of what the
    // contract has. Two scenarios:
    //   (a) contract has rule.kind === "external_demand" — explicit opt-in
    //   (b) contract has NO rule for NX — we still rate it from the public
    //       schedule and add a note so the auditor knows the source.
    // The contract row's per-kg amount (if any) is ignored for both cases.
    if (actual.code === "NX" && (!rule || rule.kind === "external_demand")) {
      const lookup = demandRatePerKg({
        shipment_date: line.shipment_date,
        product_code: line.product_code,
        origin_country: line.origin_country,
        dest_country: line.dest_country,
      });
      if (!lookup || weightKg == null) {
        items.push({ code: "NX", name: rule?.name ?? actual.name, expected: 0, actual: actual.charge, delta: 0, status: "unresolved" });
        notes.push(`NX: no published demand rate for ${line.shipment_date ?? "?"} (or weight unknown)`);
        continue;
      }
      const expected = roundCents(lookup.rate * weightKg);
      const delta = roundCents(actual.charge - expected);
      items.push({ code: "NX", name: rule?.name ?? actual.name, expected, actual: actual.charge, delta, status: classifyDelta(delta) });
      if (!rule) notes.push(`NX: rated from public schedule (no contract rule) — ${lookup.klass} ${lookup.origin_region}→${lookup.dest_region} @ €${lookup.rate}/kg`);
      continue;
    }

    if (!rule) {
      items.push({
        code: actual.code, name: actual.name,
        expected: 0, actual: actual.charge, delta: actual.charge,
        status: "unresolved",
      });
      notes.push(`no contract rule for surcharge '${actual.code}'`);
      continue;
    }
    const expected = expectedSurchargeAmount(rule, expectedWeightCharge, weightKg, line.declared_value);
    if (expected == null) {
      items.push({ code: actual.code, name: rule.name, expected: 0, actual: actual.charge, delta: 0, status: "unresolved" });
      notes.push(`surcharge '${actual.code}' has no amount configured`);
      continue;
    }
    const rounded = roundCents(expected);
    const delta = roundCents(actual.charge - rounded);
    items.push({ code: actual.code, name: rule.name, expected: rounded, actual: actual.charge, delta, status: classifyDelta(delta) });
  }

  // Pass 2: fuel surcharge — pct × (expected_wc + Σ fuelable surcharges).
  // For the fuel base we use ACTUAL amounts of the other fuelable surcharges so
  // that gaps in contract-rule configuration don't cascade into a false FF
  // delta. A sub-surcharge that's wrong still shows up on its own row.
  const ffActual = line.surcharges.find((s) => s.code === "FF");
  if (ffActual) {
    const fuelableActual = line.surcharges
      .filter((s) => isFuelable(s.code))
      .reduce((acc, s) => acc + s.charge, 0);
    const base = roundCents(expectedWeightCharge + fuelableActual);
    const klass = productCode ? fuelClassForProduct(productCode) : null;
    const fuel = klass && shipDate ? lookupFuelRate(klass, shipDate) : null;
    if (!klass) {
      items.push({ code: "FF", name: ffActual.name, expected: 0, actual: ffActual.charge, delta: 0, status: "unresolved" });
      notes.push(`FF: cannot classify product '${productCode ?? "?"}' as AIR or ROAD`);
    } else if (!fuel) {
      items.push({ code: "FF", name: ffActual.name, expected: 0, actual: ffActual.charge, delta: 0, status: "unresolved" });
      notes.push(`FF: no fuel rate for ${klass} on ${shipDate}`);
    } else {
      // Apply the contract-level fuel multiplier (e.g. Refurbed = 0.5 → 50% off).
      const effectiveRate = fuel.rate * fuelMultiplier;
      const expected = roundCents(base * effectiveRate);
      const delta = roundCents(ffActual.charge - expected);
      let status = classifyDelta(delta);

      // Cascade detection: if the carrier applied the right effective rate to
      // their (wrong) base, FF's delta is purely an artifact of an upstream
      // error (typically Weight Charge). Flag it as "cascade" rather than
      // over/under so genuine fuel-rate audit failures stand out.
      const wcDelta = (line.weight_charge ?? 0) - expectedWeightCharge;
      const wcOff = Math.abs(wcDelta) > TOLERANCE_EUR;
      const carrierBase = (line.weight_charge ?? 0) + fuelableActual;
      const carrierImpliedRate = carrierBase > 0 ? ffActual.charge / carrierBase : null;
      const rateMatchesPublished =
        carrierImpliedRate != null && Math.abs(carrierImpliedRate - effectiveRate) < 0.005; // ±0.5pp
      if (status !== "ok" && wcOff && rateMatchesPublished) {
        status = "cascade";
        notes.push(`FF: rate ${(effectiveRate * 100).toFixed(2)}% applied correctly, but base was wrong upstream`);
      }

      items.push({ code: "FF", name: ffActual.name, expected, actual: ffActual.charge, delta, status });
    }
  }

  // Per-line notes for items that ended up over/under.
  for (const i of items) {
    if (i.status === "over") notes.push(`${i.code} overcharged by €${i.delta.toFixed(2)}`);
    else if (i.status === "under") notes.push(`${i.code} undercharged by €${Math.abs(i.delta).toFixed(2)}`);
  }

  const totalDelta = items.reduce((acc, i) => acc + i.delta, 0);

  let status: AuditStatus;
  if (items.length === 0) status = "ok";
  else if (items.some((i) => i.status === "unresolved")) status = "unresolved";
  else if (Math.abs(totalDelta) <= TOLERANCE_EUR) status = "ok";
  else status = totalDelta > 0 ? "over" : "under";

  return { items, totalDelta: roundCents(totalDelta), status, notes };
}

function expectedSurchargeAmount(
  rule: SurchargeRule,
  weightCharge: number,
  weightKg: number | null,
  declaredValue: number | null = null,
): number | null {
  switch (rule.kind) {
    case "flat":
    case "per_shipment":
      return rule.amount ?? null;
    case "per_kg": {
      if (rule.amount == null || weightKg == null) return null;
      const computed = rule.amount * weightKg;
      if (rule.min_amount != null) return Math.max(computed, rule.min_amount);
      return computed;
    }
    case "percent":
      if (rule.amount == null) return null;
      return weightCharge * (rule.amount > 1 ? rule.amount / 100 : rule.amount);
    case "percent_of_value": {
      if (rule.amount == null || declaredValue == null) return null;
      const pct = rule.amount > 1 ? rule.amount / 100 : rule.amount;
      const computed = declaredValue * pct;
      if (rule.min_amount != null) return Math.max(computed, rule.min_amount);
      return computed;
    }
    case "percent_of_taxes":
      // Computed inline by computeCustomsLine — needs the line's pass-through
      // taxes base which isn't visible here. Returning null falls back to
      // unresolved on the freight path (where this kind shouldn't appear).
      return null;
    default:
      return null;
  }
}

function lineProductClass(productCode: string | null): "domestic" | "international" | null {
  if (!productCode) return null;
  const c = productCode.toUpperCase();
  if (c === "E") return "domestic";
  if (c === "S" || c === "U" || c === "T" || c === "Y" || c === "V" || c === "N") return "international";
  return null;
}

// When several contract rules share a billing code (e.g. multiple "OO" Remote
// Area rows for domestic vs international), pick the one whose scope matches
// the line's product class. Specific scopes ("domestic"/"international") win
// over "any"; if no rule matches, return null and let the upstream resolver
// fall back to name lookup.
function pickRuleByScope(rules: SurchargeRule[], productCode: string | null): SurchargeRule | undefined {
  if (rules.length === 0) return undefined;
  if (rules.length === 1) return rules[0];
  const klass = lineProductClass(productCode);
  if (klass) {
    const exact = rules.find((r) => r.applies_to === klass);
    if (exact) return exact;
  }
  return rules.find((r) => !r.applies_to || r.applies_to === "any") ?? rules[0];
}

// Drop bands that aren't valid on the shipment date. A band with no validity
// dates always passes (it inherits the contract's validity). When a date is
// set, the shipment_date must fall in [valid_from, valid_until] inclusive.
// If multiple bands cover the same (zone, weight) range and pass the date
// filter, the one with the most specific (non-null) valid_from wins — newer,
// more-specific overrides older defaults.
export function filterBandsByDate(bands: Band[], shipDate: string | null): Band[] {
  const date = shipDate ? shipDate.slice(0, 10) : null;
  const passes = bands.filter((b) => {
    if (b.valid_from && date && date < b.valid_from) return false;
    if (b.valid_until && date && date > b.valid_until) return false;
    return true;
  });
  // Specificity sort: bands with valid_from set come BEFORE those without, so
  // priceFor's first-match-wins semantics naturally pick the newer override.
  return passes.sort((a, b) => {
    const aHas = a.valid_from ? 1 : 0;
    const bHas = b.valid_from ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas; // dated first
    return 0;
  });
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

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

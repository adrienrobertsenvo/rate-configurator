"use server";

import { db } from "../lib/db";
import { simulateShipment, type SimulateInput, type SimulateResult } from "../lib/carriers/dhl-express/pricing";
import type { Band, ContractSnapshot, Catalog, ZoneMaps, TaxTable, CatalogEntry } from "../lib/carriers/dhl-express/rate-engine";

async function loadEngineInputs(contractId: number) {
  const row = await db.contract.findUnique({
    where: { id: contractId },
    include: {
      freight: { include: { sub_products: { include: { bands: true } } } },
      addons: true,
    },
  });
  if (!row) throw new Error("Contract not found");

  const carrier = row.carrier;
  const billing_country = row.billing_country;

  const snapshot: ContractSnapshot = {
    id: row.id,
    carrier,
    billing_country,
    fuel_multiplier: row.fuel_multiplier ?? 1,
    freight: row.freight.map((p) => ({
      name: p.name,
      zone_group: p.zone_group,
      sub_products: p.sub_products.map((sp) => {
        const zones: Record<string, Band[]> = {};
        for (const b of sp.bands) {
          if (!zones[b.zone]) zones[b.zone] = [];
          const band: Band =
            b.weight_end != null && b.price != null
              ? { weight_start: b.weight_start, weight_end: b.weight_end, price: b.price, valid_from: b.valid_from, valid_until: b.valid_until }
              : { weight_start: b.weight_start, per_kg: b.per_kg ?? 0, step: b.step, valid_from: b.valid_from, valid_until: b.valid_until };
          zones[b.zone].push(band);
        }
        return {
          id: sp.id,
          name: sp.name,
          codes: sp.codes ? sp.codes.split(",").map((c) => c.trim()) : [],
          zones,
        };
      }),
    })),
    surcharges: row.addons.map((a) => ({ code: a.code, name: a.name, kind: a.kind, amount: a.amount, min_amount: a.min_amount, applies_to: a.applies_to as "any" | "domestic" | "international" })),
  };

  const [zoneMapRows, catalogRows, taxRows, catalogSurchargeRows] = await Promise.all([
    db.zoneMap.findMany({
      where: {
        carrier: { in: [carrier, carrier.toLowerCase(), "dhl-express"] },
        billing_country,
        OR: [{ contractId: null }, { contractId }],
      },
      include: { countries: true },
    }),
    db.catalogProduct.findMany({ where: { carrier } }),
    db.taxRate.findMany({ where: { carrier } }),
    db.catalogSurcharge.findMany({ where: { carrier } }),
  ]);

  const byGroup = new Map<string, Map<string, number>>();
  const ordered = [...zoneMapRows].sort((a, b) => (a.contractId ?? 0) - (b.contractId ?? 0));
  for (const zm of ordered) {
    const m = byGroup.get(zm.zone_group) ?? new Map<string, number>();
    for (const c of zm.countries) m.set(c.country.toUpperCase(), c.zone);
    byGroup.set(zm.zone_group, m);
  }
  const zoneMaps: ZoneMaps = { byGroup };

  const entries = new Map<string, CatalogEntry[]>();
  for (const cr of catalogRows) {
    if (!entries.has(cr.code)) entries.set(cr.code, []);
    entries.get(cr.code)!.push({
      product_name: cr.product_name,
      sub_product_name: cr.sub_product_name,
      direction: (cr.direction as "export" | "import" | "any") ?? "any",
    });
  }
  const surchargeNames = new Map<string, string>();
  for (const s of catalogSurchargeRows) surchargeNames.set(s.code, s.name);
  const catalog: Catalog = { entries, surchargeNames };
  const tax: TaxTable = { rateByCode: new Map(taxRows.map((r) => [r.code, r.rate])) };

  return { snapshot, catalog, zoneMaps, tax, volumetric_divisor: row.volumetric_divisor };
}

export interface SimulateRequest {
  contractId: number;
  productCode: string;
  origin: string;
  destination: string;
  weight_kg: number;
  length_cm?: number;
  width_cm?: number;
  height_cm?: number;
  ship_date: string;
  declared_value?: number;
  optional_surcharges: { code: string; amount?: number }[];
  tax_code?: string;
  compare_shipment_number?: string;
  find_similar?: boolean;
}

export interface ComparedLine {
  shipment_number: string;
  invoice_number: string;
  charged_amount: number | null;
  weight_charge: number | null;
  surcharges: { code: string; name: string; charge: number }[];
  tax_code: string | null;
  total_tax: number | null;
  // Audit results for the matched line — what the engine says it SHOULD have cost
  // given the contract that billed it + the published fuel rate for its week.
  expected_amount: number | null;
  expected_weight_charge: number | null;
  expected_surcharges: { code: string; name: string; expected: number; actual: number; delta: number; status: string }[];
  audit_status: string | null;
  // Which contract billed this matched line — surfaced so the UI can warn when it differs from the simulator's contract.
  contract_id: number | null;
  contract_name: string | null;
  contract_matches_sim: boolean;
  // Extra context for fuzzy matches so the user can see how close it actually is.
  match_kind: "exact" | "similar";
  match_tier?:
    | "exact"        // same contract + same product + dest + weight ±10%
    | "family-tight" // same contract + family + dest + weight ±10%
    | "family-loose";// same contract + family + dest + weight ±50%
  match_notes?: string;
  matched_on?: { product_code: string; dest_country: string; weight_kg: number; ship_date: string | null };
}

// DHL Express product families: codes that bill the same physical service, differing
// mainly by EU/non-EU routing or doc/non-doc. When a simulated product yields no
// matches (e.g. S→DK is an impossible combo since DK is EU), the matcher falls
// back to the family.
const PRODUCT_FAMILY: Record<string, string[]> = {
  S: ["S", "U"],          // Express Worldwide Package (non-EU / EU)
  U: ["U", "S"],
  V: ["V", "N"],          // Economy Select (EU / non-EU)
  N: ["N", "V"],
  T: ["T", "Y"],          // Express Doc / 12:00
  Y: ["Y", "T"],
  E: ["E"],               // Domestic, no family
};

interface InvoiceLineRow {
  id: number;
  shipment_number: string | null;
  charged_amount: number | null;
  weight_charge: number | null;
  surcharges_json: string | null;
  tax_code: string | null;
  total_tax: number | null;
  expected_amount: number | null;
  expected_weight_charge: number | null;
  expected_surcharges_json: string | null;
  audit_status: string | null;
  product_code: string | null;
  dest_country: string | null;
  weight_kg: number | null;
  shipment_date: string | null;
  invoice: { invoice_number: string; contractId: number | null; contract: { name: string } | null } | null;
}

const INVOICE_LINE_INCLUDE = {
  invoice: { select: { invoice_number: true, contractId: true, contract: { select: { name: true } } } },
} as const;

function pickClosest(rows: InvoiceLineRow[], target_kg: number): InvoiceLineRow | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => {
    const da = Math.abs((a.weight_kg ?? 0) - target_kg);
    const db = Math.abs((b.weight_kg ?? 0) - target_kg);
    if (da !== db) return da - db;
    return (b.shipment_date ?? "").localeCompare(a.shipment_date ?? ""); // newer first
  });
  return sorted[0];
}

async function findSimilarShipment(req: SimulateRequest): Promise<{ line: InvoiceLineRow; tier: NonNullable<ComparedLine["match_tier"]>; notes: string } | null> {
  const dest = req.destination.toUpperCase();
  const target = req.weight_kg;
  const tightLo = target * 0.9;
  const tightHi = target * 1.1;
  const looseLo = target * 0.5;
  const looseHi = target * 1.5;
  const family = PRODUCT_FAMILY[req.productCode] ?? [req.productCode];
  const baseWhere = { dest_country: dest, charged_amount: { gt: 0 } as const };

  // Helper: query invoice lines, optionally restricted to the simulator's contract.
  async function search(where: NonNullable<Parameters<typeof db.invoiceLine.findMany>[0]>["where"]) {
    return db.invoiceLine.findMany({ where, include: INVOICE_LINE_INCLUDE, take: 100 });
  }

  // ---- Tier 1: same contract, exact product, tight weight ----
  const t1 = await search({ ...baseWhere, invoice: { contractId: req.contractId }, product_code: req.productCode, weight_kg: { gte: tightLo, lte: tightHi } });
  const p1 = pickClosest(t1, target);
  if (p1) return { line: p1, tier: "exact", notes: "" };

  // ---- Tier 2: same contract, product family, tight weight ----
  if (family.length > 1) {
    const t2 = await search({ ...baseWhere, invoice: { contractId: req.contractId }, product_code: { in: family }, weight_kg: { gte: tightLo, lte: tightHi } });
    const p2 = pickClosest(t2, target);
    if (p2) return {
      line: p2,
      tier: "family-tight",
      notes: `Matched on family product ${p2.product_code} (no ${req.productCode}→${dest} shipment in this contract).`,
    };
  }

  // ---- Tier 3: same contract, family, loose weight ----
  const t3 = await search({ ...baseWhere, invoice: { contractId: req.contractId }, product_code: { in: family }, weight_kg: { gte: looseLo, lte: looseHi } });
  const p3 = pickClosest(t3, target);
  if (p3) return {
    line: p3,
    tier: "family-loose",
    notes: `Loosened weight to ±50% within this contract (no tight match).`,
  };

  // No cross-contract fallback — comparing a contract against another contract's
  // billing is meaningless (different rate cards). Return null and let the UI tell
  // the user that no shipment exists in this contract for the simulated parameters.
  return null;
}

function buildComparedLine(
  line: InvoiceLineRow,
  match_kind: "exact" | "similar",
  simContractId: number,
  match_tier?: ComparedLine["match_tier"],
  match_notes?: string,
): ComparedLine {
  return {
    shipment_number: line.shipment_number ?? "",
    invoice_number: line.invoice?.invoice_number ?? "",
    charged_amount: line.charged_amount,
    weight_charge: line.weight_charge,
    surcharges: line.surcharges_json ? JSON.parse(line.surcharges_json) : [],
    tax_code: line.tax_code,
    total_tax: line.total_tax,
    expected_amount: line.expected_amount,
    expected_weight_charge: line.expected_weight_charge,
    expected_surcharges: line.expected_surcharges_json ? JSON.parse(line.expected_surcharges_json) : [],
    audit_status: line.audit_status,
    contract_id: line.invoice?.contractId ?? null,
    contract_name: line.invoice?.contract?.name ?? null,
    contract_matches_sim: line.invoice?.contractId === simContractId,
    match_kind,
    match_tier,
    match_notes,
    matched_on: match_kind === "similar"
      ? {
          product_code: line.product_code ?? "",
          dest_country: line.dest_country ?? "",
          weight_kg: line.weight_kg ?? 0,
          ship_date: line.shipment_date,
        }
      : undefined,
  };
}

export interface SimulateResponse {
  result: SimulateResult;
  compared?: ComparedLine | null;
}

export interface LoadedShipment {
  contractId: number;
  productCode: string;
  origin: string;
  destination: string;
  weight_kg: number;
  ship_date: string;
  tax_code: string | null;
  surcharge_codes: string[];
  invoice_number: string;
  shipment_number: string;
}

export async function loadShipmentByNumber(shipmentNumber: string): Promise<LoadedShipment | null> {
  const trimmed = shipmentNumber.trim();
  if (!trimmed) return null;
  // Multiple lines can carry the same shipment_number (re-ingest leftovers,
  // legitimate re-billing). Require an invoice that actually still exists,
  // contractId set, and product/destination populated — orphan rows
  // (invoiceId points at a deleted Invoice) silently fail the include and
  // would otherwise look like "no match".
  const candidates = await db.invoiceLine.findMany({
    where: { shipment_number: trimmed },
    include: { invoice: { select: { invoice_number: true, contractId: true } } },
    orderBy: { id: "desc" },
    take: 5,
  });
  const line = candidates.find((c) => c.invoice?.contractId && c.product_code && c.dest_country);
  if (!line || !line.invoice?.contractId || !line.product_code || !line.dest_country) return null;
  const surcharges = line.surcharges_json ? (JSON.parse(line.surcharges_json) as { code: string }[]) : [];
  return {
    contractId: line.invoice.contractId,
    productCode: line.product_code,
    origin: line.origin_country ?? "DE",
    destination: line.dest_country,
    weight_kg: line.weight_kg ?? 0,
    ship_date: line.shipment_date ?? "",
    tax_code: line.tax_code,
    surcharge_codes: surcharges.filter((s) => s.code !== "FF").map((s) => s.code),
    invoice_number: line.invoice.invoice_number,
    shipment_number: line.shipment_number ?? trimmed,
  };
}

export async function runSimulation(req: SimulateRequest): Promise<SimulateResponse> {
  const { snapshot, catalog, zoneMaps, tax, volumetric_divisor } = await loadEngineInputs(req.contractId);
  const input: SimulateInput = {
    contract: snapshot,
    catalog,
    zoneMaps,
    tax,
    productCode: req.productCode,
    origin: req.origin,
    destination: req.destination,
    weight_kg: req.weight_kg,
    length_cm: req.length_cm,
    width_cm: req.width_cm,
    height_cm: req.height_cm,
    ship_date: req.ship_date,
    declared_value: req.declared_value,
    optional_surcharges: req.optional_surcharges,
    tax_code: req.tax_code,
    volumetric_divisor,
  };
  const result = simulateShipment(input);

  let compared: ComparedLine | null = null;
  if (req.compare_shipment_number) {
    const line = await db.invoiceLine.findFirst({
      where: { shipment_number: req.compare_shipment_number },
      include: INVOICE_LINE_INCLUDE,
    });
    if (line) compared = buildComparedLine(line, "exact", req.contractId);
  } else if (req.find_similar) {
    const found = await findSimilarShipment(req);
    if (found) compared = buildComparedLine(found.line, "similar", req.contractId, found.tier, found.notes);
  }

  return { result, compared };
}

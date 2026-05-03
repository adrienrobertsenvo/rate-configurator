"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { db } from "../lib/db";
import { parseDhlInvoiceCsv, type ParsedShipmentRow } from "../lib/invoice-parse";
import {
  computeLine,
  computeCustomsLine,
  type ContractSnapshot,
  type Catalog,
  type ZoneMaps,
  type Band,
  type EngineResult,
  type TaxTable,
  type CatalogEntry,
} from "../lib/rate-engine";

async function loadContractSnapshot(contractId: number): Promise<{ snapshot: ContractSnapshot; carrier: string }> {
  const row = await db.contract.findUnique({
    where: { id: contractId },
    include: {
      freight: { include: { sub_products: { include: { bands: true } } } },
      addons: true,
    },
  });
  if (!row) throw new Error("Contract not found");
  const snapshot: ContractSnapshot = {
    id: row.id,
    carrier: row.carrier,
    billing_country: row.billing_country,
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
  return { snapshot, carrier: row.carrier };
}

async function loadLookups(
  carrier: string,
  billing_country: string,
  contractId: number,
): Promise<{ zoneMaps: ZoneMaps; catalog: Catalog; tax: TaxTable }> {
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
  // Apply in order: baseline first, then contract override wins
  const ordered = [...zoneMapRows].sort((a, b) => (a.contractId ?? 0) - (b.contractId ?? 0));
  for (const zm of ordered) {
    const m = byGroup.get(zm.zone_group) ?? new Map<string, number>();
    for (const c of zm.countries) m.set(c.country.toUpperCase(), c.zone);
    byGroup.set(zm.zone_group, m);
  }
  const zoneMaps: ZoneMaps = { byGroup };

  const entries = new Map<string, CatalogEntry[]>();
  for (const row of catalogRows) {
    if (!entries.has(row.code)) entries.set(row.code, []);
    entries.get(row.code)!.push({
      product_name: row.product_name,
      sub_product_name: row.sub_product_name,
      direction: (row.direction as "export" | "import" | "any") ?? "any",
    });
  }
  const surchargeNames = new Map<string, string>();
  for (const s of catalogSurchargeRows) surchargeNames.set(s.code, s.name);
  const catalog: Catalog = { entries, surchargeNames };
  const tax: TaxTable = { rateByCode: new Map(taxRows.map((r) => [r.code, r.rate])) };
  return { zoneMaps, catalog, tax };
}

// Position 12 of row 2 in DHL invoice CSVs = "Billing Account" (numeric account).
// We capture it here so picking a contract manually still teaches the importer
// the account → contract mapping for next time (auto-learn).
const ACCOUNT_NUMBER_RE = /^"[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","([^"]*)"/;

export async function uploadInvoice(formData: FormData): Promise<{ invoiceId: number }> {
  const file = formData.get("csv");
  const contractIdRaw = formData.get("contractId");
  if (!(file instanceof File)) throw new Error("No CSV file provided");
  const contractId = Number(contractIdRaw);
  if (!Number.isFinite(contractId)) throw new Error("Contract must be selected before upload");

  const buf = Buffer.from(await file.arrayBuffer());
  const text = buf.toString("utf8");
  const parsed = parseDhlInvoiceCsv(text);

  const { snapshot, carrier } = await loadContractSnapshot(contractId);
  const { zoneMaps, catalog, tax } = await loadLookups(carrier, snapshot.billing_country, contractId);

  const sourceSha = createHash("sha256").update(buf).digest("hex");

  // Auto-learn: if the user picked a contract whose account_numbers don't yet
  // include this CSV's billing account, append it. Next upload routes itself.
  const row2 = text.split(/\r?\n/, 2)[1];
  const acctMatch = ACCOUNT_NUMBER_RE.exec(row2 ?? "");
  const acctNumber = acctMatch?.[1]?.trim();
  let contractCustomerId: number | null = null;
  if (acctNumber) {
    const cRow = await db.contract.findUnique({ where: { id: contractId }, select: { account_numbers: true, customerId: true } });
    contractCustomerId = cRow?.customerId ?? null;
    let nums: string[] = [];
    try { nums = cRow?.account_numbers ? JSON.parse(cRow.account_numbers) : []; } catch {}
    if (!nums.includes(acctNumber)) {
      nums = [...nums, acctNumber].sort();
      await db.contract.update({ where: { id: contractId }, data: { account_numbers: JSON.stringify(nums) } });
    }
  } else {
    const cRow = await db.contract.findUnique({ where: { id: contractId }, select: { customerId: true } });
    contractCustomerId = cRow?.customerId ?? null;
  }

  const invoice = await db.invoice.upsert({
    where: { invoice_number: parsed.invoice_number },
    update: {
      invoice_date: parsed.invoice_date,
      contractId,
      customerId: contractCustomerId,
      currency: parsed.currency,
      total_excl_vat: parsed.total_excl_vat,
      invoice_type: parsed.invoice_type,
      source_filename: file.name,
      source_size_bytes: buf.byteLength,
      source_sha256: sourceSha,
      source_bytes: buf,
      lines: { deleteMany: {} },
    },
    create: {
      invoice_number: parsed.invoice_number,
      invoice_date: parsed.invoice_date,
      contractId,
      customerId: contractCustomerId,
      currency: parsed.currency,
      total_excl_vat: parsed.total_excl_vat,
      invoice_type: parsed.invoice_type,
      source_filename: file.name,
      source_size_bytes: buf.byteLength,
      source_sha256: sourceSha,
      source_bytes: buf,
    },
    select: { id: true },
  });

  for (const line of parsed.lines) {
    // Customs invoices use a separate audit path — they have no product/zone/weight.
    const audit = parsed.invoice_type === "customs"
      ? computeCustomsLine(line, snapshot)
      : computeLine(line, snapshot, catalog, zoneMaps, tax);
    await db.invoiceLine.create({
      data: buildLineRow(invoice.id, line, audit),
    });
  }

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoice.id}`);
  return { invoiceId: invoice.id };
}

function buildLineRow(invoiceId: number, line: ParsedShipmentRow, audit: EngineResult) {
  return {
    invoiceId,
    shipment_number: line.shipment_number,
    shipment_date: line.shipment_date,
    product_code: line.product_code,
    product_name: line.product_name,
    origin_country: line.origin_country,
    dest_country: line.dest_country,
    weight_kg: line.weight_kg,
    weight_flag: line.weight_flag,
    declared_value: line.declared_value,
    charged_amount: line.charged_amount,
    weight_charge: line.weight_charge,
    surcharges_json: JSON.stringify(line.surcharges),
    tax_code: line.tax_code,
    total_tax: line.total_tax,
    expected_amount: audit.expected_total,
    expected_weight_charge: audit.expected_weight_charge,
    expected_surcharges_json: JSON.stringify(audit.expected_surcharges),
    expected_tax: audit.expected_tax,
    delta: audit.delta,
    tax_delta: audit.tax_delta,
    surcharge_delta: audit.surcharge_delta,
    audit_status: audit.status,
    tax_status: audit.tax_status,
    surcharge_status: audit.surcharge_status,
    audit_notes: audit.notes.join("; ") || null,
    matched_product: audit.matched_product,
    matched_sub_product: audit.matched_sub_product,
    matched_zone: audit.matched_zone,
    matched_band_json: audit.matched_band ? JSON.stringify(audit.matched_band) : null,
  };
}

export async function deleteInvoice(id: number) {
  await db.invoice.delete({ where: { id } });
  revalidatePath("/invoices");
}

export async function rerunAudit(invoiceId: number) {
  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    include: { lines: true, contract: true },
  });
  if (!invoice || !invoice.contract) throw new Error("Invoice or contract not found");

  const { snapshot, carrier } = await loadContractSnapshot(invoice.contract.id);
  const { zoneMaps, catalog, tax } = await loadLookups(carrier, snapshot.billing_country, invoice.contract.id);
  const isCustoms = invoice.invoice_type === "customs";

  for (const l of invoice.lines) {
    const shipment: ParsedShipmentRow = {
      shipment_number: l.shipment_number,
      shipment_date: l.shipment_date,
      product_code: l.product_code,
      product_name: l.product_name,
      origin_country: l.origin_country,
      dest_country: l.dest_country,
      weight_kg: l.weight_kg,
      weight_flag: l.weight_flag,
      declared_value: l.declared_value,
      charged_amount: l.charged_amount,
      weight_charge: l.weight_charge,
      surcharges: l.surcharges_json ? JSON.parse(l.surcharges_json) : [],
      tax_code: l.tax_code,
      total_tax: l.total_tax,
    };
    const audit = isCustoms
      ? computeCustomsLine(shipment, snapshot)
      : computeLine(shipment, snapshot, catalog, zoneMaps, tax);
    await db.invoiceLine.update({
      where: { id: l.id },
      data: {
        expected_amount: audit.expected_total,
        expected_weight_charge: audit.expected_weight_charge,
        expected_surcharges_json: JSON.stringify(audit.expected_surcharges),
        expected_tax: audit.expected_tax,
        delta: audit.delta,
        tax_delta: audit.tax_delta,
        surcharge_delta: audit.surcharge_delta,
        audit_status: audit.status,
        tax_status: audit.tax_status,
        surcharge_status: audit.surcharge_status,
        audit_notes: audit.notes.join("; ") || null,
        matched_product: audit.matched_product,
        matched_sub_product: audit.matched_sub_product,
        matched_zone: audit.matched_zone,
        matched_band_json: audit.matched_band ? JSON.stringify(audit.matched_band) : null,
      },
    });
  }

  // Wrap revalidatePath because this server action is also called from CLI
  // scripts (scripts/reaudit_invoices.ts), where there's no request store and
  // the call would otherwise throw "Invariant: static generation store missing".
  try { revalidatePath(`/invoices/${invoiceId}`); } catch { /* CLI context */ }
}

import { db } from "../app/lib/db";
import { computeLine, type ContractSnapshot, type Catalog, type ZoneMaps, type TaxTable, type CatalogEntry, type Band } from "../app/lib/rate-engine";
import type { ParsedShipmentRow } from "../app/lib/invoice-parse";

async function loadEngineInputs(contractId: number) {
  const row = await db.contract.findUniqueOrThrow({
    where: { id: contractId },
    include: { freight: { include: { sub_products: { include: { bands: true } } } }, addons: true },
  });
  const carrier = row.carrier;
  const billing_country = row.billing_country;
  const snapshot: ContractSnapshot = {
    id: row.id, carrier, billing_country, fuel_multiplier: row.fuel_multiplier ?? 1,
    freight: row.freight.map((p) => ({
      name: p.name, zone_group: p.zone_group,
      sub_products: p.sub_products.map((sp) => {
        const zones: Record<string, Band[]> = {};
        for (const b of sp.bands) {
          if (!zones[b.zone]) zones[b.zone] = [];
          const band: Band = b.weight_end != null && b.price != null
            ? { weight_start: b.weight_start, weight_end: b.weight_end, price: b.price, valid_from: b.valid_from, valid_until: b.valid_until }
            : { weight_start: b.weight_start, per_kg: b.per_kg ?? 0, step: b.step, valid_from: b.valid_from, valid_until: b.valid_until };
          zones[b.zone].push(band);
        }
        return { id: sp.id, name: sp.name, codes: sp.codes ? sp.codes.split(",").map(c=>c.trim()) : [], zones };
      }),
    })),
    surcharges: row.addons.map((a) => ({ code: a.code, name: a.name, kind: a.kind, amount: a.amount, min_amount: a.min_amount, applies_to: a.applies_to as "any" | "domestic" | "international" })),
  };
  const [zoneMapRows, catalogRows, taxRows, catalogSurchargeRows] = await Promise.all([
    db.zoneMap.findMany({ where: { carrier: { in: [carrier, carrier.toLowerCase(), "dhl-express"] }, billing_country, OR: [{ contractId: null }, { contractId }] }, include: { countries: true } }),
    db.catalogProduct.findMany({ where: { carrier } }),
    db.taxRate.findMany({ where: { carrier } }),
    db.catalogSurcharge.findMany({ where: { carrier } }),
  ]);
  const byGroup = new Map<string, Map<string, number>>();
  for (const zm of [...zoneMapRows].sort((a, b) => (a.contractId ?? 0) - (b.contractId ?? 0))) {
    const m = byGroup.get(zm.zone_group) ?? new Map<string, number>();
    for (const c of zm.countries) m.set(c.country.toUpperCase(), c.zone);
    byGroup.set(zm.zone_group, m);
  }
  const entries = new Map<string, CatalogEntry[]>();
  for (const cr of catalogRows) {
    if (!entries.has(cr.code)) entries.set(cr.code, []);
    entries.get(cr.code)!.push({ product_name: cr.product_name, sub_product_name: cr.sub_product_name, direction: (cr.direction as "export"|"import"|"any") ?? "any" });
  }
  const surchargeNames = new Map<string, string>();
  for (const s of catalogSurchargeRows) surchargeNames.set(s.code, s.name);
  return {
    snapshot,
    catalog: { entries, surchargeNames } as Catalog,
    zoneMaps: { byGroup } as ZoneMaps,
    tax: { rateByCode: new Map(taxRows.map(r => [r.code, r.rate])) } as TaxTable,
  };
}

async function main() {
  const invoices = await db.invoice.findMany({
    where: { contractId: { not: null } },
    select: { id: true, invoice_number: true, contractId: true, _count: { select: { lines: true } } },
  });
  for (const inv of invoices) {
    if (!inv.contractId) continue;
    process.stdout.write(`${inv.invoice_number} (${inv._count.lines} lines)... `);
    const ctx = await loadEngineInputs(inv.contractId);
    const lines = await db.invoiceLine.findMany({ where: { invoiceId: inv.id } });
    let updated = 0;
    for (const l of lines) {
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
      const audit = computeLine(shipment, ctx.snapshot, ctx.catalog, ctx.zoneMaps, ctx.tax);
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
      updated++;
    }
    console.log(`updated ${updated}`);
  }
  // Print summary
  const stats = await db.invoiceLine.groupBy({ by: ["audit_status"], _count: true });
  console.log("\nAudit status counts (line-level):");
  for (const s of stats) console.log(`  ${s.audit_status ?? "null"}: ${s._count}`);

  const surStats = await db.invoiceLine.groupBy({ by: ["surcharge_status"], _count: true });
  console.log("\nSurcharge status counts:");
  for (const s of surStats) console.log(`  ${s.surcharge_status ?? "null"}: ${s._count}`);

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

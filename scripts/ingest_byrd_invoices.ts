// Load the 14 Byrd Technologies CSVs in /tmp/dhl-archive2 against contract #7
// so the Simulator's "Load" button can pull them by shipment number.
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { db } from "../app/lib/db";
import { parseDhlInvoiceCsv } from "../app/lib/invoice-parse";
import {
  computeLine, type ContractSnapshot, type Catalog, type ZoneMaps, type TaxTable, type CatalogEntry, type Band,
} from "../app/lib/rate-engine";

const CONTRACT_ID = 7;
const SOURCE_GLOB = "/tmp/dhl-archive2/BERR*.csv";

async function loadInputs(contractId: number) {
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
            ? { weight_start: b.weight_start, weight_end: b.weight_end, price: b.price }
            : { weight_start: b.weight_start, per_kg: b.per_kg ?? 0, step: b.step };
          zones[b.zone].push(band);
        }
        return { id: sp.id, name: sp.name, codes: sp.codes ? sp.codes.split(",").map(c=>c.trim()) : [], zones };
      }),
    })),
    surcharges: row.addons.map((a) => ({ code: a.code, name: a.name, kind: a.kind, amount: a.amount })),
  };
  const [zoneMapRows, catalogRows, taxRows] = await Promise.all([
    db.zoneMap.findMany({ where: { carrier: { in: [carrier, carrier.toLowerCase(), "dhl-express"] }, billing_country, OR: [{ contractId: null }, { contractId }] }, include: { countries: true } }),
    db.catalogProduct.findMany({ where: { carrier } }),
    db.taxRate.findMany({ where: { carrier } }),
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
  return {
    snapshot,
    catalog: { entries } as Catalog,
    zoneMaps: { byGroup } as ZoneMaps,
    tax: { rateByCode: new Map(taxRows.map(r => [r.code, r.rate])) } as TaxTable,
  };
}

async function main() {
  const ctx = await loadInputs(CONTRACT_ID);
  const paths: string[] = [];
  for await (const p of glob(SOURCE_GLOB)) paths.push(p as string);
  paths.sort();

  for (const path of paths) {
    const csv = readFileSync(path, "utf8");
    const parsed = parseDhlInvoiceCsv(csv);
    const invoice = await db.invoice.upsert({
      where: { invoice_number: parsed.invoice_number },
      update: {
        invoice_date: parsed.invoice_date,
        contractId: CONTRACT_ID,
        currency: parsed.currency,
        total_excl_vat: parsed.total_excl_vat,
        lines: { deleteMany: {} },
      },
      create: {
        invoice_number: parsed.invoice_number,
        invoice_date: parsed.invoice_date,
        contractId: CONTRACT_ID,
        currency: parsed.currency,
        total_excl_vat: parsed.total_excl_vat,
      },
      select: { id: true },
    });

    let ok = 0, under = 0, over = 0, unresolved = 0;
    for (const line of parsed.lines) {
      const audit = computeLine(line, ctx.snapshot, ctx.catalog, ctx.zoneMaps, ctx.tax);
      await db.invoiceLine.create({
        data: {
          invoiceId: invoice.id,
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
        },
      });
      if (audit.status === "ok") ok++;
      else if (audit.status === "under") under++;
      else if (audit.status === "over") over++;
      else unresolved++;
    }
    console.log(`${parsed.invoice_number}  ${parsed.lines.length} lines  ok=${ok} under=${under} over=${over} unresolved=${unresolved}`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

import { db } from "../app/lib/db";
import { simulateShipment } from "../app/lib/pricing";
import type { Band, ContractSnapshot, Catalog, ZoneMaps, TaxTable, CatalogEntry } from "../app/lib/rate-engine";

async function loadSnap(contractId: number) {
  const row = await db.contract.findUniqueOrThrow({
    where: { id: contractId },
    include: { freight: { include: { sub_products: { include: { bands: true } } } }, addons: true },
  });
  const snapshot: ContractSnapshot = {
    id: row.id, carrier: row.carrier, billing_country: row.billing_country,
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
    db.zoneMap.findMany({ where: { carrier: row.carrier, billing_country: row.billing_country, OR: [{ contractId: null }, { contractId }] }, include: { countries: true } }),
    db.catalogProduct.findMany({ where: { carrier: row.carrier } }),
    db.taxRate.findMany({ where: { carrier: row.carrier } }),
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
    volumetric_divisor: row.volumetric_divisor,
  };
}

async function main() {
  // Pick 5 random lines from the DB and simulate them.
  const lines = await db.invoiceLine.findMany({
    where: { weight_kg: { gt: 0 }, charged_amount: { gt: 0 }, product_code: { not: null } },
    take: 6, orderBy: { id: "desc" },
    include: { invoice: { select: { contractId: true, invoice_number: true } } },
  });
  for (const line of lines) {
    if (!line.invoice?.contractId || !line.product_code || !line.dest_country) continue;
    const ctx = await loadSnap(line.invoice.contractId);
    const surcharges = line.surcharges_json ? JSON.parse(line.surcharges_json) as { code: string; name: string; charge: number }[] : [];
    const result = simulateShipment({
      contract: ctx.snapshot,
      catalog: ctx.catalog, zoneMaps: ctx.zoneMaps, tax: ctx.tax,
      productCode: line.product_code,
      origin: line.origin_country ?? "DE",
      destination: line.dest_country,
      weight_kg: line.weight_kg!,
      ship_date: line.shipment_date ?? "2026-04-15",
      optional_surcharges: surcharges.filter(s => s.code !== "FF").map(s => ({ code: s.code, amount: s.charge })),
      tax_code: line.tax_code ?? undefined,
      volumetric_divisor: ctx.volumetric_divisor,
    });
    console.log(`\n${line.invoice.invoice_number} · ${line.shipment_number} · ${line.product_code} ${line.origin_country}→${line.dest_country} · ${line.weight_kg}kg`);
    console.log(`  actual: WC €${(line.weight_charge ?? 0).toFixed(2)}  total €${(line.charged_amount ?? 0).toFixed(2)}  fuel(actual) €${(surcharges.find(s=>s.code==="FF")?.charge ?? 0).toFixed(2)}`);
    console.log(`  sim   : WC €${result.weight_charge.toFixed(2)}  total €${result.total_excl_vat.toFixed(2)}  fuel €${result.fuel_amount.toFixed(2)} (${result.fuel_class} ${result.iso_week})`);
    if (result.warnings.length) console.log("  warnings:", result.warnings);
  }
  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });

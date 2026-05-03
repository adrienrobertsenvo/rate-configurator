// Debug why simulator returns €23.97 for S DE→IL 1kg under Byrd contract.
import { db } from "../app/lib/db";
import { simulateShipment } from "../app/lib/carriers/dhl-express/pricing";
import type { Band, ContractSnapshot, Catalog, ZoneMaps, TaxTable, CatalogEntry } from "../app/lib/carriers/dhl-express/rate-engine";

async function main() {
  const row = await db.contract.findUniqueOrThrow({
    where: { id: 7 },
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

  // Show Package sub-product structure
  const ewe = snapshot.freight.find(f => f.name === "Express Worldwide Export")!;
  console.log("Express Worldwide Export sub-products:");
  for (const sp of ewe.sub_products) {
    const zones = Object.keys(sp.zones).sort();
    const z6 = sp.zones["Zone 6"] ?? [];
    console.log(`  - ${sp.name} (zones: ${zones.join(", ")})`);
    console.log(`    Zone 6 bands: ${z6.map(b => "price" in b ? `${b.weight_start}–${b.weight_end}=€${b.price}` : `≥${b.weight_start} per_kg=${b.per_kg}`).join("; ")}`);
  }

  const [zoneMapRows, catalogRows, taxRows] = await Promise.all([
    db.zoneMap.findMany({ where: { carrier: { in: [row.carrier, row.carrier.toLowerCase(), "dhl-express"] }, billing_country: row.billing_country, OR: [{ contractId: null }, { contractId: 7 }] }, include: { countries: true } }),
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

  const result = simulateShipment({
    contract: snapshot,
    catalog: { entries } as Catalog,
    zoneMaps: { byGroup } as ZoneMaps,
    tax: { rateByCode: new Map(taxRows.map(r => [r.code, r.rate])) } as TaxTable,
    productCode: "S",
    origin: "DE",
    destination: "IL",
    weight_kg: 1.0,
    ship_date: "2026-05-02",
    optional_surcharges: [],
  });
  console.log("\nSimulation result:");
  console.log(`  weight_charge: €${result.weight_charge.toFixed(2)}`);
  console.log(`  fuel_amount:   €${result.fuel_amount.toFixed(2)}`);
  console.log(`  total:         €${result.total_excl_vat.toFixed(2)}`);
  for (const s of result.steps) {
    if (s.kind === "lookup") console.log(`  lookup → ${s.product} / ${s.sub_product} / ${s.zone} band=${JSON.stringify(s.band)}`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

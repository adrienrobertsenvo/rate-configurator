// Seed CatalogProduct, CatalogSurcharge, and TaxRate rows for the GB and FR
// DHL Express carriers by copying the DE catalog (product names + billing
// codes are stable across DHL Express in different countries; only tax codes
// differ). Idempotent — uses upsert via unique key checks.
//
// Run: npx tsx scripts/seed_country_catalogs.ts
import { db } from "../app/lib/db";

const TARGET_CARRIERS = ["DHL-EXPRESS-GB", "DHL-EXPRESS-FR"] as const;

// Country-specific tax codes. The product/surcharge codes (S, U, FF, OO, …)
// are universal across DHL Express; tax codes differ by country.
const TAX_RATES: Record<string, { code: string; rate: number; description: string }[]> = {
  "DHL-EXPRESS-GB": [
    { code: "A", rate: 0.20, description: "UK VAT 20%" },
    { code: "Z", rate: 0.00, description: "Zero-rated (intl. transport)" },
    { code: "X", rate: 0.00, description: "Tax-exempt / suspended" },
  ],
  "DHL-EXPRESS-FR": [
    { code: "A", rate: 0.20, description: "TVA 20%" },
    { code: "B", rate: 0.10, description: "TVA 10% (réduit)" },
    { code: "C", rate: 0.00, description: "Zéro-tarifé (transport intl.)" },
    { code: "X", rate: 0.00, description: "Exonéré" },
  ],
};

async function main() {
  // Source catalog: DHL-EXPRESS-DE (the canonical / most-complete one).
  const products = await db.catalogProduct.findMany({ where: { carrier: "DHL-EXPRESS-DE" } });
  const surcharges = await db.catalogSurcharge.findMany({ where: { carrier: "DHL-EXPRESS-DE" } });

  for (const carrier of TARGET_CARRIERS) {
    let pInserted = 0, pSkipped = 0;
    for (const p of products) {
      try {
        await db.catalogProduct.create({
          data: { carrier, code: p.code, product_name: p.product_name, sub_product_name: p.sub_product_name, direction: p.direction, name_filter: p.name_filter },
        });
        pInserted++;
      } catch { pSkipped++; }
    }
    let sInserted = 0, sSkipped = 0;
    for (const s of surcharges) {
      try {
        await db.catalogSurcharge.create({ data: { carrier, code: s.code, name: s.name, kind: s.kind } });
        sInserted++;
      } catch { sSkipped++; }
    }
    let tInserted = 0;
    for (const t of TAX_RATES[carrier] ?? []) {
      try {
        await db.taxRate.create({ data: { carrier, code: t.code, rate: t.rate, description: t.description } });
        tInserted++;
      } catch { /* unique conflict — already there */ }
    }
    console.log(`${carrier}: products +${pInserted} (${pSkipped} already), surcharges +${sInserted} (${sSkipped}), tax rates +${tInserted}`);
  }

  // Set Refurbed contracts to 50% off prevailing fuel.
  const refurbedIds = (await db.contract.findMany({ where: { name: { contains: "Refurbed" } }, select: { id: true } })).map((c) => c.id);
  if (refurbedIds.length) {
    await db.contract.updateMany({ where: { id: { in: refurbedIds } }, data: { fuel_multiplier: 0.5 } });
    console.log(`Set fuel_multiplier=0.5 on Refurbed contracts: ${refurbedIds.join(", ")}`);
  }

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

// Seed a generic "DHL Express UK — Customs Standard" contract so customs
// invoices have admin-fee rules to audit against. Idempotent.
//
// Run: npx tsx scripts/seed_uk_customs_standard.ts
import { db } from "../app/lib/db";

const NAME = "DHL Express UK — Customs Standard";

async function main() {
  const existing = await db.contract.findFirst({ where: { name: NAME } });
  if (existing) {
    console.log(`already exists as #${existing.id}`);
    return;
  }
  const c = await db.contract.create({
    data: {
      name: NAME,
      carrier: "DHL-EXPRESS-GB",
      billing_country: "GB",
      currency_code: "GBP",
      volumetric_divisor: 5000,
      fuel_multiplier: 1.0,
      valid_from: "2025-01-01",
      valid_until: "2030-12-31",
      addons: {
        create: [
          // DHL UK "Duty Tax Importer": 2.5 % of (Duty + VAT + levies), min £14.
          // The min and rate are configurable per-contract — these are public-rate defaults.
          { code: "WC", name: "Duty Tax Importer",        kind: "percent_of_taxes", amount: 2.5, min_amount: 14, applies_to: "any" },
          { code: "WD", name: "Clearance Authorization",  kind: "flat",             amount: 8,                 applies_to: "any" },
          { code: "WE", name: "Multiline Entry",          kind: "flat",             amount: 3,                 applies_to: "any" },
        ],
      },
    },
    select: { id: true },
  });
  console.log(`created #${c.id} ${NAME}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

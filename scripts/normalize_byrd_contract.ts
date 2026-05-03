// One-shot fix for contract #7 (Byrd Technologies):
// 1. Strip the "DHL " prefix from freight product names so they match the canonical CatalogProduct vocabulary.
// 2. Replace SubProduct.codes (which contain marketing phrases like "EXPRESS WORLDWIDE") with [] so the
//    audit/simulator route via the global catalog only.
//
// Run: npx tsx scripts/normalize_byrd_contract.ts
import { db } from "../app/lib/db";

const NAME_REWRITES: Record<string, string> = {
  "DHL Express Worldwide Export":        "Express Worldwide Export",
  "DHL Express Worldwide Import":        "Express Worldwide Import",
  "DHL Express Worldwide Third Country": "Express Worldwide Third Country",
  "DHL Express Domestic":                "Express Domestic",
  "DHL Express 12:00 (Document)":        "Express 12:00 (Document)",
  "DHL Economy Select Export":           "Economy Select Export",
  "DHL Economy Select Import":           "Economy Select Import",
};

async function main() {
  const products = await db.freightProduct.findMany({ where: { contractId: 7 }, select: { id: true, name: true } });
  for (const p of products) {
    const target = NAME_REWRITES[p.name];
    if (target && target !== p.name) {
      await db.freightProduct.update({ where: { id: p.id }, data: { name: target } });
      console.log(`renamed [${p.id}] '${p.name}' → '${target}'`);
    } else if (!target) {
      console.log(`(left unchanged) [${p.id}] '${p.name}'`);
    }
  }

  const subs = await db.subProduct.findMany({
    where: { product: { contractId: 7 } },
    select: { id: true, name: true, codes: true, product: { select: { name: true } } },
  });
  for (const sp of subs) {
    if (sp.codes) {
      await db.subProduct.update({ where: { id: sp.id }, data: { codes: null } });
      console.log(`cleared codes on [${sp.id}] ${sp.product.name} → ${sp.name} (was '${sp.codes}')`);
    }
  }

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

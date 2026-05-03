import { PrismaClient } from "../app/generated/prisma/client.ts";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

async function main() {
  const adapter = new PrismaBetterSqlite3({ url: "file:./dev.db" });
  const db = new PrismaClient({ adapter });

  const groupByProductName: Record<string, string> = {
    "Express Worldwide Export": "worldwide",
    "Express Worldwide Import": "worldwide",
    "Express Worldwide Third Country": "worldwide",
    "Economy Select Export": "economy",
    "Economy Select Import": "economy",
    "Express Domestic": "domestic",
    "Express 12:00 (Document)": "worldwide",
  };

  const products = await db.freightProduct.findMany();
  for (const p of products) {
    const group = groupByProductName[p.name] ?? "default";
    if (p.zone_group !== group) {
      await db.freightProduct.update({ where: { id: p.id }, data: { zone_group: group } });
    }
  }

  const carriers = [...new Set((await db.contract.findMany({ select: { carrier: true } })).map((c) => c.carrier))];
  for (const carrier of carriers) {
    for (const g of ["worldwide", "economy", "domestic"]) {
      const existing = await db.zoneMap.findFirst({
        where: { carrier, billing_country: "DE", zone_group: g, contractId: null },
      });
      if (!existing) {
        await db.zoneMap.create({
          data: {
            carrier,
            billing_country: "DE",
            zone_group: g,
            spec_name: `${carrier} ${g} (DE baseline)`,
            valid_from: "2025-01-01",
            currency_code: "EUR",
          },
        });
      }
    }
  }

  console.log("backfilled", products.length, "freight products;", carriers.length, "carriers × 3 groups");
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

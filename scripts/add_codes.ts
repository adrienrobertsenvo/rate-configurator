import { PrismaClient } from "../app/generated/prisma/client.ts";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

async function main() {
  const adapter = new PrismaBetterSqlite3({ url: "file:./dev.db" });
  const db = new PrismaClient({ adapter });

  await db.catalogProduct.upsert({
    where: { carrier_code_direction: { carrier: "DHL-EXPRESS-DE", code: "N", direction: "any" } },
    update: { product_name: "Economy Select Export", sub_product_name: "Package" },
    create: { carrier: "DHL-EXPRESS-DE", code: "N", direction: "any", product_name: "Economy Select Export", sub_product_name: "Package" },
  });
  await db.catalogSurcharge.upsert({
    where: { carrier_code: { carrier: "DHL-EXPRESS-DE", code: "YO" } },
    update: { name: "Non-Conveyable Piece — Weight", kind: "flat" },
    create: { carrier: "DHL-EXPRESS-DE", code: "YO", name: "Non-Conveyable Piece — Weight", kind: "flat" },
  });
  console.log("ok");
  await db.$disconnect();
}

main();

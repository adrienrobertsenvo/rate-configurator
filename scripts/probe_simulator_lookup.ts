import { db } from "../app/lib/db";
async function main() {
  const trimmed = "1ZAY2622DK42880078";
  const line = await db.invoiceLine.findFirst({
    where: { shipment_number: trimmed },
    include: { invoice: { select: { invoice_number: true, contractId: true } } },
  });
  console.log("findFirst returned:", line ? `id=${line.id} invoice=${line.invoice?.invoice_number} contract=${line.invoice?.contractId} dest=${line.dest_country} product=${line.product_code}` : "null");
  await db.$disconnect();
}
main();

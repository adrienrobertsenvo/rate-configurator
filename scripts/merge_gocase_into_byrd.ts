// Merge: contract #14 (Gocase) currently sits under Customer #7 "Gocase",
// but in reality byrd technologies owns the GoCase business and both
// contracts belong to one customer = Byrd. Routing then disambiguates
// by DHL account number (Byrd 144114670, Gocase 145462725).
//
// Steps:
//   1. Re-link contract #14 → Customer #4 (Byrd)
//   2. Set contract #14.account_numbers = ["145462725"]
//   3. Re-link any Gocase invoices (none expected) → customerId = 4
//   4. Delete orphan Customer #7 "Gocase"
//
// Run: npx tsx scripts/merge_gocase_into_byrd.ts
import { db } from "../app/lib/db";

const BYRD_CUSTOMER_ID = 4;
const GOCASE_CUSTOMER_ID = 7;
const GOCASE_CONTRACT_ID = 14;
const GOCASE_ACCOUNT_NUMBER = "145462725";

async function main() {
  const byrd = await db.customer.findUnique({ where: { id: BYRD_CUSTOMER_ID } });
  const gocase = await db.customer.findUnique({ where: { id: GOCASE_CUSTOMER_ID } });
  const contract = await db.contract.findUnique({ where: { id: GOCASE_CONTRACT_ID }, select: { id: true, name: true, customerId: true, account_numbers: true } });
  if (!byrd) throw new Error("Byrd customer #4 not found");
  if (!gocase) throw new Error("Gocase customer #7 not found");
  if (!contract) throw new Error("Gocase contract #14 not found");

  console.log(`Before:`);
  console.log(`  Customer #${byrd.id}: ${byrd.display_name}  aliases=${byrd.brand_aliases}`);
  console.log(`  Customer #${gocase.id}: ${gocase.display_name}  aliases=${gocase.brand_aliases}`);
  console.log(`  Contract #${contract.id}: "${contract.name}"  customerId=${contract.customerId}  account_numbers=${contract.account_numbers}`);

  // 1. Re-link contract to Byrd
  await db.contract.update({
    where: { id: GOCASE_CONTRACT_ID },
    data: { customerId: BYRD_CUSTOMER_ID, account_numbers: JSON.stringify([GOCASE_ACCOUNT_NUMBER]) },
  });

  // 2. Move any Gocase-owned invoices to Byrd (none expected, but defensive)
  const moved = await db.invoice.updateMany({
    where: { customerId: GOCASE_CUSTOMER_ID },
    data: { customerId: BYRD_CUSTOMER_ID },
  });
  console.log(`\nMoved ${moved.count} invoices from Gocase to Byrd.`);

  // 3. Merge Gocase aliases into Byrd's brand_aliases so future invoices
  //    billed under "GOCASE INT COÖPERATIEF" still route to Byrd customer.
  const byrdAliases: string[] = byrd.brand_aliases ? JSON.parse(byrd.brand_aliases) : [];
  const gocaseAliases: string[] = gocase.brand_aliases ? JSON.parse(gocase.brand_aliases) : [];
  const merged = Array.from(new Set([...byrdAliases, ...gocaseAliases])).sort();
  await db.customer.update({
    where: { id: BYRD_CUSTOMER_ID },
    data: { brand_aliases: JSON.stringify(merged) },
  });
  console.log(`Merged aliases on Byrd: [${merged.join(", ")}]`);

  // 4. Delete the orphan Customer (cascades nothing because we already moved
  //    the contract + invoices off it).
  await db.customer.delete({ where: { id: GOCASE_CUSTOMER_ID } });
  console.log(`\nDeleted Customer #${GOCASE_CUSTOMER_ID} (Gocase).`);

  // Verify
  const after = await db.contract.findUnique({ where: { id: GOCASE_CONTRACT_ID }, select: { id: true, name: true, customerId: true, account_numbers: true } });
  console.log(`\nAfter:\n  Contract #${after?.id}: "${after?.name}"  customerId=${after?.customerId}  account_numbers=${after?.account_numbers}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

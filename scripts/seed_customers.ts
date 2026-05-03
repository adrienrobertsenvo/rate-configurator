// Create Customer rows from existing contract names and link contracts. Idempotent.
//
// Run: npx tsx scripts/seed_customers.ts
import { db } from "../app/lib/db";

interface Seed {
  name: string;          // legal entity
  code: string;          // URL slug
  display_name: string;  // UI label
  aliases: string[];     // billing-account names that route here
  matchContract: (name: string) => boolean;
}

const SEEDS: Seed[] = [
  {
    name: "ITA Shipping GmbH", code: "ita", display_name: "ITA Shipping",
    aliases: ["ITA SHIPPING GMBH"],
    matchContract: (n) => /\bITA\s+Shipping\b/i.test(n),
  },
  {
    name: "everstox GmbH", code: "everstox", display_name: "everstox",
    aliases: ["EVERSTOX GMBH"],
    matchContract: (n) => /\beverstox\b/i.test(n),
  },
  {
    name: "BA Logistics GmbH", code: "ba-logistics", display_name: "BA Logistics (benuta)",
    aliases: ["BA LOGISTICS GMBH", "BENUTA GMBH"],
    matchContract: (n) => /\bBA\s+Logistics\b/i.test(n),
  },
  {
    name: "byrd technologies Germany GmbH", code: "byrd", display_name: "Byrd",
    aliases: ["BYRD TECHNOLOGIES GERMANY GMBH"],
    matchContract: (n) => /\bbyrd\s+technologies\b/i.test(n),
  },
  {
    name: "Refurbed GmbH", code: "refurbed", display_name: "Refurbed",
    aliases: ["REFURBED GMBH"],
    matchContract: (n) => /\bRefurbed\b/i.test(n),
  },
  {
    name: "SWAP Commerce Ltd", code: "swap", display_name: "SWAP Commerce",
    aliases: ["SWAP COMMERCE LTD"],
    matchContract: () => false, // no SWAP-specific contract; their invoices fall under UK Customs Standard
  },
];

async function main() {
  for (const s of SEEDS) {
    const existing = await db.customer.findUnique({ where: { code: s.code } });
    if (existing) {
      // Refresh aliases / display_name in case we tweaked them.
      await db.customer.update({
        where: { id: existing.id },
        data: { display_name: s.display_name, brand_aliases: JSON.stringify(s.aliases) },
      });
      console.log(`updated #${existing.id} ${s.display_name}`);
    } else {
      const c = await db.customer.create({
        data: { name: s.name, code: s.code, display_name: s.display_name, brand_aliases: JSON.stringify(s.aliases) },
        select: { id: true },
      });
      console.log(`created #${c.id} ${s.display_name}`);
    }
  }

  // Link contracts to customers based on name match.
  const customers = await db.customer.findMany();
  const contracts = await db.contract.findMany({ select: { id: true, name: true, customerId: true } });
  let linked = 0;
  let alreadyLinked = 0;
  let systemContracts = 0;
  for (const c of contracts) {
    if (c.customerId) { alreadyLinked++; continue; }
    const seed = SEEDS.find((s) => s.matchContract(c.name));
    if (!seed) {
      // System / unmatched (Standard, UK Customs Standard, etc.)
      systemContracts++;
      console.log(`SYSTEM #${c.id} '${c.name}' — leaving customerId=null`);
      continue;
    }
    const cust = customers.find((cu) => cu.code === seed.code);
    if (!cust) continue;
    await db.contract.update({ where: { id: c.id }, data: { customerId: cust.id } });
    console.log(`LINK #${c.id} '${c.name}' → ${seed.display_name}`);
    linked++;
  }
  console.log(`\nlinked=${linked} already=${alreadyLinked} system=${systemContracts}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

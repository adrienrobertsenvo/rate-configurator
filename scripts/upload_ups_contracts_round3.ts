// Upload UPS contracts for two new customers — Quivo and Thomann — and a new
// version of everstox if needed. Generic: each Job describes the source files
// and the customer to attach the resulting Contract row to. Customers are
// auto-created if they don't exist.
//
// Account numbers come from the screenshots the user supplied:
//   - Quivo:   H9R702, H9R703, H9R704
//   - Thomann: 823289, 7F958Y, AY2622  (823289 is 6-char numeric, the others
//              are the typical 6-char alphanumeric — both styles need to round
//              -trip with the 10-char zero-padded form on the wire.)
//
// Run: npx tsx scripts/upload_ups_contracts_round3.ts
//      (requires .env loaded with ANTHROPIC_API_KEY)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { db } from "../app/lib/db";
import { extractContract, type ExtractedContract, type SourceFile } from "../app/lib/carriers/ups";

interface Job {
  label: string;
  files: { path: string; kind: "pdf" | "xlsx" | "csv" }[];
  customerCode: string;
  customerSeed?: { name: string; display_name: string; brand_aliases: string[] };
  contractName: string;
  accountNumbers: string[];
}

const JOBS: Job[] = [
  {
    label: "quivo-2026",
    files: [{ path: "/tmp/ups/quivo/Vertrag UPS signed.pdf", kind: "pdf" }],
    customerCode: "quivo",
    customerSeed: {
      name: "Quivo GmbH",
      display_name: "Quivo",
      brand_aliases: ["QUIVO GMBH", "QUIVO"],
    },
    contractName: "UPS Germany — Quivo 2026",
    accountNumbers: ["H9R702", "H9R703", "H9R704"],
  },
  {
    label: "thomann-2026",
    files: [
      { path: "/tmp/ups/thomann/UPS Vereinbarung 2025 (1).pdf", kind: "pdf" },
      { path: "/tmp/ups/thomann/UPS Preisliste ab 01.07.2025.xlsx", kind: "xlsx" },
    ],
    customerCode: "thomann",
    customerSeed: {
      name: "Musikhaus Thomann GmbH",
      display_name: "Thomann",
      brand_aliases: ["MUSIKHAUS THOMANN", "THOMANN GMBH", "THOMANN"],
    },
    contractName: "UPS Germany — Thomann 2025/2026",
    accountNumbers: ["823289", "7F958Y", "AY2622"],
  },
];

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function ensureCustomer(job: Job): Promise<number> {
  const existing = await db.customer.findUnique({ where: { code: job.customerCode } });
  if (existing) return existing.id;
  if (!job.customerSeed) throw new Error(`Customer "${job.customerCode}" missing and no seed provided`);
  const created = await db.customer.create({
    data: {
      code: job.customerCode,
      name: job.customerSeed.name,
      display_name: job.customerSeed.display_name,
      brand_aliases: JSON.stringify(job.customerSeed.brand_aliases),
    },
    select: { id: true },
  });
  console.log(`  + created Customer #${created.id} ${job.customerSeed.display_name} (${job.customerCode})`);
  return created.id;
}

async function saveExtracted(
  e: ExtractedContract,
  sources: SourceFile[],
  customerId: number,
  contractName: string,
  accountNumbers: string[],
): Promise<number> {
  const catalog = await db.catalogSurcharge.findMany({ where: { carrier: e.carrier } });
  const codeByNormName = new Map<string, string>();
  for (const c of catalog) codeByNormName.set(normalizeName(c.name), c.code);

  function resolveAddonCode(extractorCode: string | null, name: string): string {
    if (extractorCode && extractorCode.length <= 5) return extractorCode;
    const canonical = codeByNormName.get(normalizeName(name));
    if (canonical) return canonical;
    return extractorCode ?? `UNK-${name.slice(0, 6)}`;
  }

  const created = await db.contract.create({
    data: {
      name: contractName,
      carrier: e.carrier,
      billing_country: e.billing_country.toUpperCase(),
      currency_code: e.currency_code || "EUR",
      volumetric_divisor: e.volumetric_divisor || 5000,
      valid_from: e.valid_from,
      valid_until: e.valid_until,
      customerId,
      account_numbers: JSON.stringify(accountNumbers.sort()),
      addons: { create: e.addons.map((a) => ({
        code: resolveAddonCode(a.code ?? null, a.name),
        name: a.name, kind: a.kind, amount: a.amount,
      })) },
    },
    select: { id: true },
  });

  for (let pi = 0; pi < e.freight.length; pi++) {
    const p = e.freight[pi];
    const product = await db.freightProduct.create({
      data: { contractId: created.id, name: p.name, order: pi, zone_group: "default" },
      select: { id: true },
    });
    for (let si = 0; si < p.sub_products.length; si++) {
      const sp = p.sub_products[si];
      const sub = await db.subProduct.create({
        data: { productId: product.id, name: sp.name, description: sp.description, codes: sp.codes.length ? sp.codes.join(",") : null, order: si },
        select: { id: true },
      });
      for (const z of sp.zones) {
        let order = 0;
        for (const b of z.bands) {
          await db.priceBand.create({
            data: {
              subProductId: sub.id, zone: z.zone, order: order++,
              weight_start: b.weight_start_g, weight_end: b.weight_end_g,
              price: b.price, per_kg: b.per_kg, step: b.step_kg, confidence: b.confidence,
            },
          });
        }
      }
    }
  }

  for (const f of sources) {
    await db.contractSource.create({
      data: {
        contractId: created.id,
        filename: f.name, kind: f.kind, size_bytes: f.bytes.byteLength,
        sha256: createHash("sha256").update(f.bytes).digest("hex"),
        bytes: f.bytes,
      },
    });
  }
  return created.id;
}

async function runJob(job: Job): Promise<void> {
  console.log(`\n=== ${job.label} ===`);
  const customerId = await ensureCustomer(job);
  const sources: SourceFile[] = job.files.map(({ path, kind }) => ({
    name: path.split("/").pop()!,
    kind,
    bytes: readFileSync(path),
  }));
  for (const s of sources) console.log(`  - ${s.name} (${(s.bytes.byteLength / 1024).toFixed(1)} KB ${s.kind})`);
  const extracted = await extractContract(sources);
  console.log(`  → name="${extracted.name}"  ${extracted.carrier}  ${extracted.billing_country}/${extracted.currency_code}`);
  console.log(`  → valid: ${extracted.valid_from} → ${extracted.valid_until}`);
  console.log(`  → freight=${extracted.freight.length} surcharges=${extracted.addons.length}`);
  for (const p of extracted.freight) {
    const totalBands = p.sub_products.reduce((acc, sp) => acc + sp.zones.reduce((a2, z) => a2 + z.bands.length, 0), 0);
    console.log(`    · ${p.name} — ${p.sub_products.length} sub-product(s), ${totalBands} band(s)`);
  }
  const id = await saveExtracted(extracted, sources, customerId, job.contractName, job.accountNumbers);
  console.log(`  ✓ saved as contract #${id}`);
}

async function main() {
  for (const job of JOBS) {
    try { await runJob(job); } catch (e) { console.error(`  ✗ FAILED ${job.label}: ${(e as Error).message}`); }
  }
  await db.$disconnect();
}
main();

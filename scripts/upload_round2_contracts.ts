// Process the 3 contracts that arrived in /tmp/round2:
//   1) updated Byrd contract PDF — link to existing byrd Customer; supersedes #7
//   2) Gocase Int Coöperatief PDF — NEW customer (no aliases known yet, derive from filename)
//   3) Everstox 2026 — 2 XLSX as one contract, link to existing everstox Customer; supersedes #4
//
// We DO NOT delete the old contracts. They keep their existing invoices linked.
// The newer contracts get valid_from = a recent date; per-band valid_from /
// valid_until pin time-bound rates if needed. Run audits will use the newest
// contract for fresh invoices.
//
// Run: npx tsx scripts/upload_round2_contracts.ts
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { db } from "../app/lib/db";
import { extractContract, type ExtractedContract, type SourceFile } from "../app/lib/extract";

interface Job {
  label: string;
  files: { path: string; kind: "pdf" | "xlsx" | "csv" }[];
  customerCode: string;        // existing customer slug, OR new slug
  customerSeed?: {              // if customer doesn't exist yet, create it with this
    name: string;
    display_name: string;
    brand_aliases: string[];
  };
  contractName: string;          // override the LLM-suggested name
  zoneGroupByProduct?: Record<string, string>;
}

const JOBS: Job[] = [
  {
    label: "byrd-2026",
    files: [{ path: "/tmp/round2/byrd-contract/byrd technologies Germany GmbH_DE_100046708.pdf", kind: "pdf" }],
    customerCode: "byrd",
    contractName: "DHL Express Germany — byrd technologies Germany GmbH 2026",
    zoneGroupByProduct: defaultDhlExpressZoneGroups(),
  },
  {
    label: "gocase",
    files: [{ path: "/tmp/round2/byrd-contract/Gocase Int Coöperatief U A_DE_102980962.pdf", kind: "pdf" }],
    customerCode: "gocase",
    customerSeed: {
      name: "Gocase Int Coöperatief U.A.",
      display_name: "Gocase",
      // Variants the carrier could bill under — accents may strip in different
      // systems. We seed all plausible casings; the importer will auto-learn the
      // exact account number on first upload.
      brand_aliases: [
        "GOCASE INT COÖPERATIEF U.A.",
        "GOCASE INT COOPERATIEF U.A.",
        "GOCASE INT COÖPERATIEF U A",
        "GOCASE INT COOPERATIEF U A",
        "GOCASE",
      ],
    },
    contractName: "DHL Express Germany — Gocase Int Coöperatief U.A.",
    zoneGroupByProduct: defaultDhlExpressZoneGroups(),
  },
  {
    label: "everstox-2026",
    files: [
      { path: "/tmp/round2/everstox contracts 2026/INTERNAL_senvo_2026_DHL Express Worldwide & Economy_rates_en (1).xlsx", kind: "xlsx" },
      { path: "/tmp/round2/everstox contracts 2026/INTERNAL_senvo_2026_DHL Express Worldwide & Economy_Services & Surcharges_en (1).xlsx", kind: "xlsx" },
    ],
    customerCode: "everstox",
    contractName: "DHL Express Germany — everstox GmbH Rates 2026 (v2)",
    zoneGroupByProduct: defaultDhlExpressZoneGroups(),
  },
];

// Standard DHL Express product → zone group mapping. Worldwide products share
// one zone table, Economy shares another, Domestic uses its own.
function defaultDhlExpressZoneGroups(): Record<string, string> {
  return {
    "Express Worldwide Export":        "worldwide",
    "Express Worldwide Import":        "worldwide",
    "Express Worldwide Third Country": "worldwide",
    "Express 12:00 (Document)":        "worldwide",
    "Express 9:00 (Document)":         "worldwide",
    "Economy Select Export":           "economy",
    "Economy Select Import":           "economy",
    "Express Domestic":                "domestic",
  };
}

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
  zoneGroupByProduct: Record<string, string>,
): Promise<number> {
  const catalog = await db.catalogSurcharge.findMany({ where: { carrier: e.carrier } });
  const codeByNormName = new Map<string, string>();
  for (const c of catalog) codeByNormName.set(normalizeName(c.name), c.code);

  function resolveAddonCode(extractorCode: string | null, name: string): string {
    if (extractorCode && extractorCode.length <= 4) return extractorCode;
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
      data: { contractId: created.id, name: p.name, order: pi, zone_group: zoneGroupByProduct[p.name] ?? "default" },
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
  console.log(`  → name="${extracted.name}"  carrier=${extracted.carrier}  ${extracted.billing_country}/${extracted.currency_code}`);
  console.log(`  → valid: ${extracted.valid_from} → ${extracted.valid_until}`);
  console.log(`  → freight=${extracted.freight.length} surcharges=${extracted.addons.length}`);
  const id = await saveExtracted(extracted, sources, customerId, job.contractName, job.zoneGroupByProduct ?? {});
  console.log(`  ✓ saved contract #${id}`);
}

async function main() {
  // Run sequentially — extract.ts calls multiple LLM endpoints and we don't
  // want to hammer the API or run out of memory loading PDFs in parallel.
  for (const job of JOBS) {
    try {
      await runJob(job);
    } catch (e) {
      console.error(`  ✗ FAILED ${job.label}: ${(e as Error).message}`);
    }
  }
  await db.$disconnect();
}
main();

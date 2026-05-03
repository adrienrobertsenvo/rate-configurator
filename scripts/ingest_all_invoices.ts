// Generic invoice ingestion: walks every staged source directory, parses each
// CSV, auto-routes to the right contract via Customer.brand_aliases, and
// ingests with the original bytes persisted on the Invoice row. Idempotent
// (upsert by invoice_number).
//
// Run: npx tsx scripts/ingest_all_invoices.ts
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { createHash } from "node:crypto";
import { db } from "../app/lib/db";
import { parseDhlInvoiceCsv } from "../app/lib/carriers/dhl-express/invoice-parse";
import { computeLine, computeCustomsLine, type ContractSnapshot, type Catalog, type ZoneMaps, type TaxTable, type CatalogEntry, type Band } from "../app/lib/carriers/dhl-express/rate-engine";

const SOURCE_GLOBS = [
  "/tmp/round2/SWAP 2026/*.csv",
  "/tmp/round2/byrd 2026/*.csv",
  "/tmp/round2/everstox 2026/*.csv",
  "/tmp/round2/benuta/*.csv",
  "/tmp/dhl-archive2/*.csv",
  "/tmp/dhl-uk/*.csv",
  "/tmp/dhl-benuta/*.csv",
];

// Carrier-by-billing-source mapping. CSV billing_source column hints carrier.
const BILLING_SOURCE_TO_CARRIER: Record<string, string> = {
  "DE-TD": "DHL-EXPRESS-DE",
  "GB-TD": "DHL-EXPRESS-GB",
  "FR-TD": "DHL-EXPRESS-FR",
  // Stations: typical 3-letter codes (MUC, DUS, BER, CGN = DE; LON / AVB = GB; …)
};

interface ContractRow {
  id: number;
  carrier: string;
  billing_country: string;
  customerId: number | null;
  account_numbers: string | null;
  valid_from: string;
  valid_until: string;
  customer: { brand_aliases: string | null } | null;
}

function aliasesFor(c: ContractRow): string[] {
  if (!c.customer?.brand_aliases) return [];
  try { return JSON.parse(c.customer.brand_aliases) as string[]; } catch { return []; }
}

function accountNumbersFor(c: ContractRow): string[] {
  if (!c.account_numbers) return [];
  try { return JSON.parse(c.account_numbers) as string[]; } catch { return []; }
}

// Account number wins (precise — one DHL account → one contract). Fall back to
// the brand_alias name match for new accounts. Same-billing_country break tie.
function findContract(accountNumber: string, accountName: string, country: string, contracts: ContractRow[]): ContractRow | null {
  if (accountNumber) {
    const num = accountNumber.trim();
    const byNum = contracts.filter((c) => accountNumbersFor(c).includes(num));
    if (byNum.length) {
      return byNum.find((c) => c.billing_country === country) ?? byNum[0];
    }
  }
  if (accountName) {
    const norm = accountName.toUpperCase().trim();
    const byAlias = contracts.filter((c) => aliasesFor(c).some((a) => a.toUpperCase().trim() === norm));
    if (byAlias.length) {
      return byAlias.find((c) => c.billing_country === country) ?? byAlias[0];
    }
  }
  return null;
}

async function loadInputs(contractId: number) {
  const row = await db.contract.findUniqueOrThrow({
    where: { id: contractId },
    include: { freight: { include: { sub_products: { include: { bands: true } } } }, addons: true },
  });
  const carrier = row.carrier;
  const billing_country = row.billing_country;
  const snapshot: ContractSnapshot = {
    id: row.id, carrier, billing_country, fuel_multiplier: row.fuel_multiplier ?? 1,
    freight: row.freight.map((p) => ({
      name: p.name, zone_group: p.zone_group,
      sub_products: p.sub_products.map((sp) => {
        const zones: Record<string, Band[]> = {};
        for (const b of sp.bands) {
          if (!zones[b.zone]) zones[b.zone] = [];
          const band: Band = b.weight_end != null && b.price != null
            ? { weight_start: b.weight_start, weight_end: b.weight_end, price: b.price, valid_from: b.valid_from, valid_until: b.valid_until }
            : { weight_start: b.weight_start, per_kg: b.per_kg ?? 0, step: b.step, valid_from: b.valid_from, valid_until: b.valid_until };
          zones[b.zone].push(band);
        }
        return { id: sp.id, name: sp.name, codes: sp.codes ? sp.codes.split(",").map((c) => c.trim()) : [], zones };
      }),
    })),
    surcharges: row.addons.map((a) => ({ code: a.code, name: a.name, kind: a.kind, amount: a.amount, min_amount: a.min_amount, applies_to: a.applies_to as "any" | "domestic" | "international" })),
  };
  const [zoneMapRows, catalogRows, taxRows, catalogSurchargeRows] = await Promise.all([
    db.zoneMap.findMany({ where: { carrier: { in: [carrier, carrier.toLowerCase(), "dhl-express"] }, billing_country, OR: [{ contractId: null }, { contractId }] }, include: { countries: true } }),
    db.catalogProduct.findMany({ where: { carrier } }),
    db.taxRate.findMany({ where: { carrier } }),
    db.catalogSurcharge.findMany({ where: { carrier } }),
  ]);
  const byGroup = new Map<string, Map<string, number>>();
  for (const zm of [...zoneMapRows].sort((a, b) => (a.contractId ?? 0) - (b.contractId ?? 0))) {
    const m = byGroup.get(zm.zone_group) ?? new Map<string, number>();
    for (const c of zm.countries) m.set(c.country.toUpperCase(), c.zone);
    byGroup.set(zm.zone_group, m);
  }
  const entries = new Map<string, CatalogEntry[]>();
  for (const cr of catalogRows) {
    if (!entries.has(cr.code)) entries.set(cr.code, []);
    entries.get(cr.code)!.push({ product_name: cr.product_name, sub_product_name: cr.sub_product_name, direction: (cr.direction as "export"|"import"|"any") ?? "any" });
  }
  const surchargeNames = new Map<string, string>();
  for (const s of catalogSurchargeRows) surchargeNames.set(s.code, s.name);
  return {
    snapshot,
    catalog: { entries, surchargeNames } as Catalog,
    zoneMaps: { byGroup } as ZoneMaps,
    tax: { rateByCode: new Map(taxRows.map((r) => [r.code, r.rate])) } as TaxTable,
  };
}

async function main() {
  const contracts = await db.contract.findMany({
    select: {
      id: true, carrier: true, billing_country: true, customerId: true,
      account_numbers: true,
      valid_from: true, valid_until: true,
      customer: { select: { brand_aliases: true } },
    },
  });
  // UK Customs Standard contract — fallback for SWAP & similar customs invoices.
  const ukCustoms = contracts.find((c) => c.carrier === "DHL-EXPRESS-GB" && c.billing_country === "GB" && !c.customerId);

  const ctxCache = new Map<number, Awaited<ReturnType<typeof loadInputs>>>();
  async function getCtx(id: number) {
    let ctx = ctxCache.get(id);
    if (!ctx) { ctx = await loadInputs(id); ctxCache.set(id, ctx); }
    return ctx;
  }

  const seenInvoiceNumbers = new Set<string>();
  const paths: string[] = [];
  for (const g of SOURCE_GLOBS) for await (const p of glob(g)) paths.push(p as string);
  paths.sort();
  console.log(`Found ${paths.length} candidate CSVs across ${SOURCE_GLOBS.length} dirs.`);

  let totalInvoices = 0, totalLines = 0, totalUnrouted = 0, totalSkippedDup = 0;
  for (const path of paths) {
    const filename = path.split("/").pop()!;
    const buf = readFileSync(path);
    const sha = createHash("sha256").update(buf).digest("hex");
    let parsed;
    try { parsed = parseDhlInvoiceCsv(buf.toString("utf8")); } catch (e) { console.log(`PARSE FAIL ${filename}: ${(e as Error).message}`); continue; }

    if (seenInvoiceNumbers.has(parsed.invoice_number)) {
      totalSkippedDup++;
      continue;
    }
    seenInvoiceNumbers.add(parsed.invoice_number);

    // Pull billing account NUMBER (col 12) and NAME (col 13) from row 2.
    const headerMatch = buf.toString("utf8").split(/\r?\n/, 2)[1];
    const numAndNameMatch = /^"[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","([^"]*)","([^"]*)"/.exec(headerMatch ?? "");
    const accountNumber = numAndNameMatch?.[1] ?? "";
    const accountName = numAndNameMatch?.[2] ?? "";
    const billingCountryMatch = /^("[^"]*",){20}"([^"]*)"/.exec(headerMatch ?? "");
    const billingCountry = billingCountryMatch?.[2] ?? "DE";

    let contract = findContract(accountNumber, accountName, billingCountry, contracts);
    // Customs invoices for SWAP fall through to UK Customs Standard.
    if (!contract && parsed.invoice_type === "customs" && ukCustoms) contract = ukCustoms;
    if (!contract) {
      console.log(`UNROUTED ${parsed.invoice_number}  account=#${accountNumber} "${accountName}"  type=${parsed.invoice_type}`);
      totalUnrouted++;
      continue;
    }

    const ctx = await getCtx(contract.id);
    const isCustoms = parsed.invoice_type === "customs";

    const invoice = await db.invoice.upsert({
      where: { invoice_number: parsed.invoice_number },
      update: {
        invoice_date: parsed.invoice_date, contractId: contract.id, customerId: contract.customerId,
        currency: parsed.currency, total_excl_vat: parsed.total_excl_vat,
        invoice_type: parsed.invoice_type,
        source_filename: filename, source_size_bytes: buf.byteLength, source_sha256: sha, source_bytes: buf,
        lines: { deleteMany: {} },
      },
      create: {
        invoice_number: parsed.invoice_number, invoice_date: parsed.invoice_date,
        contractId: contract.id, customerId: contract.customerId, currency: parsed.currency,
        total_excl_vat: parsed.total_excl_vat, invoice_type: parsed.invoice_type,
        source_filename: filename, source_size_bytes: buf.byteLength, source_sha256: sha, source_bytes: buf,
      },
      select: { id: true },
    });

    let ok = 0, over = 0, under = 0, unresolved = 0;
    for (const line of parsed.lines) {
      const audit = isCustoms ? computeCustomsLine(line, ctx.snapshot) : computeLine(line, ctx.snapshot, ctx.catalog, ctx.zoneMaps, ctx.tax);
      await db.invoiceLine.create({
        data: {
          invoiceId: invoice.id,
          shipment_number: line.shipment_number, shipment_date: line.shipment_date,
          product_code: line.product_code, product_name: line.product_name,
          origin_country: line.origin_country, dest_country: line.dest_country,
          weight_kg: line.weight_kg, weight_flag: line.weight_flag,
          declared_value: line.declared_value,
          charged_amount: line.charged_amount, weight_charge: line.weight_charge,
          surcharges_json: JSON.stringify(line.surcharges),
          tax_code: line.tax_code, total_tax: line.total_tax,
          expected_amount: audit.expected_total,
          expected_weight_charge: audit.expected_weight_charge,
          expected_surcharges_json: JSON.stringify(audit.expected_surcharges),
          expected_tax: audit.expected_tax,
          delta: audit.delta, tax_delta: audit.tax_delta, surcharge_delta: audit.surcharge_delta,
          audit_status: audit.status, tax_status: audit.tax_status, surcharge_status: audit.surcharge_status,
          audit_notes: audit.notes.join("; ") || null,
          matched_product: audit.matched_product, matched_sub_product: audit.matched_sub_product,
          matched_zone: audit.matched_zone,
          matched_band_json: audit.matched_band ? JSON.stringify(audit.matched_band) : null,
        },
      });
      if (audit.status === "ok") ok++;
      else if (audit.status === "over") over++;
      else if (audit.status === "under") under++;
      else unresolved++;
    }
    totalInvoices++; totalLines += parsed.lines.length;
    if (parsed.lines.length >= 50 || over > 0 || under > 0) {
      console.log(`#${invoice.id}  ${parsed.invoice_number}  → contract #${contract.id}  ${parsed.lines.length}L  ok=${ok} over=${over} under=${under} unresolved=${unresolved}`);
    }
  }
  console.log(`\nDONE: ${totalInvoices} invoices · ${totalLines} lines · ${totalUnrouted} unrouted · ${totalSkippedDup} dup-skipped`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

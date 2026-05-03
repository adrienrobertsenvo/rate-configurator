// Ingest the 12 sample UPS invoices for everstox using the UPS carrier engine.
// Routes by account number against contract #16 (UPS-DE everstox 2026); falls
// back to brand-alias name match if not found.
//
// Run: npx tsx scripts/ingest_ups_everstox.ts
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { createHash } from "node:crypto";
import { db } from "../app/lib/db";
import { getCarrier } from "../app/lib/carriers";
import {
  parseUpsInvoiceCsv, normalizeUpsAccount, readUpsAccountNumber,
} from "../app/lib/carriers/ups";
import type { ContractSnapshot, Catalog, ZoneMaps, TaxTable, Band, CatalogEntry } from "../app/lib/carriers/dhl-express/rate-engine";

const SOURCE_GLOB = "/tmp/ups/invoices/*.csv";
const CARRIER_CODE = "UPS-DE";

async function loadContractByAccount(accountNumber: string) {
  const all = await db.contract.findMany({
    where: { carrier: CARRIER_CODE },
    select: { id: true, name: true, account_numbers: true, customerId: true },
  });
  const norm = normalizeUpsAccount(accountNumber);
  for (const c of all) {
    if (!c.account_numbers) continue;
    try {
      const accounts = JSON.parse(c.account_numbers) as string[];
      if (accounts.some((a) => normalizeUpsAccount(a) === norm)) return c;
    } catch {}
  }
  return null;
}

async function loadInputs(contractId: number): Promise<{ snapshot: ContractSnapshot; catalog: Catalog; zoneMaps: ZoneMaps; tax: TaxTable; carrier: string }> {
  const row = await db.contract.findUniqueOrThrow({
    where: { id: contractId },
    include: { freight: { include: { sub_products: { include: { bands: true } } } }, addons: true },
  });
  const carrier = row.carrier;
  const snapshot: ContractSnapshot = {
    id: row.id, carrier, billing_country: row.billing_country, fuel_multiplier: row.fuel_multiplier ?? 1,
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
    db.zoneMap.findMany({ where: { carrier: { in: [carrier, carrier.toLowerCase(), "ups"] }, billing_country: row.billing_country, OR: [{ contractId: null }, { contractId }] }, include: { countries: true } }),
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
    entries.get(cr.code)!.push({ product_name: cr.product_name, sub_product_name: cr.sub_product_name, direction: (cr.direction as "export" | "import" | "any") ?? "any" });
  }
  const surchargeNames = new Map<string, string>();
  for (const s of catalogSurchargeRows) surchargeNames.set(s.code, s.name);
  return {
    snapshot,
    catalog: { entries, surchargeNames } as Catalog,
    zoneMaps: { byGroup } as ZoneMaps,
    tax: { rateByCode: new Map(taxRows.map((r) => [r.code, r.rate])) } as TaxTable,
    carrier,
  };
}

async function main() {
  const paths: string[] = [];
  for await (const p of glob(SOURCE_GLOB)) paths.push(p as string);
  paths.sort();
  console.log(`Found ${paths.length} UPS CSVs.\n`);

  let totalInvoices = 0, totalLines = 0, totalUnrouted = 0, totalDup = 0;
  const ctxCache = new Map<number, Awaited<ReturnType<typeof loadInputs>>>();
  async function getCtx(id: number) {
    let ctx = ctxCache.get(id);
    if (!ctx) { ctx = await loadInputs(id); ctxCache.set(id, ctx); }
    return ctx;
  }

  for (const path of paths) {
    const filename = path.split("/").pop()!;
    const buf = readFileSync(path);
    const sha = createHash("sha256").update(buf).digest("hex");
    const accountRaw = readUpsAccountNumber(buf);
    if (!accountRaw) { console.log(`  ${filename}: no account number on row 1, skip`); continue; }
    const contract = await loadContractByAccount(accountRaw);
    if (!contract) {
      console.log(`  UNROUTED ${filename}  account=${accountRaw}`);
      totalUnrouted++;
      continue;
    }

    const parsed = parseUpsInvoiceCsv(buf);
    const dup = await db.invoice.findUnique({ where: { invoice_number: parsed.invoice_number }, select: { id: true } });
    if (dup) { totalDup++; continue; }

    const ctx = await getCtx(contract.id);
    const engine = getCarrier(ctx.carrier);

    const invoice = await db.invoice.create({
      data: {
        invoice_number: parsed.invoice_number,
        invoice_date: parsed.invoice_date,
        contractId: contract.id,
        customerId: contract.customerId,
        currency: parsed.currency,
        total_excl_vat: parsed.total_excl_vat,
        invoice_type: parsed.invoice_type,
        source_filename: filename,
        source_size_bytes: buf.byteLength,
        source_sha256: sha,
        source_bytes: buf,
      },
      select: { id: true },
    });

    let ok = 0, over = 0, under = 0, unresolved = 0, passthrough = 0;
    for (const line of parsed.lines) {
      const audit = parsed.invoice_type === "customs"
        ? engine.computeCustomsLine(line, ctx.snapshot)
        : engine.computeLine(line, ctx.snapshot, ctx.catalog, ctx.zoneMaps, ctx.tax);
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
      else if (audit.status === "passthrough") passthrough++;
      else unresolved++;
    }
    totalInvoices++; totalLines += parsed.lines.length;
    console.log(`  #${invoice.id} ${parsed.invoice_number}  ${parsed.lines.length}L  ok=${ok} over=${over} under=${under} unresolved=${unresolved} passthrough=${passthrough}`);
  }

  console.log(`\nDONE: ${totalInvoices} invoices · ${totalLines} lines · ${totalUnrouted} unrouted · ${totalDup} dup-skipped`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

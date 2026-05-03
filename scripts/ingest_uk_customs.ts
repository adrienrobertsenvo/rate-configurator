// Load the 6 SWAP COMMERCE UK Duty/VAT customs CSVs against contract #11
// (DHL Express UK — Customs Standard). Audits via the customs path.
//
// Run: npx tsx scripts/ingest_uk_customs.ts
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { db } from "../app/lib/db";
import { parseDhlInvoiceCsv } from "../app/lib/invoice-parse";
import {
  computeCustomsLine,
  type ContractSnapshot,
} from "../app/lib/rate-engine";

const CONTRACT_ID = 11;
const SOURCE_GLOB = "/tmp/dhl-uk/AVB*.csv";

async function loadSnapshot(contractId: number): Promise<ContractSnapshot> {
  const row = await db.contract.findUniqueOrThrow({
    where: { id: contractId },
    include: { addons: true, freight: { include: { sub_products: { include: { bands: true } } } } },
  });
  return {
    id: row.id, carrier: row.carrier, billing_country: row.billing_country,
    fuel_multiplier: row.fuel_multiplier ?? 1,
    freight: [], // customs contracts have no freight rate cards
    surcharges: row.addons.map((a) => ({
      code: a.code, name: a.name, kind: a.kind,
      amount: a.amount, min_amount: a.min_amount,
      applies_to: a.applies_to as "any" | "domestic" | "international",
    })),
  };
}

async function main() {
  const snapshot = await loadSnapshot(CONTRACT_ID);
  const paths: string[] = [];
  for await (const p of glob(SOURCE_GLOB)) paths.push(p as string);
  paths.sort();
  console.log(`Found ${paths.length} customs CSVs.`);

  for (const path of paths) {
    const csv = readFileSync(path, "utf8");
    const parsed = parseDhlInvoiceCsv(csv);
    if (parsed.invoice_type !== "customs") {
      console.log(`SKIP ${parsed.invoice_number}: invoice_type=${parsed.invoice_type} (not customs)`);
      continue;
    }
    const invoice = await db.invoice.upsert({
      where: { invoice_number: parsed.invoice_number },
      update: {
        invoice_date: parsed.invoice_date, contractId: CONTRACT_ID,
        currency: parsed.currency, total_excl_vat: parsed.total_excl_vat,
        invoice_type: parsed.invoice_type,
        lines: { deleteMany: {} },
      },
      create: {
        invoice_number: parsed.invoice_number, invoice_date: parsed.invoice_date,
        contractId: CONTRACT_ID, currency: parsed.currency,
        total_excl_vat: parsed.total_excl_vat, invoice_type: parsed.invoice_type,
      },
      select: { id: true },
    });

    let ok = 0, over = 0, under = 0, unresolved = 0;
    for (const line of parsed.lines) {
      const audit = computeCustomsLine(line, snapshot);
      await db.invoiceLine.create({
        data: {
          invoiceId: invoice.id,
          shipment_number: line.shipment_number,
          shipment_date: line.shipment_date,
          product_code: line.product_code,
          product_name: line.product_name,
          origin_country: line.origin_country,
          dest_country: line.dest_country,
          weight_kg: line.weight_kg,
          weight_flag: line.weight_flag,
          declared_value: line.declared_value,
          charged_amount: line.charged_amount,
          weight_charge: line.weight_charge,
          surcharges_json: JSON.stringify(line.surcharges),
          tax_code: line.tax_code,
          total_tax: line.total_tax,
          expected_amount: audit.expected_total,
          expected_weight_charge: audit.expected_weight_charge,
          expected_surcharges_json: JSON.stringify(audit.expected_surcharges),
          expected_tax: audit.expected_tax,
          delta: audit.delta,
          tax_delta: audit.tax_delta,
          surcharge_delta: audit.surcharge_delta,
          audit_status: audit.status,
          tax_status: audit.tax_status,
          surcharge_status: audit.surcharge_status,
          audit_notes: audit.notes.join("; ") || null,
          matched_product: audit.matched_product,
          matched_sub_product: audit.matched_sub_product,
          matched_zone: audit.matched_zone,
          matched_band_json: audit.matched_band ? JSON.stringify(audit.matched_band) : null,
        },
      });
      if (audit.status === "ok") ok++;
      else if (audit.status === "over") over++;
      else if (audit.status === "under") under++;
      else unresolved++;
    }
    console.log(`${parsed.invoice_number}  ${parsed.lines.length} lines  ok=${ok} over=${over} under=${under} unresolved=${unresolved}`);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

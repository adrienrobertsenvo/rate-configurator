// Smoke test for the UPS billing-CSV parser. Reads each sample invoice file,
// reports the parsed shape, surfaces anything weird so we can iterate without
// committing to a DB ingest yet.
//
// Run: npx tsx scripts/smoke_ups_parser.ts
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { parseUpsInvoiceCsv, normalizeUpsAccount, readUpsAccountNumber } from "../app/lib/carriers/ups/invoice-parse";

async function main() {
  const paths: string[] = [];
  for await (const p of glob("/tmp/ups/invoices/*.csv")) paths.push(p as string);
  paths.sort();

  let totalShipments = 0, totalCharges = 0;
  const codeCounts = new Map<string, number>();

  for (const p of paths) {
    const buf = readFileSync(p);
    const account_raw = readUpsAccountNumber(buf);
    const account = account_raw ? normalizeUpsAccount(account_raw) : null;
    let parsed;
    try { parsed = parseUpsInvoiceCsv(buf); } catch (e) { console.log(`PARSE FAIL ${p}: ${(e as Error).message}`); continue; }

    const f = p.split("/").pop()!;
    console.log(`\n=== ${f} ===`);
    console.log(`  invoice ${parsed.invoice_number}  date=${parsed.invoice_date}  ${parsed.currency}  total=${parsed.total_excl_vat?.toFixed(2)}`);
    console.log(`  account ${account_raw} → ${account}    ${parsed.lines.length} shipment(s)    type=${parsed.invoice_type}`);

    totalShipments += parsed.lines.length;
    for (const line of parsed.lines) {
      totalCharges += line.surcharges.length + 1;
      for (const s of line.surcharges) codeCounts.set(s.code, (codeCounts.get(s.code) ?? 0) + 1);
    }

    // Show first 2 shipments per file for spot-checking
    for (const line of parsed.lines.slice(0, 2)) {
      const surchargeStr = line.surcharges.map((s) => `${s.code}=${s.charge.toFixed(2)}`).join(" ");
      console.log(
        `    ${line.shipment_number}  ${line.product_code} ${line.product_name}  ` +
        `${line.origin_country}→${line.dest_country}  ${line.weight_kg?.toFixed(2)}kg  zone=${(line as { zone?: string }).zone ?? "?"}` +
        `  WC=${line.weight_charge?.toFixed(2) ?? "—"}  tax=${line.total_tax?.toFixed(2) ?? "—"}  total=${line.charged_amount?.toFixed(2)}`
      );
      if (surchargeStr) console.log(`        surcharges: ${surchargeStr}`);
    }
  }

  console.log(`\n=== Totals ===`);
  console.log(`  files: ${paths.length}`);
  console.log(`  shipments: ${totalShipments}`);
  console.log(`  charge rows: ${totalCharges}`);
  console.log(`\n  Surcharge code frequency:`);
  for (const [code, n] of [...codeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${code}  ${n}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

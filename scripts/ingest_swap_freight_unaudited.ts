// Ingest SWAP COMMERCE freight CSVs as customer-only invoices (contractId=NULL)
// so they're browsable + downloadable until the SWAP DHL Express contract
// arrives. No audit verdicts get computed — every line ends up audit_status=
// "no_contract". When a contract eventually lands, we re-attach + re-audit.
//
// Run: npx tsx scripts/ingest_swap_freight_unaudited.ts
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { createHash } from "node:crypto";
import { db } from "../app/lib/db";
import { parseDhlInvoiceCsv } from "../app/lib/invoice-parse";

const SWAP_CUSTOMER_CODE = "swap";
const SWAP_FREIGHT_GLOBS = [
  "/tmp/round2/SWAP 2026/*.csv",
];

// Same row-2 column position used by the bulk ingester. Captures (account#,
// account name, billing country) so we can record the account number into a
// custom invoice note even without a contract attached.
const ROW2_RE = /^"[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","[^"]*","([^"]*)","([^"]*)"/;

async function main() {
  const swap = await db.customer.findUnique({ where: { code: SWAP_CUSTOMER_CODE }, select: { id: true } });
  if (!swap) throw new Error(`Customer "${SWAP_CUSTOMER_CODE}" not found — run scripts/seed_customers.ts first`);

  const paths: string[] = [];
  for (const g of SWAP_FREIGHT_GLOBS) for await (const p of glob(g)) paths.push(p as string);
  paths.sort();
  console.log(`Found ${paths.length} candidate CSVs.`);

  const seen = new Set<string>();
  let totalInvoices = 0, totalLines = 0, totalSkippedDup = 0, totalNotSwap = 0;

  for (const path of paths) {
    const filename = path.split("/").pop()!;
    const buf = readFileSync(path);
    const text = buf.toString("utf8");

    // Verify the CSV is actually for SWAP (defensive — the dir might mix tenants).
    const row2 = text.split(/\r?\n/, 2)[1];
    const m = ROW2_RE.exec(row2 ?? "");
    const accountName = (m?.[2] ?? "").trim().toUpperCase();
    if (!accountName.includes("SWAP")) { totalNotSwap++; continue; }

    let parsed;
    try { parsed = parseDhlInvoiceCsv(text); } catch (e) { console.log(`PARSE FAIL ${filename}: ${(e as Error).message}`); continue; }

    // Skip customs invoices — those are routed via UK Customs Standard #11.
    if (parsed.invoice_type === "customs") { continue; }

    if (seen.has(parsed.invoice_number)) { totalSkippedDup++; continue; }
    seen.add(parsed.invoice_number);

    // Already loaded somewhere?
    const existing = await db.invoice.findUnique({ where: { invoice_number: parsed.invoice_number }, select: { id: true, contractId: true } });
    if (existing) {
      // If we hadn't routed it before but now we want to attach to SWAP customer
      // (still no contract), update the row in place.
      if (existing.contractId == null) {
        // Already customer-less; nothing to change unless we want to backfill
        // bytes. Skip for idempotency.
      }
      continue;
    }

    const sha = createHash("sha256").update(buf).digest("hex");
    const invoice = await db.invoice.create({
      data: {
        invoice_number: parsed.invoice_number,
        invoice_date: parsed.invoice_date,
        contractId: null,           // ← customer-only, no contract yet
        customerId: swap.id,        // ← scopes the invoice to the SWAP customer
        currency: parsed.currency,
        total_excl_vat: parsed.total_excl_vat,
        invoice_type: parsed.invoice_type,
        source_filename: filename, source_size_bytes: buf.byteLength, source_sha256: sha, source_bytes: buf,
      },
      select: { id: true },
    });

    // Stash every line with audit_status="no_contract" so the UI can show
    // "pending audit" instead of pretending the line passed.
    for (const line of parsed.lines) {
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
          audit_status: "no_contract",
          audit_notes: "Stored without contract — customer SWAP Commerce has no DHL Express contract loaded yet.",
        },
      });
    }
    totalInvoices++; totalLines += parsed.lines.length;
  }

  // The customer needs an explicit "scoped" link for the /invoices?customer=swap
  // filter to find these. The filter is: contract.customerId = swap.id. With
  // contractId=NULL, the where clause `{ contract: { is: { OR: [...] } } }` won't
  // match. So we ALSO need to teach the page to show customer-attached invoices
  // even when contract is null. That's a one-line page edit, which I'll do in a
  // follow-up — but mark these invoices first.
  //
  // Workaround for now: add a simple "ownerCustomerId" column? Too invasive.
  // Instead: set the invoice's contract via a placeholder system contract? Also
  // invasive. We'll fix the page query to OR-in "no contract" invoices when the
  // customer scope is explicit.

  console.log(`\nDONE: ${totalInvoices} new invoices · ${totalLines} lines · ${totalSkippedDup} dup-skipped · ${totalNotSwap} not-SWAP`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

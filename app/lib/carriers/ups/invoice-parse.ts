// UPS billing-data CSV parser — "Forwarding Data Dictionary V5" format.
//
// Source spec: /tmp/ups/docs-forwarding_data_dictionary.xls (951 rows
// describing every column). Cross-validated against everstox sample invoices.
//
// Format characteristics that make this fundamentally different from DHL:
//
//   1. NO HEADER ROW. Every row is data — fixed column positions per the spec.
//   2. ROW-PER-CHARGE, not row-per-shipment. A shipment is reconstructed by
//      grouping rows on Tracking Number (col 21). Each row carries its own
//      Charge Classification (col 44 — FRT / ACC / FSC / TAX / INF / MSC / EXM)
//      with its own Net Amount (col 53). To audit a shipment we collect all
//      charge rows that share its tracking number.
//   3. LATIN-1 ENCODED. German umlauts ("Treibstoffzuschläge") fail as UTF-8.
//      We let the caller pass the file as a Buffer and decode it here.
//   4. Account numbers are 10-char alphanumeric WITH leading zeros (e.g.
//      "00000FV384"). The user-facing form strips those zeros — "0FV384". We
//      surface BOTH so the routing/account-match layer can compare either way.
//   5. Pricing columns:
//        col 49 = Basis Value (the base the charge is computed against; for
//                 FSC this is the freight base, for EVS the declared value)
//        col 52 = Incentive Amount (list/published price BEFORE incentives)
//        col 53 = Net Amount (the actual amount billed)
//      Discount = col 52 - col 53 = the contractual reduction.
//
// We map UPS shipments onto the existing carrier-agnostic ParsedShipmentRow
// shape so the rest of the audit pipeline works unchanged. Shipments fall
// into one of two invoice_type buckets:
//   - "freight" (default — has FRT charge type)
//   - "customs" (a shipment whose charges are dominated by F/D / GOV /
//                duties — no FRT row but has BRK/F-D rows). UPS doesn't have
//                a Z-product analog like DHL; the same shipment may carry a
//                duties charge alongside the freight one.

import type { ParsedShipmentRow } from "../dhl-express/invoice-parse";
import type { ParsedInvoice } from "../types";

// 1-indexed column positions per the forwarding data dictionary.
const COL = {
  VERSION: 1,
  RECIPIENT_NUMBER: 2,
  ACCOUNT_NUMBER: 3,
  ACCOUNT_COUNTRY: 4,
  INVOICE_DATE: 5,
  INVOICE_NUMBER: 6,
  INVOICE_TYPE_CODE: 7,         // "E" export/domestic, "I" import
  INVOICE_TYPE_DETAIL_CODE: 8,
  INVOICE_CURRENCY: 10,
  INVOICE_AMOUNT: 11,
  TRANSACTION_DATE: 12,
  LEAD_SHIPMENT_NUMBER: 14,
  PACKAGE_QUANTITY: 19,
  TRACKING_NUMBER: 21,
  ENTERED_WEIGHT: 27,
  ENTERED_WEIGHT_UOM: 28,
  BILLED_WEIGHT: 29,
  BILLED_WEIGHT_UOM: 30,
  PACKAGE_DIMENSIONS: 33,
  ZONE: 34,
  CHARGE_CATEGORY_CODE: 35,           // SHP / RTN / MIS / ADJ
  CHARGE_CATEGORY_DETAIL_CODE: 36,
  CHARGE_CLASSIFICATION_CODE: 44,     // FRT / ACC / FSC / TAX / INF / MSC / EXM
  CHARGE_DESCRIPTION_CODE: 45,        // 011, 069, RES, EVS, FSC, …
  CHARGE_DESCRIPTION: 46,
  CHARGED_UNIT_QUANTITY: 47,
  BASIS_VALUE: 49,                    // base for fuel/declared-value calc
  INCENTIVE_AMOUNT: 52,               // list price (before discount)
  NET_AMOUNT: 53,                     // actual billed
  SENDER_CITY: 71,
  SENDER_POSTAL: 73,
  SENDER_COUNTRY: 74,
  RECEIVER_CITY: 79,
  RECEIVER_POSTAL: 81,
  RECEIVER_COUNTRY: 82,
} as const;

// Decode latin-1 buffers safely — TextDecoder("latin1") works in Node + browser.
function decodeLatin1(input: Buffer | Uint8Array | string): string {
  if (typeof input === "string") return input;
  return new TextDecoder("latin1").decode(input);
}

// Minimal CSV row splitter. UPS files use straight commas with quoted fields
// for values that legitimately contain a comma (e.g. addresses). We don't have
// embedded newlines per row in the spec, so a one-row-at-a-time split is enough.
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else cur += ch;
    } else if (ch === ",") {
      out.push(cur); cur = "";
    } else if (ch === '"' && cur === "") {
      inQuote = true;
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// Pull a 1-indexed column from a row, default empty string. Handles the wide
// rows (~210 columns) that have lots of trailing empties.
function col(row: string[], n: number): string {
  return (row[n - 1] ?? "").trim();
}

function num(s: string): number | null {
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Strip the up-to-5 leading zeros UPS pads account numbers with on the wire.
// Match against the user-facing short form ("0FV384") that the UI shows.
export function normalizeUpsAccount(raw: string): string {
  return raw.replace(/^0+/, "");
}

interface ChargeRow {
  classification: string;     // FRT / ACC / FSC / TAX / INF / MSC / EXM
  code: string;               // e.g. "069" (service) or "RES" (surcharge)
  description: string;
  basis_value: number;        // base for fuel/declared/etc.
  incentive: number;          // list/published price
  net: number;                // actual billed
  units: number;              // Charged Unit Quantity
}

interface UpsShipment {
  tracking: string;
  service_code: string;
  service_name: string;
  ship_date: string | null;
  origin_country: string | null;
  dest_country: string | null;
  package_quantity: number | null;
  entered_weight_kg: number | null;
  billed_weight_kg: number | null;
  package_dimensions: string | null;
  zone: string | null;
  charges: ChargeRow[];
}

// Convert UoM to kg. UPS ships use 'K' (kg) or 'L' (lbs) typically.
function toKg(v: number | null, uom: string): number | null {
  if (v == null) return null;
  const u = uom.toUpperCase();
  if (u === "K" || u === "KG") return v;
  if (u === "L" || u === "LB" || u === "LBS") return v * 0.453592;
  return v;
}

export function parseUpsInvoiceCsv(input: Buffer | Uint8Array | string): ParsedInvoice {
  const text = decodeLatin1(input);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error("UPS CSV is empty");

  // Invoice header values are repeated on every row — read them off row 0.
  const first = splitCsvLine(lines[0]);
  const invoice_number = col(first, COL.INVOICE_NUMBER);
  const invoice_date = col(first, COL.INVOICE_DATE);
  const currency = col(first, COL.INVOICE_CURRENCY) || "EUR";
  const total_excl_vat = num(col(first, COL.INVOICE_AMOUNT));

  // Group every charge row by tracking number. Some rows (MSC, late-fee) have
  // no tracking number — those are invoice-level extras; we collect them under
  // a synthetic "_invoice_" bucket and surface them as a pseudo-shipment so
  // their dollar amounts roll up into analytics rather than vanishing.
  const byTracking = new Map<string, UpsShipment>();
  const invoiceLevel: ChargeRow[] = [];

  for (const raw of lines) {
    const r = splitCsvLine(raw);
    const tracking = col(r, COL.TRACKING_NUMBER);
    const charge: ChargeRow = {
      classification: col(r, COL.CHARGE_CLASSIFICATION_CODE),
      code: col(r, COL.CHARGE_DESCRIPTION_CODE),
      description: col(r, COL.CHARGE_DESCRIPTION),
      basis_value: num(col(r, COL.BASIS_VALUE)) ?? 0,
      incentive: num(col(r, COL.INCENTIVE_AMOUNT)) ?? 0,
      net: num(col(r, COL.NET_AMOUNT)) ?? 0,
      units: num(col(r, COL.CHARGED_UNIT_QUANTITY)) ?? 0,
    };
    if (!tracking) {
      invoiceLevel.push(charge);
      continue;
    }

    let ship = byTracking.get(tracking);
    if (!ship) {
      ship = {
        tracking,
        service_code: "",
        service_name: "",
        ship_date: null,
        origin_country: null,
        dest_country: null,
        package_quantity: null,
        entered_weight_kg: null,
        billed_weight_kg: null,
        package_dimensions: null,
        zone: null,
        charges: [],
      };
      byTracking.set(tracking, ship);
    }
    // Shipment-level fields: take the first non-empty value across all rows
    // for this tracking number. UPS doesn't populate every column on every
    // row — typically only the FRT row has weight/zone/country fields, while
    // ACC/FSC rows leave them blank. So we can't capture once on first-seen.
    if (!ship.ship_date)        ship.ship_date        = col(r, COL.TRANSACTION_DATE) || null;
    if (!ship.origin_country)   ship.origin_country   = col(r, COL.SENDER_COUNTRY) || null;
    if (!ship.dest_country)     ship.dest_country     = col(r, COL.RECEIVER_COUNTRY) || null;
    if (ship.package_quantity == null) ship.package_quantity = num(col(r, COL.PACKAGE_QUANTITY));
    if (ship.entered_weight_kg == null) {
      const w = num(col(r, COL.ENTERED_WEIGHT));
      const kg = toKg(w, col(r, COL.ENTERED_WEIGHT_UOM));
      if (kg != null && kg > 0) ship.entered_weight_kg = kg;
    }
    if (ship.billed_weight_kg == null) {
      const w = num(col(r, COL.BILLED_WEIGHT));
      const kg = toKg(w, col(r, COL.BILLED_WEIGHT_UOM));
      if (kg != null && kg > 0) ship.billed_weight_kg = kg;
    }
    if (!ship.package_dimensions) ship.package_dimensions = col(r, COL.PACKAGE_DIMENSIONS) || null;
    if (!ship.zone)             ship.zone              = col(r, COL.ZONE) || null;
    // Service code (col 45 on a FRT row) doubles as the product code. INF rows
    // also carry it but with $0 net. Prefer FRT, fall back to INF.
    if (charge.classification === "FRT" && !ship.service_code) {
      ship.service_code = charge.code;
      ship.service_name = charge.description;
    } else if (charge.classification === "INF" && !ship.service_code) {
      ship.service_code = charge.code;
      ship.service_name = charge.description;
    }
    ship.charges.push(charge);
  }

  // Convert each grouped shipment to the carrier-agnostic ParsedShipmentRow.
  // The audit engine expects a single `weight_charge` (FRT total) plus a list
  // of surcharges. We collapse the multi-row UPS structure into that shape:
  //   - FRT row → weight_charge
  //   - FSC + ACC rows → surcharges array (real money the customer pays)
  //   - TAX rows → total_tax (excluded from surcharges to avoid double-counting)
  //   - INF rows → dropped (informational only — they have $0 net amount and
  //     duplicate the FRT service code, which would inflate the surcharge list)
  //   - EXM rows → dropped (exemption/adjustment metadata, not real charges)
  //   - MSC rows → kept on the synthetic invoice-level pseudo-shipment when
  //     they're not associated with a tracking number; otherwise included as
  //     a surcharge.
  const shipmentRows: ParsedShipmentRow[] = [];
  for (const ship of byTracking.values()) {
    const frt = ship.charges.find((c) => c.classification === "FRT");
    const charged_amount = ship.charges
      .filter((c) => c.classification !== "INF" && c.classification !== "EXM")
      .reduce((acc, c) => acc + c.net, 0);
    const surcharges = ship.charges
      .filter((c) =>
        c.classification !== "FRT"   // already accounted as weight_charge
        && c.classification !== "TAX" // already accounted as total_tax
        && c.classification !== "INF" // informational, $0
        && c.classification !== "EXM" // exemption metadata, not a real charge
      )
      .map((c) => ({
        code: c.code || c.classification,
        name: c.description || c.classification,
        charge: c.net,
      }));

    const taxRows = ship.charges.filter((c) => c.classification === "TAX");
    const total_tax = taxRows.reduce((acc, c) => acc + c.net, 0) || null;
    const tax_code = taxRows[0]?.code || null;

    shipmentRows.push({
      shipment_number: ship.tracking,
      shipment_date: ship.ship_date,
      product_code: ship.service_code,
      product_name: ship.service_name,
      origin_country: ship.origin_country,
      dest_country: ship.dest_country,
      weight_kg: ship.billed_weight_kg ?? ship.entered_weight_kg,
      weight_flag: ship.billed_weight_kg && ship.entered_weight_kg && ship.billed_weight_kg > ship.entered_weight_kg ? "V" : null,
      declared_value: null,
      charged_amount,
      weight_charge: frt?.net ?? null,
      surcharges,
      tax_code,
      total_tax,
      zone: ship.zone,
      package_quantity: ship.package_quantity,
    });
  }

  // Surface invoice-level charges (MSC weekly/daily service fees, late fees)
  // as a synthetic pseudo-shipment so their dollar amounts roll up into the
  // analytics. Without this, MSC-only invoices look empty.
  if (invoiceLevel.length > 0 && invoiceLevel.some((c) => c.net !== 0)) {
    const total = invoiceLevel.reduce((acc, c) => acc + c.net, 0);
    shipmentRows.push({
      shipment_number: `INV-${invoice_number}`,
      shipment_date: invoice_date,
      product_code: "INV",      // synthetic — distinguishes invoice-level from real shipments
      product_name: "Invoice-level fees",
      origin_country: null,
      dest_country: null,
      weight_kg: null,
      weight_flag: null,
      declared_value: null,
      charged_amount: total,
      weight_charge: null,
      surcharges: invoiceLevel
        .filter((c) => c.classification !== "TAX" && c.classification !== "INF" && c.classification !== "EXM")
        .map((c) => ({
          code: c.code || c.classification,
          name: c.description || c.classification,
          charge: c.net,
        })),
      tax_code: null,
      total_tax: null,
    });
  }

  // Heuristic: treat the invoice as "customs" only if EVERY shipment has zero
  // FRT and at least one ACC F/D row. UPS doesn't separate customs into its
  // own invoice the way DHL does — most invoices mix freight + customs charges.
  // Rather than getting clever here we default to "freight"; the engine
  // handles the F/D row as a regular accessorial.
  const invoice_type: "freight" | "customs" = "freight";

  return {
    invoice_number,
    invoice_date,
    currency,
    total_excl_vat,
    invoice_type,
    lines: shipmentRows,
  };
}

// Pull the BILLING ACCOUNT NUMBER off any row of an invoice — used by the
// upload pipeline for routing. Accepts the 10-char form ("00000FV384"); the
// caller can optionally normalize via normalizeUpsAccount.
export function readUpsAccountNumber(input: Buffer | Uint8Array | string): string | null {
  const text = decodeLatin1(input);
  const first = text.split(/\r?\n/, 1)[0];
  if (!first) return null;
  const r = splitCsvLine(first);
  return col(r, COL.ACCOUNT_NUMBER) || null;
}

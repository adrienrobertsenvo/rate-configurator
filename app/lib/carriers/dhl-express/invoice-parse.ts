import Papa from "papaparse";

export interface ParsedShipmentRow {
  shipment_number: string | null;
  shipment_date: string | null;
  product_code: string | null;
  product_name: string | null;
  origin_country: string | null;
  dest_country: string | null;
  weight_kg: number | null;
  weight_flag: string | null;
  declared_value: number | null;
  charged_amount: number | null;
  weight_charge: number | null;
  surcharges: { code: string; name: string; charge: number }[];
  tax_code: string | null;
  total_tax: number | null;
  // Carrier-stamped zone, when the invoice CSV ships one. UPS populates this
  // (column 34 of the billing CSV); DHL doesn't — DHL's audit derives the
  // zone from destination country at audit time. Optional so downstream code
  // keeps working for carriers that don't supply it.
  zone?: string | null;
}

export interface ParsedInvoice {
  invoice_number: string;
  invoice_date: string;
  currency: string;
  total_excl_vat: number | null;
  // "freight" for standard rate-card invoices (Invoice Type "R" or empty),
  // "customs" for UK Duty/VAT import-clearance invoices.
  invoice_type: "freight" | "customs";
  lines: ParsedShipmentRow[];
}

function numOrNull(v: string | undefined | null): number | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Detect the decimal separator format. German invoices: "1.234,56"; UK/US: "1,234.56".
  // The last "." or "," is the decimal separator; the other is the thousands separator.
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let normalized: string;
  if (lastDot === -1 && lastComma === -1) {
    normalized = s;
  } else if (lastComma > lastDot) {
    // Comma is decimal (German). Strip dots, swap comma for dot.
    normalized = s.replace(/\./g, "").replace(",", ".");
  } else {
    // Dot is decimal (UK/US). Strip commas (thousands).
    normalized = s.replace(/,/g, "");
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: string | undefined | null): string | null {
  if (!v) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function formatDate(s: string | undefined | null): string | null {
  if (!s) return null;
  const raw = s.trim();
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return raw;
}

export function parseDhlInvoiceCsv(csv: string): ParsedInvoice {
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  const rows = parsed.data;
  if (rows.length === 0) throw new Error("Invoice CSV is empty");

  const header = rows[0];
  const invoice_number = strOrNull(header["Invoice Number"]) ?? "";
  const invoice_date = formatDate(header["Invoice Date"]) ?? "";
  const currency = strOrNull(header["Currency"]) ?? "EUR";
  const total_excl_vat = numOrNull(header["Total amount (excl. VAT)"]);
  // DHL puts "UK Duty/VAT" (and similar) in the "Invoice Type" column on
  // customs/clearance invoices; standard freight invoices use "R".
  const invoice_type_raw = (strOrNull(header["Invoice Type"]) ?? "").toLowerCase();
  const invoice_type: "freight" | "customs" =
    invoice_type_raw.includes("duty") || invoice_type_raw.includes("vat") || invoice_type_raw.includes("customs")
      ? "customs"
      : "freight";

  if (!invoice_number) throw new Error('Invoice CSV: "Invoice Number" column missing or empty on first row');

  const lines: ParsedShipmentRow[] = [];
  for (const row of rows) {
    if (row["Line Type"] !== "S") continue;

    const surcharges: { code: string; name: string; charge: number }[] = [];
    // Standard freight CSVs ship XC1–XC9; UK Duty/VAT customs CSVs extend to XC11.
    // We iterate up to 11 — extra columns just won't exist on smaller CSVs.
    for (let i = 1; i <= 11; i++) {
      const code = strOrNull(row[`XC${i} Code`]);
      const name = strOrNull(row[`XC${i} Name`]);
      const charge = numOrNull(row[`XC${i} Charge`]);
      if (code && name && charge != null && code !== "0") {
        surcharges.push({ code, name, charge });
      }
    }

    // Declared value: DHL CSVs use either "Customs Value", "Insured Value",
    // or "Shipment Value" — try in that order. Returns null if none present.
    const declared_value =
      numOrNull(row["Customs Value"]) ??
      numOrNull(row["Insured Value"]) ??
      numOrNull(row["Shipment Value"]) ??
      numOrNull(row["Declared Value"]);

    lines.push({
      shipment_number: strOrNull(row["Shipment Number"]),
      shipment_date: formatDate(row["Shipment Date"]),
      product_code: strOrNull(row["Product"]),
      product_name: strOrNull(row["Product Name"]),
      origin_country: strOrNull(row["Orig Country Code"]),
      dest_country: strOrNull(row["Dest Country Code"]),
      weight_kg: numOrNull(row["Weight (kg)"]),
      weight_flag: strOrNull(row["Weight Flag"]),
      declared_value,
      charged_amount: numOrNull(row["Total amount (excl. VAT)"]),
      weight_charge: numOrNull(row["Weight Charge"]),
      surcharges,
      tax_code: strOrNull(row["Tax Code"]),
      total_tax: numOrNull(row["Total Tax"]),
    });
  }

  return { invoice_number, invoice_date, currency, total_excl_vat, invoice_type, lines };
}

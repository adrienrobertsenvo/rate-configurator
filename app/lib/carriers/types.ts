// Cross-carrier interface — the minimum surface every carrier engine must
// expose for the shared audit pipeline (uploadInvoice, rerunAudit, the bulk
// ingester) to work without knowing which carrier a contract is for.
//
// Carriers are pluggable: add a new module under `app/lib/carriers/<name>/`,
// implement this interface, register it in `index.ts`, and the rest of the
// app routes invoices to it automatically based on Contract.carrier.
//
// Anything that's INHERENTLY single-carrier (e.g. the Rules page documenting
// DHL's fuel formula, the demand-surcharge sync button) can keep importing
// directly from `carriers/dhl-express/` — those UI surfaces wouldn't make
// sense generalised. The registry only abstracts the audit hot path.

import type { ParsedShipmentRow } from "./dhl-express/invoice-parse";
import type {
  ContractSnapshot, Catalog, ZoneMaps, TaxTable, EngineResult,
} from "./dhl-express/rate-engine";

// Re-exported here so callers don't reach into a specific carrier's folder.
// Each carrier MUST use these types as the input/output shape so audits are
// comparable across carriers. If a carrier needs additional fields, extend
// the type rather than diverging.
export type { ParsedShipmentRow, ContractSnapshot, Catalog, ZoneMaps, TaxTable, EngineResult };

export interface ParsedInvoice {
  invoice_number: string;
  invoice_date: string;
  currency: string;
  total_excl_vat: number | null;
  invoice_type: "freight" | "customs";
  lines: ParsedShipmentRow[];
}

export interface CarrierEngine {
  // Stable identifier surfaced in logs and the contract.carrier column.
  code: string;
  // Friendly name for the UI (e.g. "DHL Express", "UPS").
  display_name: string;

  // Parse a raw CSV (or other format) into the carrier-agnostic shipment shape.
  parseInvoiceCsv(text: string): ParsedInvoice;

  // Audit a freight (regular) shipment line against the contract.
  computeLine(
    line: ParsedShipmentRow,
    contract: ContractSnapshot,
    catalog: Catalog,
    zoneMaps: ZoneMaps,
    tax: TaxTable,
  ): EngineResult;

  // Audit a customs / pass-through invoice line. Carriers without a customs
  // product can throw or return a no-op result.
  computeCustomsLine(
    line: ParsedShipmentRow,
    contract: ContractSnapshot,
  ): EngineResult;
}

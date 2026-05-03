// UPS carrier engine — bundles the UPS-specific parser + audit logic into a
// CarrierEngine object that the registry can dispatch to. First-cut scope:
// freight audit works against rate cards loaded into the existing schema;
// fuel surcharge and per-surcharge audits are placeholders until the fuel
// rate publication and contract surcharge rules are wired up.

import type { CarrierEngine, ParsedInvoice } from "../types";
import { parseUpsInvoiceCsv } from "./invoice-parse";
import { computeUpsLine, computeUpsCustomsLine } from "./rate-engine";

export const ups: CarrierEngine = {
  code: "UPS",
  display_name: "UPS",
  // The carrier interface gives the parser a `string`. Our parser handles
  // both string and Buffer (latin-1 decode happens inside) — but at this
  // entry point we always get a string passed by the upload action.
  parseInvoiceCsv(text: string): ParsedInvoice { return parseUpsInvoiceCsv(text); },
  computeLine: computeUpsLine,
  computeCustomsLine: computeUpsCustomsLine,
};

export { parseUpsInvoiceCsv, normalizeUpsAccount, readUpsAccountNumber } from "./invoice-parse";
export * from "./surcharge-meta";
export * from "./rate-engine";

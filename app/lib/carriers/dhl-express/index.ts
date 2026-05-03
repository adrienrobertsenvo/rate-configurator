// DHL Express carrier engine — bundles the carrier-specific math, surcharge
// catalog, fuel rates, demand surcharge, and CSV parser into a single object
// that satisfies the shared CarrierEngine interface.
//
// Direct imports from `carriers/dhl-express/<file>` still work for UI surfaces
// that are inherently DHL-specific (Rules page, simulator). The registry path
// (`getCarrier(code)`) is reserved for the audit pipeline that needs to be
// carrier-agnostic.

import type { CarrierEngine } from "../types";
import { parseDhlInvoiceCsv } from "./invoice-parse";
import { computeLine, computeCustomsLine } from "./rate-engine";

export const dhlExpress: CarrierEngine = {
  code: "DHL-EXPRESS",
  display_name: "DHL Express",
  parseInvoiceCsv: parseDhlInvoiceCsv,
  computeLine,
  computeCustomsLine,
};

// Re-export the per-module API so consumers can `import { ... } from
// "../lib/carriers/dhl-express"` without reaching into individual files.
// Lets us reorganise internal files later without breaking imports.
export * from "./rate-engine";
export * from "./invoice-parse";
export * from "./surcharge-meta";
export * from "./fuel-rates";
export * from "./demand-surcharge";
export * from "./region-map";

// Carrier registry — maps Contract.carrier (and any aliases) to a
// CarrierEngine. The audit pipeline calls `getCarrier(code)` to dispatch
// without knowing which carrier the invoice came from.
//
// Adding a new carrier:
//   1) Implement the CarrierEngine interface under `app/lib/carriers/<name>/`
//   2) Register the engine here against every billing-country / variant code
//      that appears in Contract.carrier (e.g. "UPS-DE", "UPS-GB", "ups").
//   3) Done. Upload, re-audit, ingest all dispatch automatically.

import type { CarrierEngine } from "./types";
import { dhlExpress } from "./dhl-express";

// Every Contract.carrier value the audit pipeline might see. The values are
// historical — DHL contracts came in with country-suffixed codes; lower-case
// `dhl-express` is the system-baseline tag. New carriers should pick a
// consistent code style (UPPER-CASE with country suffix recommended).
const REGISTRY: Record<string, CarrierEngine> = {
  "DHL-EXPRESS-DE": dhlExpress,
  "DHL-EXPRESS-GB": dhlExpress,
  "DHL-EXPRESS-FR": dhlExpress,
  "dhl-express":    dhlExpress,
};

// Resolve a carrier code to its engine. Falls back to DHL Express for unknown
// codes — current behaviour preservation; once a second carrier exists, this
// should throw instead so unknown carriers fail loudly at upload time.
export function getCarrier(code: string | null | undefined): CarrierEngine {
  if (!code) return dhlExpress;
  return REGISTRY[code] ?? REGISTRY[code.toUpperCase()] ?? REGISTRY[code.toLowerCase()] ?? dhlExpress;
}

// Diagnostics — used by an admin page or smoke test to confirm what's registered.
export function listCarriers(): { code: string; display_name: string }[] {
  const seen = new Set<CarrierEngine>();
  const out: { code: string; display_name: string }[] = [];
  for (const engine of Object.values(REGISTRY)) {
    if (seen.has(engine)) continue;
    seen.add(engine);
    out.push({ code: engine.code, display_name: engine.display_name });
  }
  return out;
}

export type { CarrierEngine, ParsedInvoice, ParsedShipmentRow, ContractSnapshot, Catalog, ZoneMaps, TaxTable, EngineResult } from "./types";

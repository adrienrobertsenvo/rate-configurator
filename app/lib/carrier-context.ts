// Helper for the global ?carrier= URL param. Used by every page that
// embeds Nav. Returns a normalized "all" | "dhl" | "ups" string and a
// pre-built Prisma where-clause-fragment that filters by Contract.carrier
// (or by the relation through .contract for tables like Invoice / ZoneMap).

export type CarrierFilter = "all" | "dhl" | "ups";

export function resolveCarrier(param: string | undefined | null): CarrierFilter {
  if (param === "dhl" || param === "ups") return param;
  return "all";
}

// Carrier prefix to match against Contract.carrier column.
//   - DHL contracts: "DHL-EXPRESS-DE", "DHL-EXPRESS-GB", "DHL-EXPRESS-FR",
//     "dhl-express" (system-baseline tag, lowercase)
//   - UPS contracts: "UPS-DE", "UPS-GB", "UPS-FR", "ups"
// We use case-insensitive matching via Prisma's `mode: "insensitive"` so
// the lowercase tag works the same as the uppercase ones.
export function carrierPrefixes(filter: CarrierFilter): string[] | null {
  if (filter === "dhl") return ["DHL-EXPRESS", "dhl-express"];
  if (filter === "ups") return ["UPS-", "ups"];
  return null;
}

// Build a Prisma where clause for Contract rows. Returns {} when no filter.
export function contractCarrierWhere(filter: CarrierFilter) {
  const prefixes = carrierPrefixes(filter);
  if (!prefixes) return {};
  return { OR: prefixes.map((p) => ({ carrier: { startsWith: p } })) };
}

// Build a Prisma where clause for any table with `contractId` related to
// Contract (Invoice, ZoneMap, etc.). Returns {} when no filter.
export function viaContractCarrierWhere(filter: CarrierFilter) {
  const prefixes = carrierPrefixes(filter);
  if (!prefixes) return {};
  return { contract: { OR: prefixes.map((p) => ({ carrier: { startsWith: p } })) } };
}

// Build a Prisma where for catalog tables that have a direct `carrier` column
// (CatalogProduct, CatalogSurcharge, TaxRate). Returns {} when no filter.
export function directCarrierWhere(filter: CarrierFilter) {
  const prefixes = carrierPrefixes(filter);
  if (!prefixes) return {};
  return { OR: prefixes.map((p) => ({ carrier: { startsWith: p } })) };
}

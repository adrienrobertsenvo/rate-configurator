// DHL (and some carrier ERPs) occasionally bill under non-ISO-2 country codes.
// Map them to the canonical ISO-2 so zone-map lookups succeed without polluting
// every contract's zone map with duplicate rows.
//
// Add new entries here when an audit surfaces them as "no zone mapping for
// destination 'XX'" — keep the right side as the ISO-2 the contract zone map
// actually uses.

export const COUNTRY_ALIASES: Record<string, string> = {
  KV: "XK", // Kosovo — DHL Express uses KV internally; ISO-2 is XK
};

export function resolveCountryCode(raw: string | null | undefined): string {
  if (!raw) return "";
  const upper = raw.toUpperCase().trim();
  return COUNTRY_ALIASES[upper] ?? upper;
}

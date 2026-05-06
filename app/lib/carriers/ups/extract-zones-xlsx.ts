// Extract country → zone mappings from the UPS rate-card XLSX. Each rate
// sheet has German country names listed in cells D5:N19 (or similar) above
// the "Market" / "Zone" header rows. Each column groups several countries
// under a single zone label. We aggregate one mapping per sheet, normalize
// German names → ISO-2 codes, and emit a ZoneMap-shaped output.
//
// Authoritative source for "what country maps to what zone in this contract"
// — reads thousands of country-name cells in seconds, no LLM cost.

import * as XLSX from "xlsx";

interface CountryZoneEntry {
  country: string; // ISO-2
  zone: string;    // contract zone label, e.g. "Zone 5"
}

export interface ParsedZoneSheet {
  sheet_name: string;
  product_name: string;
  movement: "Sending" | "Receiving" | "unknown";
  entries: CountryZoneEntry[];
  unrecognized: string[];   // names we couldn't map (for the operator to fix)
}

// Tiny inline atlas — covers what UPS DE rate cards typically list. Names are
// LOWER-CASE, accents stripped, parentheticals removed before matching. Add
// to this map when the unrecognized list reports new spellings.
const ALIASES = new Map<string, string>(Object.entries({
  // DE-direct
  "deutschland": "DE",
  // EU
  "belgien": "BE", "daenemark": "DK", "frankreich": "FR", "italien": "IT",
  "luxemburg": "LU", "monaco": "MC", "niederlande": "NL", "oesterreich": "AT",
  "polen": "PL", "tschech rep": "CZ", "tschechische republik": "CZ",
  "finnland": "FI", "griechenland": "GR", "irland": "IE", "nordirland": "IE",
  "portugal": "PT", "schweden": "SE", "spanien": "ES",
  "azoren und madeira": "PT", "kanarische inseln": "ES",
  "ceuta und melilla": "ES", "azoren": "PT", "madeira": "PT",
  "kroatien": "HR", "slow rep": "SK", "slowakei": "SK", "slowenien": "SI",
  "estland": "EE", "lettland": "LV", "litauen": "LT",
  "ungarn": "HU", "rumaenien": "RO", "bulgarien": "BG",
  "malta": "MT", "zypern": "CY", "schweiz": "CH", "norwegen": "NO",
  "liechtenstein": "LI", "gibraltar": "GI", "san marino": "SM",
  "andorra": "AD", "vatikan": "VA",
  // UK
  "gb": "GB", "england": "GB", "schottland": "GB", "wales": "GB",
  "guernsey": "GG", "jersey": "JE", "isle of man": "IM",
  // Eastern Europe / Caucasus / CIS
  "albanien": "AL", "armenien": "AM", "aserbaidschan": "AZ", "weissrussland": "BY",
  "bosnien-herz": "BA", "bosnien herzegowina": "BA", "georgien": "GE", "island": "IS",
  "kasachstan": "KZ", "kirgistan": "KG", "kosovo": "XK", "mazedonien": "MK",
  "moldawien": "MD", "moldau": "MD", "montenegro": "ME",
  "russland": "RU", "serbien": "RS", "tuerkei": "TR", "ukraine": "UA",
  "tadschikistan": "TJ", "turkmenistan": "TM", "usbekistan": "UZ",
  // Africa
  "aegypten": "EG", "marokko": "MA", "tunesien": "TN", "algerien": "DZ", "libyen": "LY",
  "ghana": "GH", "kenia": "KE", "kongo": "CG", "kongo dem rep": "CD",
  "mauritius": "MU", "namibia": "NA", "nigeria": "NG", "senegal": "SN",
  "suedafrika": "ZA", "sudan": "SD", "tansania": "TZ", "uganda": "UG",
  "kamerun": "CM", "elfenbeinkueste": "CI", "aethiopien": "ET",
  "mauretanien": "MR", "malawi": "MW", "gambia": "GM", "saint helena": "SH",
  "ruanda": "RW", "burundi": "BI", "lesotho": "LS", "swasiland": "SZ", "eswatini": "SZ",
  "guinea": "GN", "guinea bissau": "GW", "liberia": "LR", "mosambik": "MZ",
  "niger": "NE", "togo": "TG", "tschad": "TD", "zentralafrikan rep": "CF",
  "kap verde": "CV", "kapverden": "CV", "djibouti": "DJ", "gabun": "GA",
  // Middle East
  "afghanistan": "AF", "irak": "IQ", "iran": "IR", "israel": "IL",
  "jordanien": "JO", "kuwait": "KW", "katar": "QA", "libanon": "LB",
  "oman": "OM", "saudi-arabien": "SA", "syrien": "SY",
  "ver arab emirate": "AE", "vereinigte arabische emirate": "AE",
  "bahrain": "BH", "jemen": "YE", "palaestina": "PS",
  // Asia
  "china": "CN", "hongkong": "HK", "macau": "MO", "indien": "IN",
  "indonesien": "ID", "japan": "JP", "kambodscha": "KH", "korea": "KR",
  "suedkorea": "KR", "nordkorea": "KP", "laos": "LA",
  "malaysia": "MY", "myanmar": "MM", "nepal": "NP", "pakistan": "PK",
  "philippinen": "PH", "singapur": "SG", "sri lanka": "LK", "taiwan": "TW",
  "thailand": "TH", "vietnam": "VN", "bangladesch": "BD", "bhutan": "BT",
  "brunei": "BN", "kambodja": "KH", "malediven": "MV", "mongolei": "MN",
  // Oceania
  "australien": "AU", "neuseeland": "NZ", "neukaledonien": "NC",
  "papua-neuguinea": "PG", "fidschi": "FJ", "samoa": "WS",
  "samoa amer": "AS", "samoa-inseln amer": "AS", "tahiti": "PF",
  "saipan": "MP", "vanuatu": "VU",
  // Americas
  "kanada": "CA", "usa": "US", "mexiko": "MX", "argentinien": "AR",
  "bolivien": "BO", "brasilien": "BR", "chile": "CL", "kolumbien": "CO",
  "ecuador": "EC", "guatemala": "GT", "guyana": "GY", "honduras": "HN",
  "panama": "PA", "paraguay": "PY", "peru": "PE", "puerto rico": "PR",
  "uruguay": "UY", "venezuela": "VE", "bahamas": "BS", "barbados": "BB",
  "bermuda": "BM", "costa rica": "CR", "dominik republik": "DO",
  "el salvador": "SV", "franz guyana": "GF", "jamaika": "JM",
  "kuba": "CU", "nicaragua": "NI", "trinidad u tobago": "TT",
  "guadeloupe": "GP", "martinique": "MQ",
  "st kitts-nevis": "KN", "st lucia": "LC", "st vincent": "VC",
  "haiti": "HT", "kaiman inseln": "KY", "kaymaninseln": "KY",
  "antigua": "AG", "anguilla": "AI", "aruba": "AW",
  // Misc
  "gambia jordanien kenia": "GM",  // multi-line rendering hack — first wins
  "kambodscha laos": "KH",
  "libanon malawi malediven": "LB",
  "marokko mauretanien": "MA",
  "myanmar nepal": "MM",
  "senegal tahiti": "SN",
  "sri lanka surinam": "LK",
  "sambia": "ZM", "simbabwe": "ZW",
}));

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[äÄ]/g, "ae")
    .replace(/[öÖ]/g, "oe")
    .replace(/[üÜ]/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[À-ſ]/g, "")
    .replace(/[\(\)\.\,\*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lookupCountry(rawName: string): string | null {
  if (!rawName || rawName.length < 2) return null;
  const norm = normalize(rawName);
  return ALIASES.get(norm) ?? null;
}

function asString(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

export function parseZoneSheet(ws: XLSX.WorkSheet, sheetName: string): ParsedZoneSheet | null {
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null }) as unknown[][];

  // Locate the Zone-label row (col A or B == "Zone").
  let zoneRowIdx = -1;
  for (let i = 0; i < grid.length; i++) {
    const a = asString(grid[i][0]).toLowerCase();
    const b = asString(grid[i][1]).toLowerCase();
    if (a === "zone" || b === "zone") { zoneRowIdx = i; break; }
  }
  if (zoneRowIdx < 0) return null;

  // Service name + movement.
  const serviceRow = grid.find((r) => asString(r[0]).toLowerCase().startsWith("service"));
  const product_name = asString(serviceRow?.[3] ?? "Unknown");
  const movementRow = grid.find((r) => asString(r[0]).toLowerCase().startsWith("movement"));
  const movementText = asString(movementRow?.[3] ?? "");
  const movement: ParsedZoneSheet["movement"] =
    /sending/i.test(movementText) ? "Sending" :
    /receiving/i.test(movementText) ? "Receiving" : "unknown";

  // Country lists live in rows BEFORE the Zone row, columns D onwards (index 3+).
  // Each column may span multiple rows for one zone (countries spill down).
  const zoneRow = grid[zoneRowIdx];
  const zoneCols: { col: number; label: string }[] = [];
  for (let c = 3; c < zoneRow.length; c++) {
    const lbl = asString(zoneRow[c]);
    if (lbl && /zone\s+\w+/i.test(lbl)) zoneCols.push({ col: c, label: lbl });
  }

  const entries: CountryZoneEntry[] = [];
  const unrecognized = new Set<string>();
  const seen = new Set<string>();

  // Country rows are anywhere from row 5 to zoneRowIdx-1. Walk every cell in
  // that range and try to identify country names.
  for (let r = 4; r < zoneRowIdx; r++) {
    const row = grid[r] ?? [];
    for (const { col, label } of zoneCols) {
      const cell = asString(row[col]);
      if (!cell) continue;
      // Cells can carry multiple countries on one line (rare) — split on
      // commas just in case. Strip *, parentheticals, GB sub-regions ("England,").
      const fragments = cell.split(/[,;]/).map((s) => s.trim()).filter((s) => s.length > 0);
      for (const frag of fragments) {
        const iso = lookupCountry(frag);
        if (iso) {
          const key = `${iso}|${label}`;
          if (!seen.has(key)) {
            entries.push({ country: iso, zone: label });
            seen.add(key);
          }
        } else if (frag.length >= 4 && /[a-z]/i.test(frag)) {
          unrecognized.add(frag);
        }
      }
    }
  }
  if (entries.length === 0) return null;
  return { sheet_name: sheetName, product_name, movement, entries, unrecognized: [...unrecognized].sort() };
}

export function parseUpsZonesXlsx(buf: Buffer): ParsedZoneSheet[] {
  const wb = XLSX.read(buf, { type: "buffer" });
  const out: ParsedZoneSheet[] = [];
  for (const name of wb.SheetNames) {
    const parsed = parseZoneSheet(wb.Sheets[name], name);
    if (parsed) out.push(parsed);
  }
  return out;
}

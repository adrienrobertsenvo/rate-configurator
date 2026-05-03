// Pull country→zone tables from existing contract XLSX sources and dump them
// to CSV under prisma/seed-data/, so the user can spot-check before they're
// applied to the DB.
//
// Sources used:
//   - contract #9 (Refurbed FR)        sheet "FR Zones TDI Exp+Imp" → zones-fr-worldwide.csv
//   - contract #12 (BA Logistics 2026) sheet "DE Zones DDI Exp+Imp" → zones-de-economy.csv
//
// Run: npx tsx scripts/extract_zones_from_xlsx.ts
import * as XLSX from "xlsx";
import { writeFileSync } from "node:fs";
import { db } from "../app/lib/db";

interface Job {
  contractId: number;
  sheetName: string;
  outFile: string;
  label: string;
}

const JOBS: Job[] = [
  {
    contractId: 9,
    sheetName: "FR Zones TDI Exp+Imp",
    outFile: "prisma/seed-data/zones-fr-worldwide.csv",
    label: "FR worldwide (from Refurbed FR contract)",
  },
  {
    contractId: 12,
    sheetName: "DE Zones DDI Exp+Imp",
    outFile: "prisma/seed-data/zones-de-economy.csv",
    label: "DE economy (from BA Logistics 2026 contract)",
  },
];

// DHL zone sheets typically use this layout (from the Refurbed/BA samples):
//
//   row 0:  TIME DEFINITE
//   row 1:  DHL Express France / Germany
//   row 2:  Customer: …
//   row 3:  (blank)
//   row 4:  Zone Country/Territory headers — one column per zone group, with
//           "Country / Territory" label and zone number across multiple cols.
//
// In practice the cleanest way is: scan all cells, find rows where col A is a
// non-empty string and col B is a numeric zone (1-10). That covers every layout
// variant we've seen.

interface CountryRow { country: string; iso: string; zone: number }

function loadCountryAliases(): Map<string, string> {
  // Best-effort name→ISO code map. Built ad-hoc to match the country names that
  // appear in DHL zone sheets. Anything not in here will be flagged for the
  // user during the apply step.
  return new Map(Object.entries({
    "afghanistan": "AF", "albania": "AL", "algeria": "DZ", "american samoa": "AS",
    "andorra": "AD", "angola": "AO", "anguilla": "AI", "antigua": "AG",
    "antigua and barbuda": "AG", "argentina": "AR", "armenia": "AM", "aruba": "AW",
    "australia": "AU", "austria": "AT", "azerbaijan": "AZ", "bahamas": "BS",
    "bahrain": "BH", "bangladesh": "BD", "barbados": "BB", "belarus": "BY",
    "belgium": "BE", "belize": "BZ", "benin": "BJ", "bermuda": "BM",
    "bhutan": "BT", "bolivia": "BO", "bonaire": "BQ", "bosnia and herzegovina": "BA",
    "bosnia & herzegovina": "BA", "botswana": "BW", "brazil": "BR", "brunei": "BN",
    "brunei darussalam": "BN", "bulgaria": "BG", "burkina faso": "BF", "burundi": "BI",
    "cambodia": "KH", "cameroon": "CM", "canada": "CA", "canary islands": "IC",
    "cape verde": "CV", "cayman islands": "KY", "central african republic": "CF",
    "central african rep": "CF", "chad": "TD", "chile": "CL",
    "china": "CN", "china (people's republic)": "CN", "china (peoples republic)": "CN",
    "colombia": "CO", "commonwealth northern mariana islands": "MP",
    "northern mariana islands": "MP", "comoros": "KM", "congo": "CG",
    "congo (democratic republic)": "CD", "congo democratic republic": "CD",
    "congo dpr": "CD", "cook islands": "CK", "costa rica": "CR",
    "cote d'ivoire": "CI", "côte d'ivoire": "CI", "ivory coast": "CI",
    "croatia": "HR", "cuba": "CU", "curacao": "CW", "curaçao": "CW",
    "cyprus": "CY", "czech republic": "CZ", "czech rep": "CZ", "czechia": "CZ",
    "denmark": "DK", "djibouti": "DJ", "dominica": "DM", "dominican republic": "DO",
    "dominican rep": "DO", "east timor": "TL", "timor-leste": "TL",
    "ecuador": "EC", "egypt": "EG", "el salvador": "SV", "eritrea": "ER",
    "estonia": "EE", "eswatini": "SZ", "swaziland": "SZ", "ethiopia": "ET",
    "falkland islands": "FK", "faroe islands": "FO", "fiji": "FJ",
    "finland": "FI", "france": "FR", "french guyana": "GF", "french guiana": "GF",
    "french polynesia": "PF", "tahiti": "PF", "tahiti (french polynesia)": "PF",
    "gabon": "GA", "gambia": "GM", "georgia": "GE", "germany": "DE",
    "ghana": "GH", "gibraltar": "GI", "greece": "GR", "greenland": "GL",
    "grenada": "GD", "guadeloupe": "GP", "guam": "GU", "guatemala": "GT",
    "guernsey": "GG", "guinea": "GN", "guinea rep": "GN",
    "guinea-bissau": "GW", "guinea bissau": "GW",
    "equatorial guinea": "GQ", "guinea-equatorial": "GQ",
    "guyana": "GY", "haiti": "HT", "honduras": "HN", "hong kong": "HK",
    "hungary": "HU", "iceland": "IS", "india": "IN", "indonesia": "ID",
    "iran": "IR", "iraq": "IQ", "ireland": "IE", "isle of man": "IM",
    "israel": "IL", "italy": "IT", "jamaica": "JM", "japan": "JP", "jersey": "JE",
    "jordan": "JO", "kazakhstan": "KZ", "kenya": "KE", "kiribati": "KI",
    "korea republic of (south)": "KR", "korea rep": "KR", "korea, republic of": "KR",
    "south korea": "KR", "korea democratic peoples republic of (north)": "KP",
    "korea d.p.r": "KP", "north korea": "KP",
    "kosovo": "XK", "kuwait": "KW", "kyrgyzstan": "KG", "laos": "LA",
    "latvia": "LV", "lebanon": "LB", "lesotho": "LS", "liberia": "LR",
    "libya": "LY", "liechtenstein": "LI", "lithuania": "LT", "luxembourg": "LU",
    "macau": "MO", "macao": "MO", "macedonia": "MK", "macedonia (north macedonia)": "MK",
    "north macedonia": "MK", "madagascar": "MG", "malawi": "MW", "malaysia": "MY",
    "maldives": "MV", "mali": "ML", "malta": "MT", "marshall islands": "MH",
    "martinique": "MQ", "mauritania": "MR", "mauritius": "MU", "mayotte": "YT",
    "mexico": "MX", "micronesia": "FM", "moldova": "MD", "monaco": "MC",
    "mongolia": "MN", "montenegro": "ME", "montserrat": "MS", "morocco": "MA",
    "mozambique": "MZ", "myanmar": "MM", "namibia": "NA", "nauru": "NR",
    "nepal": "NP", "netherlands": "NL", "new caledonia": "NC", "new zealand": "NZ",
    "nicaragua": "NI", "niger": "NE", "nigeria": "NG", "niue": "NU",
    "norway": "NO", "oman": "OM", "pakistan": "PK", "palau": "PW",
    "palestine": "PS", "palestinian territory": "PS",
    "panama": "PA", "papua new guinea": "PG", "paraguay": "PY", "peru": "PE",
    "philippines": "PH", "poland": "PL", "portugal": "PT", "puerto rico": "PR",
    "qatar": "QA", "reunion": "RE", "réunion": "RE",
    "romania": "RO", "russia": "RU", "russian federation": "RU",
    "rwanda": "RW", "samoa": "WS", "san marino": "SM",
    "sao tome and principe": "ST", "são tomé and príncipe": "ST", "sao tome": "ST",
    "saudi arabia": "SA", "senegal": "SN", "serbia": "RS", "seychelles": "SC",
    "sierra leone": "SL", "singapore": "SG", "slovakia": "SK", "slovenia": "SI",
    "solomon islands": "SB", "somalia": "SO", "somaliland": "XS",
    "south africa": "ZA", "south sudan": "SS", "spain": "ES", "sri lanka": "LK",
    "saint barthelemy": "BL", "st. barthélemy": "BL",
    "saint eustatius": "BQ", "st. eustatius": "BQ",
    "saint kitts": "KN", "st. kitts": "KN", "saint kitts and nevis": "KN", "nevis": "KN",
    "saint lucia": "LC", "st. lucia": "LC", "saint maarten": "SX", "st. maarten": "SX",
    "saint vincent": "VC", "st. vincent": "VC", "saint vincent and the grenadines": "VC",
    "sudan": "SD", "suriname": "SR", "sweden": "SE", "switzerland": "CH",
    "syria": "SY", "taiwan": "TW", "tajikistan": "TJ", "tanzania": "TZ",
    "thailand": "TH", "togo": "TG", "tonga": "TO", "trinidad and tobago": "TT",
    "tunisia": "TN", "turkey": "TR", "turkmenistan": "TM",
    "turks and caicos islands": "TC", "turks & caicos": "TC",
    "tuvalu": "TV", "uganda": "UG", "ukraine": "UA",
    "united arab emirates": "AE", "uae": "AE",
    "united kingdom": "GB", "uk": "GB",
    "united states": "US", "united states of america": "US", "usa": "US",
    "uruguay": "UY", "uzbekistan": "UZ", "vanuatu": "VU",
    "vatican city": "VA", "vatican city state": "VA", "vatican": "VA",
    "venezuela": "VE", "vietnam": "VN",
    "british virgin islands": "VG", "virgin islands-british": "VG", "virgin islands (british)": "VG",
    "united states virgin islands": "VI", "us virgin islands": "VI", "u.s. virgin islands": "VI",
    "yemen": "YE", "zambia": "ZM", "zimbabwe": "ZW",

    // Variants seen in real DHL sheets (long form / abbreviations)
    "canary islands, the": "IC", "china, peoples republic": "CN",
    "china, people's republic": "CN", "china, peoples republic of": "CN",
    "commonwealth no. mariana islands": "MP", "no. mariana islands": "MP",
    "congo, the democratic republic of": "CD", "cote d ivoire": "CI",
    "czech rep., the": "CZ", "czech republic, the": "CZ",
    "dominican republic, the": "DO", "gambia, the": "GM",
    "korea, dem. people's republic of": "KP", "korea, democratic peoples republic of": "KP",
    "korea, republic of (south)": "KR", "korea republic of": "KR",
    "former yugoslav republic of macedonia": "MK",
    "vatican city state": "VA", "moldova, republic of": "MD",
    "russian federation, the": "RU", "tanzania, united republic of": "TZ",
    "united kingdom of great britain and northern ireland": "GB",
    "venezuela, bolivarian republic of": "VE",
    "viet nam": "VN", "lao people's democratic republic": "LA",
    "syrian arab republic": "SY", "iran, islamic republic of": "IR",
    "burma": "MM", "swaziland (eswatini)": "SZ",
    "wallis and futuna": "WF", "western sahara": "EH",
    "guinea republic": "GN", "guyana (british)": "GY",
    "iran (islamic republic of)": "IR", "ireland, republic of": "IE",
    "korea, republic of (south k.)": "KR", "korea, democratic peoples republic of (north k.)": "KP",
    "marianas, northern (commonwealth of)": "MP", "syria (syrian arab republic)": "SY",
    "tanzania (united republic of)": "TZ", "venezuela (bolivarian republic of)": "VE",
    "bolivia (plurinational state of)": "BO", "macedonia (former yugoslav republic of)": "MK",
    "moldova (republic of)": "MD", "lao (people's democratic republic of)": "LA",
    "sao tome & principe": "ST", "trinidad & tobago": "TT",
    "antigua & barbuda": "AG", "bosnia & herzegovina": "BA",
    "turks & caicos islands": "TC", "u.s.a.": "US",
    "u.s. (united states)": "US", "viet nam (socialist republic of)": "VN",

    // German names (DE Economy zone sheet)
    "albanien": "AL", "belgien": "BE", "bosnien und herzegowina": "BA",
    "bulgarien": "BG", "estland": "EE", "finnland": "FI", "frankreich": "FR",
    "griechenland": "GR", "großbritannien": "GB", "grossbritannien": "GB",
    "vereinigtes königreich": "GB", "vereinigtes koenigreich": "GB",
    "irland": "IE", "italien": "IT", "kroatien": "HR", "lettland": "LV",
    "litauen": "LT", "luxemburg": "LU", "malta": "MT",
    "mazedonien": "MK", "nordmazedonien": "MK", "republik nordmazedonien": "MK",
    "montenegro": "ME", "niederlande": "NL", "norwegen": "NO",
    "österreich": "AT", "oesterreich": "AT",
    "polen": "PL", "portugal": "PT", "rumänien": "RO", "rumaenien": "RO",
    "san marino": "SM", "schweden": "SE", "schweiz": "CH",
    "serbien": "RS", "slowakei": "SK", "slowenien": "SI",
    "spanien": "ES", "tschechien": "CZ", "tschechische republik": "CZ",
    "türkei": "TR", "tuerkei": "TR", "ukraine": "UA", "ungarn": "HU",
    "vatikanstadt": "VA", "weißrussland": "BY", "weissrussland": "BY",
    "zypern": "CY", "deutschland": "DE", "färöer": "FO", "faeroeer": "FO",
    "färöer-inseln": "FO", "färöer inseln": "FO",
    "isle of man": "IM", "andorra": "AD", "monaco": "MC",
    "kosovo": "XK", "moldau": "MD", "moldawien": "MD",
    "russland": "RU", "russische föderation": "RU",
    "armenien": "AM", "aserbaidschan": "AZ", "georgien": "GE",
    "gibraltar": "GI", "grönland": "GL", "groenland": "GL",
    "island": "IS", "kanarische inseln": "IC",
  }));
}

function normalizeName(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

function extractZoneTable(buf: Buffer, sheetName: string, aliases: Map<string, string>): { rows: CountryRow[]; unknown: string[] } {
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`sheet "${sheetName}" not found in workbook (sheets: ${wb.SheetNames.join(", ")})`);
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false }) as unknown[][];

  // Walk every row. If we find a string in any cell that resolves to an ISO,
  // and an integer 1-10 in the SAME row (or in the cell directly to its right),
  // record it as a (country, zone) pair. This is robust against the multi-column
  // layouts DHL uses ("Country | Zone | <empty> | Country | Zone | …").
  const seen = new Map<string, number>();
  const unknown = new Set<string>();
  for (const row of grid) {
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (typeof cell !== "string") continue;
      const name = cell.trim();
      if (!name || name.length < 3) continue;
      const iso = aliases.get(normalizeName(name));
      if (!iso) {
        // Only flag long-ish strings to skip header words and fragments.
        if (name.length >= 4 && /^[A-Za-z][A-Za-z .'()&,/-]+$/.test(name)) unknown.add(name);
        continue;
      }
      // Probe the next 4 cells looking for a zone integer 1-10.
      for (let off = 1; off <= 4; off++) {
        const v = row[c + off];
        const n = typeof v === "number" ? v : Number(v);
        if (Number.isInteger(n) && n >= 1 && n <= 12) {
          if (!seen.has(iso)) seen.set(iso, n);
          break;
        }
      }
    }
  }

  // Pair ISO back with a canonical name for the CSV. Use a reverse lookup that
  // takes the FIRST alias name registered for each ISO.
  const isoToName = new Map<string, string>();
  for (const [name, iso] of aliases) if (!isoToName.has(iso)) isoToName.set(iso, properCase(name));
  const rows: CountryRow[] = Array.from(seen).map(([iso, zone]) => ({ iso, country: isoToName.get(iso) ?? iso, zone }))
    .sort((a, b) => a.country.localeCompare(b.country));
  return { rows, unknown: Array.from(unknown).sort() };
}

function properCase(s: string): string {
  return s.split(" ").map((w) => w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)).join(" ");
}

async function main() {
  const aliases = loadCountryAliases();
  for (const job of JOBS) {
    console.log(`\n=== ${job.label} ===`);
    const sources = await db.contractSource.findMany({
      where: { contractId: job.contractId, kind: "xlsx" },
      select: { filename: true, bytes: true },
    });
    if (sources.length === 0) { console.log(`  no XLSX sources for contract #${job.contractId}`); continue; }
    let extracted: { rows: CountryRow[]; unknown: string[] } | null = null;
    for (const s of sources) {
      if (!s.bytes) continue;
      try {
        extracted = extractZoneTable(Buffer.from(s.bytes as Uint8Array), job.sheetName, aliases);
        console.log(`  found ${extracted.rows.length} countries in "${job.sheetName}" of ${s.filename}`);
        break;
      } catch (e) {
        console.log(`  skip ${s.filename}: ${(e as Error).message}`);
      }
    }
    if (!extracted) { console.log(`  ✗ couldn't extract`); continue; }

    const csv = ["country,iso,zone,note"];
    for (const r of extracted.rows) csv.push(`${csvEsc(r.country)},${r.iso},${r.zone},`);
    writeFileSync(job.outFile, csv.join("\n") + "\n");
    console.log(`  ✓ wrote ${job.outFile}`);
    if (extracted.unknown.length) {
      console.log(`  ⚠ ${extracted.unknown.length} string cells weren't matched to an ISO code; sample:`);
      for (const u of extracted.unknown.slice(0, 8)) console.log(`      "${u}"`);
    }
    // Distribution check
    const dist = new Map<number, number>();
    for (const r of extracted.rows) dist.set(r.zone, (dist.get(r.zone) ?? 0) + 1);
    const distStr = Array.from(dist).sort((a, b) => a[0] - b[0]).map(([z, n]) => `z${z}:${n}`).join(" ");
    console.log(`  zones: ${distStr}`);
  }
  await db.$disconnect();
}

function csvEsc(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

main().catch((e) => { console.error(e); process.exit(1); });

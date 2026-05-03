// Country → DHL "demand surcharge region" mapping. The published demand
// surcharge matrix groups countries into 7 regions; we route audit lookups
// through this map to find the correct EUR/kg rate for a shipment.
//
// Source: https://www.dhl.de/en/geschaeftskunden/express/produkte-und-services/zuschlaege.html#demand-surcharge
//
// Categories:
//   "CN-HK"  — China and Hong Kong (also Macau as a practical extension)
//   "SAS"    — South Asia (India, Pakistan, Bangladesh, …)
//   "ROA"    — Rest of Asia (rest of E/SE Asia)
//   "OCE"    — Oceania (AU, NZ, Pacific Islands)
//   "EUR"    — Europe (EU + UK + Switzerland + Norway etc.)
//   "AMS"    — Americas (NA + LATAM)
//   "MENA"   — Middle East and North Africa
//   "ROW"    — Rest of World (everything else, mainly Sub-Saharan Africa + a few others)
//
// We default any unmapped ISO to ROW. Doing so matches DHL's catch-all behavior
// in the matrix.

export type DemandRegion = "CN-HK" | "SAS" | "ROA" | "OCE" | "EUR" | "AMS" | "MENA" | "ROW";

const REGION_BY_ISO: Record<string, DemandRegion> = {
  // China & Hong Kong (and Macau, which DHL groups with HK in operations)
  CN: "CN-HK", HK: "CN-HK", MO: "CN-HK",

  // South Asia — DHL convention: Indian subcontinent + Bhutan/Nepal/Maldives
  IN: "SAS", PK: "SAS", BD: "SAS", LK: "SAS", NP: "SAS", BT: "SAS", MV: "SAS",
  AF: "SAS", // Afghanistan grouped here in DHL operations

  // Rest of Asia — East/Southeast Asia minus China-HK and South Asia
  JP: "ROA", KR: "ROA", KP: "ROA", TW: "ROA",
  SG: "ROA", MY: "ROA", TH: "ROA", VN: "ROA", PH: "ROA", ID: "ROA",
  KH: "ROA", LA: "ROA", MM: "ROA", BN: "ROA", TL: "ROA",
  MN: "ROA", KZ: "ROA", KG: "ROA", TJ: "ROA", TM: "ROA", UZ: "ROA",

  // Oceania
  AU: "OCE", NZ: "OCE", PG: "OCE", FJ: "OCE", NC: "OCE", PF: "OCE",
  SB: "OCE", VU: "OCE", WS: "OCE", TO: "OCE", KI: "OCE", TV: "OCE",
  FM: "OCE", MH: "OCE", PW: "OCE", NR: "OCE", NU: "OCE", CK: "OCE",
  AS: "OCE", GU: "OCE", MP: "OCE",

  // Europe (EU, EFTA, UK, Western Balkans, Eastern Europe, Russia, Caucasus, Cyprus)
  AT: "EUR", BE: "EUR", BG: "EUR", HR: "EUR", CY: "EUR", CZ: "EUR",
  DK: "EUR", EE: "EUR", FI: "EUR", FR: "EUR", DE: "EUR", GR: "EUR",
  HU: "EUR", IE: "EUR", IT: "EUR", LV: "EUR", LT: "EUR", LU: "EUR",
  MT: "EUR", NL: "EUR", PL: "EUR", PT: "EUR", RO: "EUR", SK: "EUR",
  SI: "EUR", ES: "EUR", SE: "EUR",
  GB: "EUR", IS: "EUR", NO: "EUR", CH: "EUR", LI: "EUR",
  AL: "EUR", BA: "EUR", MK: "EUR", ME: "EUR", RS: "EUR", XK: "EUR",
  AD: "EUR", MC: "EUR", SM: "EUR", VA: "EUR", GI: "EUR", IM: "EUR",
  GG: "EUR", JE: "EUR", FO: "EUR", GL: "EUR",
  RU: "EUR", BY: "EUR", UA: "EUR", MD: "EUR",
  AM: "EUR", AZ: "EUR", GE: "EUR",
  TR: "EUR", // DHL puts Turkey in Europe for demand-surcharge purposes (per real billings)
  IC: "EUR", // Canary Islands

  // Americas (North + Central + South + Caribbean)
  US: "AMS", CA: "AMS", MX: "AMS",
  BR: "AMS", AR: "AMS", CL: "AMS", PE: "AMS", CO: "AMS", VE: "AMS",
  UY: "AMS", PY: "AMS", BO: "AMS", EC: "AMS", GY: "AMS", SR: "AMS", GF: "AMS",
  CR: "AMS", PA: "AMS", GT: "AMS", HN: "AMS", NI: "AMS", SV: "AMS", BZ: "AMS",
  CU: "AMS", DO: "AMS", HT: "AMS", JM: "AMS", BS: "AMS", BB: "AMS", TT: "AMS",
  AG: "AMS", DM: "AMS", GD: "AMS", LC: "AMS", VC: "AMS", KN: "AMS",
  KY: "AMS", BM: "AMS", VG: "AMS", VI: "AMS", AI: "AMS", MS: "AMS",
  AW: "AMS", CW: "AMS", BQ: "AMS", SX: "AMS", BL: "AMS", PR: "AMS", TC: "AMS",
  GP: "AMS", MQ: "AMS", FK: "AMS",

  // Middle East / North Africa
  AE: "MENA", SA: "MENA", QA: "MENA", BH: "MENA", KW: "MENA", OM: "MENA",
  YE: "MENA", JO: "MENA", LB: "MENA", SY: "MENA", IQ: "MENA", IR: "MENA",
  IL: "MENA", PS: "MENA",
  EG: "MENA", LY: "MENA", TN: "MENA", DZ: "MENA", MA: "MENA", EH: "MENA",
  SD: "MENA", // sometimes ROW; DHL groups it here
  // Rest of World — everything sub-Saharan Africa + non-listed + edge cases
  // (left to fall through)
};

// ROW (catch-all) for everything not explicitly mapped — mostly sub-Saharan
// Africa and odd territories. Cheaper to default than enumerate.
export function regionFor(iso: string | null | undefined): DemandRegion {
  if (!iso) return "ROW";
  return REGION_BY_ISO[iso.toUpperCase()] ?? "ROW";
}

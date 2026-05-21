// One-off script: replace all DHL Express CatalogProduct rows with the correct
// (code, direction, name_filter) → (product_name, sub_product_name) mappings
// as specified in the DHL Express Product Code Mapping document.
//
// Safe to re-run — deletes all existing rows for the target carriers first,
// then inserts the canonical set. GB/FR are copies of DE with identical mappings.
//
// Run: npx tsx scripts/fix_dhl_catalog_directions.ts
import { db } from "../app/lib/db";

const CARRIERS = ["DHL-EXPRESS-DE", "DHL-EXPRESS-GB", "DHL-EXPRESS-FR"] as const;

// Canonical catalog per the product-code mapping spec.
// direction: "export" | "import" | "any"
// name_filter: non-empty string = substring that must appear in the invoice's
//   product_name (case-insensitive) for this entry to take priority.
//   Only code H uses this for 9:00 domestic disambiguation.
const CATALOG: {
  code: string;
  direction: string;
  name_filter: string;
  product_name: string;
  sub_product_name: string;
}[] = [
  // S — Express Worldwide non-doc outbound (86% EXPORT non-EU)
  { code: "S", direction: "export", name_filter: "", product_name: "Express Worldwide Export", sub_product_name: "Package" },
  { code: "S", direction: "any",    name_filter: "", product_name: "Express Worldwide Export", sub_product_name: "Package" },

  // P — same service, inbound perspective (57% IMPORT non-EU, 41% EXPORT)
  { code: "P", direction: "import", name_filter: "", product_name: "Express Worldwide Import", sub_product_name: "Package" },
  { code: "P", direction: "export", name_filter: "", product_name: "Express Worldwide Export", sub_product_name: "Package" },

  // U — intra-EU / EU export (58% EXPORT-EU + transit)
  { code: "U", direction: "export", name_filter: "", product_name: "Express Worldwide Export", sub_product_name: "Package" },
  { code: "U", direction: "any",    name_filter: "", product_name: "Express Worldwide Export", sub_product_name: "Package" },

  // D — Worldwide Document (97% TRANSIT)
  { code: "D", direction: "any",    name_filter: "", product_name: "Express Worldwide Export", sub_product_name: "Document" },

  // T — Express 12:00 Document (uses base doc rate + YK surcharge)
  { code: "T", direction: "export", name_filter: "", product_name: "Express Worldwide Export", sub_product_name: "Document" },
  { code: "T", direction: "any",    name_filter: "", product_name: "Express Worldwide Export", sub_product_name: "Document" },

  // Y — Express 12:00 non-doc (85% IMPORT non-EU; base rate + YK surcharge)
  { code: "Y", direction: "import", name_filter: "", product_name: "Express Worldwide Import", sub_product_name: "Package" },
  { code: "Y", direction: "any",    name_filter: "", product_name: "Express Worldwide Import", sub_product_name: "Package" },

  // E — Express Domestic (100% DOMESTIC)
  { code: "E", direction: "any",    name_filter: "", product_name: "Express Domestic", sub_product_name: "Package" },

  // N — Economy Select Export (96% EXPORT non-EU; third-country routes via "any")
  { code: "N", direction: "export", name_filter: "", product_name: "Economy Select Export", sub_product_name: "Package" },
  { code: "N", direction: "any",    name_filter: "", product_name: "Economy Select Export", sub_product_name: "Package" },

  // V — Economy Select Domestic/Export (98% EXPORT-EU)
  { code: "V", direction: "export", name_filter: "", product_name: "Economy Select Export", sub_product_name: "Package" },
  { code: "V", direction: "any",    name_filter: "", product_name: "Economy Select Export", sub_product_name: "Package" },

  // W — Economy Select Import (50% IMPORT-EU + transit)
  { code: "W", direction: "import", name_filter: "", product_name: "Economy Select Import", sub_product_name: "Package" },
  { code: "W", direction: "any",    name_filter: "", product_name: "Economy Select Import", sub_product_name: "Package" },

  // H — dual meaning: Economy Select Import (79% IMPORT non-EU) OR Express Domestic 9:00 (8 DE→DE)
  // 9:00 variant is disambiguated by product_name containing "9:00".
  { code: "H", direction: "import", name_filter: "",     product_name: "Economy Select Import", sub_product_name: "Package" },
  { code: "H", direction: "export", name_filter: "9:00", product_name: "Express Domestic",       sub_product_name: "Package" },
  { code: "H", direction: "any",    name_filter: "",     product_name: "Economy Select Import", sub_product_name: "Package" },

  // C — Express Domestic alternative code (swap-commerce DE/GB)
  { code: "C", direction: "any",    name_filter: "", product_name: "Express Domestic", sub_product_name: "Package" },

  // L / O — Domestic time-of-day variants (base rate + time-tier surcharge)
  { code: "L", direction: "any",    name_filter: "", product_name: "Express Domestic", sub_product_name: "Package" },
  { code: "O", direction: "any",    name_filter: "", product_name: "Express Domestic", sub_product_name: "Package" },

  // K — Express 9:00 Document (base rate + time-tier surcharge)
  { code: "K", direction: "any",    name_filter: "", product_name: "Express Worldwide Export", sub_product_name: "Document" },

  // Z — Duties & Taxes pass-through line
  { code: "Z", direction: "any",    name_filter: "", product_name: "Duties & Taxes (pass-through)", sub_product_name: "—" },
];

async function main() {
  for (const carrier of CARRIERS) {
    const deleted = await db.catalogProduct.deleteMany({ where: { carrier } });
    console.log(`${carrier}: deleted ${deleted.count} existing rows`);

    await db.catalogProduct.createMany({
      data: CATALOG.map((row) => ({ carrier, ...row })),
    });
    console.log(`${carrier}: inserted ${CATALOG.length} rows`);
  }

  await db.$disconnect();
  console.log("Done.");
}

main().catch((e) => { console.error(e); process.exit(1); });

// Thomann UPS contract — process ONLY the XLSX (the 27 MB PDF blew past
// Anthropic's request size limit). The XLSX has all the rate cards + an
// "Accessorials" sheet that covers surcharges. The deterministic
// extract-rates-xlsx.ts handles freight bands; LLM is only used for
// surcharges (much smaller payload).
//
// Run: npx tsx scripts/upload_ups_thomann.ts
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { db } from "../app/lib/db";
import { extractContract, type SourceFile } from "../app/lib/carriers/ups";
import { parseUpsRateXlsx, type ParsedSheet } from "../app/lib/carriers/ups/extract-rates-xlsx";

const CUSTOMER_CODE = "thomann";
const CONTRACT_NAME = "UPS Germany — Thomann 2025/2026";
const ACCOUNT_NUMBERS = ["823289", "7F958Y", "AY2622"];

const PRICE_LIST_PATH = "/tmp/ups/thomann/UPS Preisliste ab 01.07.2025.xlsx";
// Service guide is a generic UPS doc, not Thomann-specific. Keep it as a
// ContractSource for traceability but don't feed it to the LLM.
const SERVICE_GUIDE_PATH = "/tmp/ups/thomann/service-guide-legacy-DE.pdf";

// Sheet → product/sub-product/code mapping for Thomann's price list. Their
// XLSX has more sheets than everstox (single + multi + S2AP variants +
// Expedited), and we only ingest the ones with matching service codes.
interface SheetMapping {
  sheet_name: string;
  product_name: string;
  sub_product_name: string;
  codes: string[];
  zone_group: string;
}

const SHEET_MAPPINGS: SheetMapping[] = [
  // Sending (Export)
  { sheet_name: "DE E-Express",                       product_name: "Worldwide Express (Export)",       sub_product_name: "Package", codes: ["007"],         zone_group: "ups-express-export" },
  { sheet_name: "DE E-Express Saver",                 product_name: "Worldwide Express Saver (Export)", sub_product_name: "Package", codes: ["069", "065"],   zone_group: "ups-saver-export" },
  { sheet_name: "DE E-Standard Single Lane",          product_name: "Standard Single (Export)",         sub_product_name: "Package", codes: ["011", "003"],   zone_group: "ups-standard-export" },
  { sheet_name: "DE E-Standard Multi Lane",           product_name: "Standard Multi (Export)",          sub_product_name: "Package", codes: ["011", "003"],   zone_group: "ups-standard-export" },
  { sheet_name: "DE E-Expedited",                     product_name: "Worldwide Expedited (Export)",     sub_product_name: "Package", codes: ["008"],         zone_group: "ups-expedited-export" },
  // Receiving (Import)
  { sheet_name: "DE I-Express",                       product_name: "Worldwide Express (Import)",       sub_product_name: "Package", codes: ["007"],         zone_group: "ups-express-import" },
  { sheet_name: "DE I-Express Saver",                 product_name: "Worldwide Express Saver (Import)", sub_product_name: "Package", codes: ["069", "065"],   zone_group: "ups-saver-import" },
  { sheet_name: "DE I-Standard Single Lane",          product_name: "Standard Single (Import)",         sub_product_name: "Package", codes: ["011", "003"],   zone_group: "ups-standard-import" },
  { sheet_name: "DE I-Standard Multi Lane",           product_name: "Standard Multi (Import)",          sub_product_name: "Package", codes: ["011", "003"],   zone_group: "ups-standard-import" },
  { sheet_name: "DE I-Expedited",                     product_name: "Worldwide Expedited (Import)",     sub_product_name: "Package", codes: ["008"],         zone_group: "ups-expedited-import" },
];

// Pull the Accessorials sheet out into a small CSV string and feed only that
// to the LLM — much smaller payload than the full XLSX.
function extractAccessorialsOnly(xlsxPath: string): SourceFile {
  const wb = XLSX.read(readFileSync(xlsxPath), { type: "buffer" });
  const candidates = ["Accessorials", "Surcharges", "Surcharge"];
  const sheetName = wb.SheetNames.find((n) => candidates.includes(n));
  if (!sheetName) throw new Error(`No Accessorials sheet — got: ${wb.SheetNames.join(", ")}`);
  const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName], { blankrows: false });
  return { name: "Thomann_Accessorials_only.csv", kind: "csv", bytes: Buffer.from(csv, "utf8") };
}

async function main() {
  const customer = await db.customer.findUnique({ where: { code: CUSTOMER_CODE }, select: { id: true } });
  if (!customer) throw new Error(`Customer "${CUSTOMER_CODE}" not found — was it created in the previous run?`);

  // ---- Surcharges via LLM, just on the Accessorials sheet ----
  console.log(`Extracting Thomann surcharges from Accessorials sheet only…`);
  const accessorials = extractAccessorialsOnly(PRICE_LIST_PATH);
  const extracted = await extractContract([accessorials]);
  console.log(`  → ${extracted.addons.length} surcharges extracted`);

  // ---- Freight bands via deterministic XLSX parser ----
  console.log(`Parsing Thomann rate sheets deterministically…`);
  const sheets = parseUpsRateXlsx(readFileSync(PRICE_LIST_PATH));
  const bySheet = new Map<string, ParsedSheet>(sheets.map((s) => [s.sheet_name, s]));
  const missing = SHEET_MAPPINGS.filter((m) => !bySheet.has(m.sheet_name));
  if (missing.length) console.log(`  ⚠ skipping mappings (sheet missing): ${missing.map((m) => m.sheet_name).join(", ")}`);

  // ---- Save Contract ----
  const contractData = await db.contract.create({
    data: {
      name: CONTRACT_NAME,
      carrier: "UPS-DE",
      billing_country: "DE",
      currency_code: "EUR",
      volumetric_divisor: 5000,
      valid_from: extracted.valid_from || "2025-07-01",
      valid_until: extracted.valid_until || "2026-12-31",
      customerId: customer.id,
      account_numbers: JSON.stringify(ACCOUNT_NUMBERS.sort()),
      addons: { create: extracted.addons.map((a) => ({
        code: a.code && a.code.length <= 5 ? a.code : `UNK-${a.name.slice(0, 6)}`,
        name: a.name, kind: a.kind, amount: a.amount,
      })) },
    },
    select: { id: true },
  });
  console.log(`  ✓ Contract #${contractData.id} created`);

  // ---- Freight products from deterministic parser ----
  let totalBands = 0;
  for (let pi = 0; pi < SHEET_MAPPINGS.length; pi++) {
    const m = SHEET_MAPPINGS[pi];
    const parsed = bySheet.get(m.sheet_name);
    if (!parsed) continue;
    const product = await db.freightProduct.create({
      data: { contractId: contractData.id, name: m.product_name, order: pi, zone_group: m.zone_group },
      select: { id: true },
    });
    const sub = await db.subProduct.create({
      data: { productId: product.id, name: m.sub_product_name, description: parsed.product_name, codes: m.codes.join(","), order: 0 },
      select: { id: true },
    });
    let bands = 0;
    for (const z of parsed.zones) {
      let order = 0;
      for (const b of z.bands) {
        await db.priceBand.create({
          data: {
            subProductId: sub.id, zone: z.zone, order: order++,
            weight_start: b.weight_start_g, weight_end: b.weight_end_g,
            price: b.price, per_kg: b.per_kg, step: b.step_kg,
          },
        });
        bands++;
      }
    }
    totalBands += bands;
    console.log(`    ✓ ${m.product_name} ← ${m.sheet_name} (${parsed.zones.length} zones, ${bands} bands)`);
  }
  console.log(`\n${totalBands} bands total.`);

  // ---- ContractSources (price list XLSX + service guide PDF) ----
  for (const path of [PRICE_LIST_PATH, SERVICE_GUIDE_PATH]) {
    const buf = readFileSync(path);
    const filename = path.split("/").pop()!;
    const kind = filename.endsWith(".pdf") ? "pdf" : "xlsx";
    await db.contractSource.create({
      data: {
        contractId: contractData.id,
        filename, kind, size_bytes: buf.byteLength,
        sha256: createHash("sha256").update(buf).digest("hex"),
        bytes: buf,
      },
    });
  }

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

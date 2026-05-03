import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import * as XLSX from "xlsx";

const BandSchema = z.object({
  weight_start_g: z.number().describe("Start weight in grams (convert from kg: 0.5 kg → 500)"),
  weight_end_g: z
    .number()
    .nullable()
    .describe("End weight in grams. NULL only for extrapolation bands (Folgeraten)"),
  price: z
    .number()
    .nullable()
    .describe("Fixed price for this weight range in the contract's currency. NULL for extrapolation bands"),
  per_kg: z
    .number()
    .nullable()
    .describe("Per-kg rate for extrapolation bands (Folgeraten). NULL for fixed-price bands"),
  step_kg: z
    .number()
    .nullable()
    .describe("Step increment in kg for extrapolation (e.g. 5 for 'jedes weitere 5 KG'). NULL if per-kg is continuous"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Your confidence 0..1 that the value is read correctly from the PDF"),
});

const ZonePricesSchema = z.object({
  zone: z.string().describe('Zone label exactly as printed, e.g. "Zone 1"'),
  bands: z.array(BandSchema),
});

const SubProductSchema = z.object({
  name: z.string().describe('E.g. "Envelope", "Document", "Package"'),
  description: z.string().nullable().describe('Contract caption, e.g. "Zollfrei Dokument bis 2.0 KG"'),
  codes: z
    .array(z.string())
    .describe(
      "Carrier invoice BILLING CODES for this sub-product — short identifiers (typically 1–3 characters) that appear in the carrier's invoice CSV product column. " +
      "For DHL Express these are single letters: S, U, T, E, V, N, P, Y, Z. " +
      "DO NOT put product names or marketing labels here (NOT 'EXPRESS WORLDWIDE', 'EXPRESS ENVELOPE', etc). " +
      "Leave [] if the contract doesn't explicitly list these short codes — an external catalog will route invoice codes to sub-products by name.",
    ),
  zones: z.array(ZonePricesSchema),
});

const FreightProductSchema = z.object({
  name: z
    .string()
    .describe(
      'Canonical product name with NO carrier prefix. Drop "DHL", "DHL Express", "UPS", etc. from the title. ' +
      'For DHL Express Germany use exactly one of: "Express Worldwide Export", "Express Worldwide Import", "Express Worldwide Third Country", "Express Domestic", "Express 12:00 (Document)", "Economy Select Export", "Economy Select Import".',
    ),
  sub_products: z.array(SubProductSchema),
});

const SurchargeSchema = z.object({
  code: z.string().nullable().describe("Billing code if listed, else null"),
  name: z.string(),
  kind: z.enum(["flat", "per_kg", "per_shipment", "percent"]),
  amount: z.number().nullable().describe("Fixed EUR amount or percentage value; null if it varies"),
});

export const ExtractedContractSchema = z.object({
  name: z.string().describe("Human-friendly contract name, e.g. 'DHL Express Germany — Standard Rates 2025'"),
  carrier: z.string().describe("Carrier code, e.g. 'DHL-EXPRESS-DE'"),
  billing_country: z.string().describe("ISO-2 billing country code"),
  currency_code: z.string(),
  volumetric_divisor: z.number().describe("Typical value 5000 (for L×W×H in cm ÷ 5000 = kg)"),
  valid_from: z.string().describe("ISO date YYYY-MM-DD"),
  valid_until: z.string().describe("ISO date YYYY-MM-DD"),
  freight: z.array(FreightProductSchema),
  addons: z.array(SurchargeSchema),
  notes: z.string().nullable().describe("Extraction warnings or ambiguities for the human reviewer"),
});

export type ExtractedContract = z.infer<typeof ExtractedContractSchema>;

// --- Chunked extraction: skeleton pass (no bands) + per-product pass ---

const SkeletonSubProductSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  codes: z.array(z.string()),
});

const SkeletonFreightSchema = z.object({
  name: z.string(),
  sub_products: z.array(SkeletonSubProductSchema),
});

const ContractSkeletonSchema = z.object({
  name: z.string(),
  carrier: z.string(),
  billing_country: z.string(),
  currency_code: z.string(),
  volumetric_divisor: z.number(),
  valid_from: z.string(),
  valid_until: z.string(),
  freight: z.array(SkeletonFreightSchema),
  addons: z.array(SurchargeSchema),
  notes: z.string().nullable(),
});

const ProductDetailSchema = z.object({
  product_name: z.string().describe("Echo back the product name you were asked to extract"),
  sub_products: z.array(
    z.object({
      name: z.string(),
      zones: z.array(ZonePricesSchema),
    }),
  ),
  notes: z.string().nullable(),
});

const SYSTEM_PROMPT = `You extract shipping carrier rate contracts (DHL Express, UPS, FedEx, etc.) from PDFs into structured JSON for downstream auditing.

Rules:
- All weights in OUTPUT are GRAMS. Convert from kg: 0.5 kg → 500, 70 kg → 70000.
- Each freight product can have multiple sub-products for different weight tiers:
  * "Envelope" for very small items (e.g. up to 300g)
  * "Document" for documents up to a threshold (Zollfrei, non-dutiable)
  * "Package" for everything else (Zollpflichtig, Warensendung)
- "Folgeraten" / "Zwischenschritte" rows become extrapolation bands with per_kg and optional step_kg. weight_end_g and price MUST be null for these.
- For fixed-price bands (main table cells), price is set and per_kg/step_kg are null.
- Each price gets a confidence score: 0.95+ for clear cell values, 0.7 for ambiguous, 0.4 for inferred. If the value is illegible or missing, OMIT the band entirely (don't invent numbers).
- Zone labels must match the contract's column headers exactly (e.g. "Zone 1", "Zone 2", "Zone 11").
- Surcharges: premium delivery (9:00/10:30/12:00 — model as flat), fuel (model as percent if "%" or "Zuschlag"), emissions (GoGreen), oversize, address correction, etc.
- kind="flat" = fixed amount per shipment, "percent" = % of base charge, "per_kg" = amount × weight, "per_shipment" = flat but named per-shipment in the contract.
- Use the carrier's common code format. DHL Germany = "DHL-EXPRESS-DE". Use ISO-2 for billing_country ("DE", "FR", "AT", "GB", etc.).
- If the contract doesn't explicitly state volumetric divisor, default to 5000.

NORMALIZATION (very important — downstream code looks up products by name):
- Product names must be canonical and STRIPPED of carrier prefixes. "DHL Express Worldwide Export" becomes "Express Worldwide Export". "DHL Economy Select Export" becomes "Economy Select Export". Do NOT keep "DHL" or "DHL Express" in front of product names.
- For DHL Express Germany, the canonical product names are: "Express Worldwide Export", "Express Worldwide Import", "Express Worldwide Third Country", "Express Domestic", "Express 12:00 (Document)", "Economy Select Export", "Economy Select Import". Pick the closest match.
- Sub-product names should be one of "Envelope", "Document", "Package" for DHL — descriptive labels in the PDF (e.g. "Express Envelope up to 300g") should be reflected in the description field, not the name.
- Sub-product 'codes' must be SHORT identifiers from the carrier's invoice (DHL: single letters S, U, T, E, V, N, P, Y, Z). Never put marketing labels like "EXPRESS WORLDWIDE" in codes — leave [] instead. The external catalog handles invoice-code-to-sub-product routing by name.

Respond via the structured output schema.`;

export type SourceKind = "pdf" | "xlsx" | "csv";

export interface SourceFile {
  name: string;
  kind: SourceKind;
  bytes: Buffer;
}

function xlsxToPrompt(name: string, bytes: Buffer): string {
  const wb = XLSX.read(bytes, { type: "buffer" });
  const parts: string[] = [
    `### FILE: ${name} (XLSX, ${wb.SheetNames.length} sheet${wb.SheetNames.length === 1 ? "" : "s"})`,
    `Sheet names: ${wb.SheetNames.join(", ")}.`,
    'Sheet-name abbreviations: "TD" = Time Definite (Express), "DD" = Day Definite (Economy), "Exp" = Export, "Imp" = Import, "Dom" = Domestic, "WW" = Worldwide.',
    'Sub-product sections are label rows (e.g. "Envelope up to 300 g only") followed by a "KG | Zone 1 | Zone 2 | ..." header, then one row per weight break. Weights in the input are kilograms — convert to grams in the output.',
    "",
  ];
  for (const n of wb.SheetNames) {
    const ws = wb.Sheets[n];
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
    parts.push(`--- SHEET: ${n} ---`);
    parts.push(csv.trim());
    parts.push("");
  }
  return parts.join("\n");
}

function csvToPrompt(name: string, bytes: Buffer): string {
  return [
    `### FILE: ${name} (CSV)`,
    "Weights in the input are kilograms — convert to grams in the output.",
    "",
    bytes.toString("utf8").trim(),
    "",
  ].join("\n");
}

function buildSourceBlocks(files: SourceFile[]): {
  content: Anthropic.ContentBlockParam[];
  textHeader: string[];
} {
  const content: Anthropic.ContentBlockParam[] = [];
  const textHeader: string[] = [];
  if (files.length > 1) {
    textHeader.push(
      `The following ${files.length} files together form ONE contract. Merge all rates, sub-products, and surcharges. If two files disagree on the same value, prefer the more specific / most-detailed source.`,
      "",
    );
  }
  for (const f of files) {
    if (f.kind === "pdf") {
      content.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: f.bytes.toString("base64"),
        },
        title: f.name,
      });
    } else if (f.kind === "xlsx") {
      textHeader.push(xlsxToPrompt(f.name, f.bytes));
    } else {
      textHeader.push(csvToPrompt(f.name, f.bytes));
    }
  }
  return { content, textHeader };
}

async function extractSkeleton(client: Anthropic, files: SourceFile[]): Promise<z.infer<typeof ContractSkeletonSchema>> {
  const { content, textHeader } = buildSourceBlocks(files);
  content.push({
    type: "text",
    text:
      textHeader.join("\n") +
      "\n\nExtract ONLY the contract skeleton: metadata, the list of freight products and their sub-products (names + descriptions + codes), and surcharges. DO NOT extract zones or price bands — those will be requested separately. Return structured JSON per the schema.",
  });

  const stream = client.messages.stream({
    model: "claude-opus-4-7",
    max_tokens: 16000,
    thinking: { type: "disabled" },
    system: SYSTEM_PROMPT,
    output_config: {
      format: zodOutputFormat(ContractSkeletonSchema),
      effort: "low",
    },
    messages: [{ role: "user", content }],
  });

  const final = await stream.finalMessage();
  if (final.stop_reason === "max_tokens") {
    throw new Error("Skeleton extraction truncated — unexpected; the skeleton pass should be small.");
  }
  const textBlock = final.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new Error(`Skeleton extraction: no text block (stop_reason=${final.stop_reason})`);
  const json = JSON.parse(textBlock.text);
  return ContractSkeletonSchema.parse(json);
}

async function extractProductDetail(
  client: Anthropic,
  files: SourceFile[],
  productName: string,
  subProductNames: string[],
): Promise<z.infer<typeof ProductDetailSchema>> {
  const { content, textHeader } = buildSourceBlocks(files);
  content.push({
    type: "text",
    text:
      textHeader.join("\n") +
      `\n\nExtract ONLY the rate tables for the freight product "${productName}". ` +
      `Expected sub-products for this product: ${subProductNames.map((n) => `"${n}"`).join(", ")}. ` +
      `For each sub-product return its zones and weight bands. Use the same sub-product names as above so they can be merged with the skeleton.\n` +
      `Ignore rates for other products (they will be extracted in separate calls). Return structured JSON per the schema.`,
  });

  const stream = client.messages.stream({
    model: "claude-opus-4-7",
    max_tokens: 96000,
    thinking: { type: "disabled" },
    system: SYSTEM_PROMPT,
    output_config: {
      format: zodOutputFormat(ProductDetailSchema),
      effort: "low",
    },
    messages: [{ role: "user", content }],
  });

  const final = await stream.finalMessage();
  if (final.stop_reason === "max_tokens") {
    throw new Error(
      `Rate extraction truncated for "${productName}" — this product alone is too large. Reduce zones or split the source further.`,
    );
  }
  const textBlock = final.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new Error(`Detail extraction for "${productName}": no text block (stop_reason=${final.stop_reason})`);
  const json = JSON.parse(textBlock.text);
  return ProductDetailSchema.parse(json);
}

export async function extractContract(files: SourceFile[]): Promise<ExtractedContract> {
  if (files.length === 0) throw new Error("Extraction: no files provided");
  const client = new Anthropic();

  const skeleton = await extractSkeleton(client, files);

  const details = await Promise.all(
    skeleton.freight.map((p) =>
      extractProductDetail(
        client,
        files,
        p.name,
        p.sub_products.map((sp) => sp.name),
      ),
    ),
  );

  const detailByProduct = new Map<string, z.infer<typeof ProductDetailSchema>>();
  for (const d of details) detailByProduct.set(d.product_name, d);

  const notes: string[] = [];
  if (skeleton.notes) notes.push(skeleton.notes);
  for (const d of details) if (d.notes) notes.push(`[${d.product_name}] ${d.notes}`);

  const freight = skeleton.freight.map((p) => {
    const detail = detailByProduct.get(p.name);
    if (!detail) notes.push(`No detail extraction returned for "${p.name}"`);
    const zonesBySub = new Map<string, z.infer<typeof ZonePricesSchema>[]>();
    if (detail) {
      for (const sp of detail.sub_products) {
        zonesBySub.set(sp.name, sp.zones);
      }
    }
    return {
      name: p.name,
      sub_products: p.sub_products.map((sp) => {
        const zones = zonesBySub.get(sp.name);
        if (!zones) notes.push(`No zones returned for "${p.name}" → "${sp.name}"`);
        return {
          name: sp.name,
          description: sp.description,
          codes: sp.codes,
          zones: zones ?? [],
        };
      }),
    };
  });

  return {
    name: skeleton.name,
    carrier: skeleton.carrier,
    billing_country: skeleton.billing_country,
    currency_code: skeleton.currency_code,
    volumetric_divisor: skeleton.volumetric_divisor,
    valid_from: skeleton.valid_from,
    valid_until: skeleton.valid_until,
    freight,
    addons: skeleton.addons,
    notes: notes.length ? notes.join(" | ") : null,
  };
}

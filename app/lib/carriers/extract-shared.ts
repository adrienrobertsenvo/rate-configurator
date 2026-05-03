// Carrier-agnostic helpers for contract extraction. The Zod schemas + the
// file→prompt translation are identical across carriers; only the SYSTEM_PROMPT
// (carrier-specific terminology, product naming conventions, billing-code
// vocabulary) and the orchestration glue differ.
//
// Each carrier's extract module imports from here and adds:
//   - its own SYSTEM_PROMPT
//   - extractContract(files) — orchestrates skeleton + per-product detail
//
// New carriers: copy app/lib/carriers/dhl-express/extract.ts as a starting
// point and edit the prompt + product-name canonicalization.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import * as XLSX from "xlsx";

export const BandSchema = z.object({
  weight_start_g: z.number().describe("Start weight in grams (convert from kg: 0.5 kg → 500)"),
  weight_end_g: z.number().nullable().describe("End weight in grams. NULL only for extrapolation bands"),
  price: z.number().nullable().describe("Fixed price for this weight range in the contract's currency. NULL for extrapolation bands"),
  per_kg: z.number().nullable().describe("Per-kg rate for extrapolation bands. NULL for fixed-price bands"),
  step_kg: z.number().nullable().describe("Step increment in kg for extrapolation. NULL if continuous"),
  confidence: z.number().min(0).max(1).describe("Your confidence 0..1 that the value is read correctly"),
});

export const ZonePricesSchema = z.object({
  zone: z.string().describe('Zone label exactly as printed, e.g. "Zone 1"'),
  bands: z.array(BandSchema),
});

export const SubProductSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  codes: z.array(z.string()),
  zones: z.array(ZonePricesSchema),
});

export const FreightProductSchema = z.object({
  name: z.string(),
  sub_products: z.array(SubProductSchema),
});

export const SurchargeSchema = z.object({
  code: z.string().nullable().describe("Billing code if listed, else null"),
  name: z.string(),
  kind: z.enum(["flat", "per_kg", "per_shipment", "percent"]),
  amount: z.number().nullable().describe("Fixed EUR amount or percentage value; null if it varies"),
});

export const ExtractedContractSchema = z.object({
  name: z.string(),
  carrier: z.string(),
  billing_country: z.string(),
  currency_code: z.string(),
  volumetric_divisor: z.number(),
  valid_from: z.string(),
  valid_until: z.string(),
  freight: z.array(FreightProductSchema),
  addons: z.array(SurchargeSchema),
  notes: z.string().nullable(),
});

export type ExtractedContract = z.infer<typeof ExtractedContractSchema>;

// Skeleton pass: metadata + product/sub-product names, no zones/bands.
const SkeletonSubProductSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  codes: z.array(z.string()),
});
const SkeletonFreightSchema = z.object({
  name: z.string(),
  sub_products: z.array(SkeletonSubProductSchema),
});
export const ContractSkeletonSchema = z.object({
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

// Per-product detail pass: zones + bands for one named product.
export const ProductDetailSchema = z.object({
  product_name: z.string(),
  sub_products: z.array(z.object({
    name: z.string(),
    zones: z.array(ZonePricesSchema),
  })),
  notes: z.string().nullable(),
});

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

export function buildSourceBlocks(files: SourceFile[]): {
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
        source: { type: "base64", media_type: "application/pdf", data: f.bytes.toString("base64") },
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

// Run the skeleton + per-product passes. Carriers customize via the prompts.
export async function runExtraction(
  files: SourceFile[],
  systemPrompt: string,
  options?: { skeletonInstruction?: string; detailInstruction?: (productName: string, subProducts: string[]) => string },
): Promise<ExtractedContract> {
  if (files.length === 0) throw new Error("Extraction: no files provided");
  const client = new Anthropic();

  // ---- skeleton ----
  const { content, textHeader } = buildSourceBlocks(files);
  content.push({
    type: "text",
    text:
      textHeader.join("\n") +
      "\n\n" + (options?.skeletonInstruction
        ?? "Extract ONLY the contract skeleton: metadata, freight products + sub-products (names + descriptions + codes), and surcharges. DO NOT extract zones or price bands — those will be requested separately. Return structured JSON per the schema."),
  });
  let stream = client.messages.stream({
    model: "claude-opus-4-7",
    max_tokens: 16000,
    thinking: { type: "disabled" },
    system: systemPrompt,
    output_config: { format: (await import("@anthropic-ai/sdk/helpers/zod")).zodOutputFormat(ContractSkeletonSchema), effort: "low" },
    messages: [{ role: "user", content }],
  });
  let final = await stream.finalMessage();
  if (final.stop_reason === "max_tokens") throw new Error("Skeleton extraction truncated.");
  let textBlock = final.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new Error(`Skeleton extraction: no text block (stop_reason=${final.stop_reason})`);
  const skeleton = ContractSkeletonSchema.parse(JSON.parse(textBlock.text));

  // ---- per-product detail (parallel) ----
  const details = await Promise.all(skeleton.freight.map(async (p) => {
    const subs = p.sub_products.map((sp) => sp.name);
    const { content: detContent, textHeader: detText } = buildSourceBlocks(files);
    detContent.push({
      type: "text",
      text:
        detText.join("\n") +
        "\n\n" + (options?.detailInstruction?.(p.name, subs) ??
          `Extract ONLY the rate tables for the freight product "${p.name}". Expected sub-products: ${subs.map((n) => `"${n}"`).join(", ")}. For each sub-product return zones + bands. Ignore other products. Return structured JSON per the schema.`),
    });
    stream = client.messages.stream({
      model: "claude-opus-4-7",
      max_tokens: 96000,
      thinking: { type: "disabled" },
      system: systemPrompt,
      output_config: { format: (await import("@anthropic-ai/sdk/helpers/zod")).zodOutputFormat(ProductDetailSchema), effort: "low" },
      messages: [{ role: "user", content: detContent }],
    });
    final = await stream.finalMessage();
    if (final.stop_reason === "max_tokens") throw new Error(`Rate extraction truncated for "${p.name}".`);
    textBlock = final.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) throw new Error(`Detail extraction for "${p.name}": no text block (stop_reason=${final.stop_reason})`);
    return ProductDetailSchema.parse(JSON.parse(textBlock.text));
  }));

  // ---- merge ----
  const detailByProduct = new Map<string, z.infer<typeof ProductDetailSchema>>();
  for (const d of details) detailByProduct.set(d.product_name, d);
  const notes: string[] = [];
  if (skeleton.notes) notes.push(skeleton.notes);
  for (const d of details) if (d.notes) notes.push(`[${d.product_name}] ${d.notes}`);

  const freight = skeleton.freight.map((p) => {
    const detail = detailByProduct.get(p.name);
    if (!detail) notes.push(`No detail extraction returned for "${p.name}"`);
    const zonesBySub = new Map<string, z.infer<typeof ZonePricesSchema>[]>();
    if (detail) for (const sp of detail.sub_products) zonesBySub.set(sp.name, sp.zones);
    return {
      name: p.name,
      sub_products: p.sub_products.map((sp) => {
        const zones = zonesBySub.get(sp.name);
        if (!zones) notes.push(`No zones returned for "${p.name}" → "${sp.name}"`);
        return { name: sp.name, description: sp.description, codes: sp.codes, zones: zones ?? [] };
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

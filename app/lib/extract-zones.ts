import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import * as XLSX from "xlsx";

const ZoneEntrySchema = z.object({
  country: z.string().describe("ISO-3166 alpha-2 country code, uppercase (e.g. DE, FR, US)"),
  zone: z.number().int().min(1).describe("Integer zone number (1–20 typical)"),
});

export const ExtractedZonesSchema = z.object({
  carrier: z.string().nullable().describe("Carrier label if visible (e.g. 'DHL Express'), else null"),
  billing_country: z.string().nullable().describe("ISO-2 billing country if visible, else null"),
  zone_group: z.string().nullable().describe("If the source is specific to a product line, use a short label (e.g. 'worldwide', 'economy', 'domestic'). Else null."),
  valid_from: z.string().nullable().describe("ISO date YYYY-MM-DD if the source specifies a validity period"),
  entries: z.array(ZoneEntrySchema),
  notes: z.string().nullable().describe("Warnings, ambiguities, or countries you skipped with reasons"),
});

export type ExtractedZones = z.infer<typeof ExtractedZonesSchema>;

export type ZoneSourceKind = "pdf" | "xlsx" | "csv" | "image";

export interface ZoneSourceFile {
  name: string;
  kind: ZoneSourceKind;
  mediaType: string; // required for images: image/png, image/jpeg, image/webp, image/gif
  bytes: Buffer;
}

const SYSTEM_PROMPT = `You extract country-to-zone tables from carrier rate documents (DHL, UPS, FedEx, etc.).

Rules:
- Output every country you can read as { country: "CC", zone: N }. Always ISO-3166 alpha-2 (two uppercase letters). Convert full names ("Germany" → "DE", "United States" → "US").
- Zones are integers. Most carriers use 1–10 (DHL DE) or 1–14 (DHL with extra zones). If a row has multiple zones (e.g. regional splits), pick the PRIMARY/DEFAULT zone and mention the alternatives in notes.
- Skip headers, legends, and footnotes. Only emit rows that have a country and a zone.
- If a country is not legible (smudged / cropped), omit it rather than guessing. Flag it in notes.
- If the source covers multiple product lines (e.g. "Express Worldwide" vs "Economy Select" on different pages/sheets), pick the one with the clearest data and note which in zone_group.

Respond via the structured output schema.`;

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

export async function extractZones(files: ZoneSourceFile[]): Promise<ExtractedZones> {
  if (files.length === 0) throw new Error("Zone extraction: no files provided");
  const client = new Anthropic();

  const content: Anthropic.ContentBlockParam[] = [];
  const textChunks: string[] = [];

  for (const f of files) {
    if (f.kind === "image") {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: f.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
          data: f.bytes.toString("base64"),
        },
      });
    } else if (f.kind === "pdf") {
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
      textChunks.push(xlsxToPrompt(f.name, f.bytes));
    } else {
      textChunks.push(`### FILE: ${f.name} (CSV)\n\n${f.bytes.toString("utf8").trim()}\n`);
    }
  }

  textChunks.push("Extract the country → zone table. Return every legible country entry.");
  content.push({ type: "text", text: textChunks.join("\n\n") });

  const stream = client.messages.stream({
    model: "claude-opus-4-7",
    max_tokens: 32000,
    thinking: { type: "disabled" },
    system: SYSTEM_PROMPT,
    output_config: {
      format: zodOutputFormat(ExtractedZonesSchema),
      effort: "low",
    },
    messages: [{ role: "user", content }],
  });

  const final = await stream.finalMessage();

  if (final.stop_reason === "max_tokens") {
    throw new Error("Zone extraction truncated — try a smaller image or fewer pages at once.");
  }

  const textBlock = final.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new Error(`Zone extraction: no text block (stop_reason=${final.stop_reason})`);

  try {
    const json = JSON.parse(textBlock.text);
    return ExtractedZonesSchema.parse(json);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Zone extraction produced invalid JSON: ${msg}`);
  }
}

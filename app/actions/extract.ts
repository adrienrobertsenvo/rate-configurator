"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { db } from "../lib/db";
import { extractContract, type ExtractedContract, type SourceFile, type SourceKind } from "../lib/carriers/dhl-express/extract";

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function detectKind(name: string, type: string): SourceKind | null {
  const n = name.toLowerCase();
  if (type === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (n.endsWith(".xlsx") || n.endsWith(".xls")) return "xlsx";
  if (n.endsWith(".csv")) return "csv";
  return null;
}

export async function uploadAndExtractContract(formData: FormData): Promise<{ contractId: number }> {
  const entries = formData.getAll("pdf");
  const files: SourceFile[] = [];
  for (const entry of entries) {
    if (!(entry instanceof File)) continue;
    if (entry.size === 0) continue;
    const kind = detectKind(entry.name, entry.type);
    if (!kind) {
      throw new Error(`Unsupported file type: ${entry.name} — use PDF, XLSX, or CSV`);
    }
    if (entry.size > 30 * 1024 * 1024) {
      throw new Error(`${entry.name} exceeds 30MB limit`);
    }
    files.push({
      name: entry.name,
      kind,
      bytes: Buffer.from(await entry.arrayBuffer()),
    });
  }

  if (files.length === 0) throw new Error("No files provided");

  const extracted = await extractContract(files);
  const contractId = await saveExtracted(extracted);

  // Record each source file alongside the extracted contract so the user can
  // verify what the engine adopted, and so future merges keep the document trail.
  for (const f of files) {
    await db.contractSource.create({
      data: {
        contractId,
        filename: f.name,
        kind: f.kind,
        size_bytes: f.bytes.byteLength,
        sha256: createHash("sha256").update(f.bytes).digest("hex"),
        bytes: new Uint8Array(f.bytes),
      },
    });
  }

  revalidatePath("/");
  revalidatePath(`/contracts/${contractId}`);
  return { contractId };
}

// Each canonical DHL Express product uses a distinct zone scheme:
//   worldwide → 10 zones spanning all countries
//   economy   → ~36-country EU/EEA-focused subset
//   domestic  → DE only
// Extraction returns canonical product names; this map assigns the zone scheme.
const ZONE_GROUP_BY_PRODUCT: Record<string, string> = {
  "Express Worldwide Export":        "worldwide",
  "Express Worldwide Import":        "worldwide",
  "Express Worldwide Third Country": "worldwide",
  "Express 12:00 (Document)":        "worldwide",
  "Economy Select Export":           "economy",
  "Economy Select Import":           "economy",
  "Express Domestic":                "domestic",
};

async function saveExtracted(e: ExtractedContract): Promise<number> {
  // Pull the carrier's surcharge catalog so we can resolve canonical codes
  // (e.g. "CA" for "Elevated Risk") instead of saving placeholder UNK codes.
  const catalog = await db.catalogSurcharge.findMany({ where: { carrier: e.carrier } });
  const codeByNormName = new Map<string, string>();
  for (const c of catalog) codeByNormName.set(normalizeName(c.name), c.code);

  function resolveAddonCode(extractorCode: string | null, name: string): string {
    if (extractorCode && extractorCode.length <= 4) return extractorCode; // looks like a real billing code
    const canonical = codeByNormName.get(normalizeName(name));
    if (canonical) return canonical;
    return extractorCode ?? `UNK-${name.slice(0, 6)}`;
  }

  const created = await db.contract.create({
    data: {
      name: e.name,
      carrier: e.carrier,
      billing_country: e.billing_country.toUpperCase(),
      currency_code: e.currency_code || "EUR",
      volumetric_divisor: e.volumetric_divisor || 5000,
      valid_from: e.valid_from,
      valid_until: e.valid_until,
      addons: {
        create: e.addons.map((a) => ({
          code: resolveAddonCode(a.code ?? null, a.name),
          name: a.name,
          kind: a.kind,
          amount: a.amount,
        })),
      },
    },
    select: { id: true },
  });

  for (let pi = 0; pi < e.freight.length; pi++) {
    const p = e.freight[pi];
    const product = await db.freightProduct.create({
      data: {
        contractId: created.id,
        name: p.name,
        order: pi,
        zone_group: ZONE_GROUP_BY_PRODUCT[p.name] ?? "default",
      },
      select: { id: true },
    });

    for (let si = 0; si < p.sub_products.length; si++) {
      const sp = p.sub_products[si];
      const sub = await db.subProduct.create({
        data: {
          productId: product.id,
          name: sp.name,
          description: sp.description,
          codes: sp.codes.length ? sp.codes.join(",") : null,
          order: si,
        },
        select: { id: true },
      });

      const bandRows: {
        subProductId: number;
        zone: string;
        order: number;
        weight_start: number;
        weight_end: number | null;
        price: number | null;
        per_kg: number | null;
        step: number | null;
        confidence: number | null;
      }[] = [];
      for (const z of sp.zones) {
        let order = 0;
        for (const b of z.bands) {
          bandRows.push({
            subProductId: sub.id,
            zone: z.zone,
            order: order++,
            weight_start: b.weight_start_g,
            weight_end: b.weight_end_g,
            price: b.price,
            per_kg: b.per_kg,
            step: b.step_kg,
            confidence: b.confidence,
          });
        }
      }
      for (const row of bandRows) {
        await db.priceBand.create({ data: row });
      }
    }
  }

  return created.id;
}

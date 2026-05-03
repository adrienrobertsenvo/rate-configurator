"use server";

import { db } from "../lib/db";
import { revalidatePath } from "next/cache";
import yaml from "js-yaml";
import { extractZones, type ZoneSourceFile, type ZoneSourceKind } from "../lib/carriers/dhl-express/extract-zones";

export async function updateZoneMap(id: number, patch: Partial<{
  carrier: string;
  billing_country: string;
  zone_group: string;
  spec_name: string;
  valid_from: string;
  currency_code: string;
}>) {
  await db.zoneMap.update({ where: { id }, data: patch });
  revalidatePath("/zones");
}

export async function createZoneMap(input: {
  carrier: string;
  billing_country: string;
  zone_group: string;
  spec_name: string;
  contractId?: number | null;
}): Promise<number> {
  const existing = await db.zoneMap.findFirst({
    where: {
      carrier: input.carrier,
      billing_country: input.billing_country,
      zone_group: input.zone_group,
      contractId: input.contractId ?? null,
    },
  });
  if (existing) return existing.id;
  const created = await db.zoneMap.create({
    data: {
      carrier: input.carrier,
      billing_country: input.billing_country,
      zone_group: input.zone_group,
      spec_name: input.spec_name,
      valid_from: new Date().toISOString().slice(0, 10),
      currency_code: "EUR",
      contractId: input.contractId ?? null,
    },
  });
  revalidatePath("/zones");
  return created.id;
}

export async function deleteZoneMap(id: number) {
  await db.zoneMap.delete({ where: { id } });
  revalidatePath("/zones");
}

export async function extractZonesFromFiles(formData: FormData): Promise<{
  entries: { country: string; zone: number }[];
  notes: string | null;
  carrier: string | null;
  zone_group: string | null;
  billing_country: string | null;
}> {
  const files = formData.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) throw new Error("No files provided");

  const sources: ZoneSourceFile[] = [];
  for (const f of files) {
    const bytes = Buffer.from(await f.arrayBuffer());
    const lower = f.name.toLowerCase();
    const mime = f.type || "";
    let kind: ZoneSourceKind;
    let mediaType = mime;
    if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/.test(lower)) {
      kind = "image";
      if (!mediaType || !mediaType.startsWith("image/")) {
        if (lower.endsWith(".png")) mediaType = "image/png";
        else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) mediaType = "image/jpeg";
        else if (lower.endsWith(".gif")) mediaType = "image/gif";
        else if (lower.endsWith(".webp")) mediaType = "image/webp";
        else mediaType = "image/png";
      }
    } else if (mime === "application/pdf" || lower.endsWith(".pdf")) {
      kind = "pdf";
    } else if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
      kind = "xlsx";
    } else {
      kind = "csv";
    }
    sources.push({ name: f.name, kind, mediaType, bytes });
  }

  const result = await extractZones(sources);
  return {
    entries: result.entries.map((e) => ({ country: e.country.toUpperCase(), zone: e.zone })),
    notes: result.notes,
    carrier: result.carrier,
    zone_group: result.zone_group,
    billing_country: result.billing_country,
  };
}

export async function setCountryZone(zoneMapId: number, country: string, zone: number) {
  await db.countryZone.upsert({
    where: { zoneMapId_country: { zoneMapId, country } },
    update: { zone },
    create: { zoneMapId, country, zone },
  });
  revalidatePath("/zones");
}

export async function removeCountry(zoneMapId: number, country: string) {
  await db.countryZone.delete({ where: { zoneMapId_country: { zoneMapId, country } } });
  revalidatePath("/zones");
}

export async function bulkImportZones(
  zoneMapId: number,
  text: string,
  mode: "merge" | "replace",
): Promise<{ imported: number; skipped: string[] }> {
  const entries = parseZoneText(text);
  const skipped: string[] = [];
  const valid: { country: string; zone: number }[] = [];
  for (const e of entries) {
    const cc = e.country.trim().toUpperCase();
    if (cc.length !== 2) {
      skipped.push(`"${e.country}" (not ISO-2)`);
      continue;
    }
    if (!Number.isFinite(e.zone) || e.zone <= 0) {
      skipped.push(`${cc} (invalid zone ${e.zone})`);
      continue;
    }
    valid.push({ country: cc, zone: e.zone });
  }

  await db.$transaction(async (tx) => {
    if (mode === "replace") {
      await tx.countryZone.deleteMany({ where: { zoneMapId } });
    }
    for (const v of valid) {
      await tx.countryZone.upsert({
        where: { zoneMapId_country: { zoneMapId, country: v.country } },
        update: { zone: v.zone },
        create: { zoneMapId, country: v.country, zone: v.zone },
      });
    }
  });

  revalidatePath("/zones");
  return { imported: valid.length, skipped };
}

function parseZoneText(text: string): { country: string; zone: number }[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Try YAML first (matches dhl-express-*-zones.yaml structure)
  if (trimmed.includes("countries:") || /^\s*[A-Z]{2}\s*:\s*$/m.test(trimmed)) {
    try {
      const doc = yaml.load(trimmed) as Record<string, unknown>;
      const countries = (doc?.countries ?? doc) as Record<string, { zones?: number[] } | number>;
      const out: { country: string; zone: number }[] = [];
      for (const [cc, v] of Object.entries(countries)) {
        if (typeof v === "number") out.push({ country: cc, zone: v });
        else if (v && typeof v === "object" && "zones" in v && Array.isArray(v.zones) && v.zones.length > 0) {
          out.push({ country: cc, zone: Number(v.zones[0]) });
        }
      }
      if (out.length > 0) return out;
    } catch {
      // fall through to CSV
    }
  }

  // CSV: each line "CC,zone" or "CC zone" or "CC\tzone"
  const out: { country: string; zone: number }[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean || clean.startsWith("#")) continue;
    const parts = clean.split(/[\s,;\t]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const zone = Number(parts[1]);
    if (Number.isFinite(zone)) out.push({ country: parts[0], zone });
  }
  return out;
}

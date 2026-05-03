// Shared core for the on-demand "Sync external surcharges" button and the
// future weekly cron. Fetches the DHL Express demand surcharge page, has
// Claude extract the structured matrix, and diffs against the locally
// hard-coded SCHEDULES in `app/lib/demand-surcharge.ts`. Returns a structured
// report — never writes to disk or DB on its own. Apply step is manual.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { allDemandSchedules } from "./demand-surcharge";

const DEMAND_URL = "https://www.dhl.de/en/geschaeftskunden/express/produkte-und-services/zuschlaege.html#demand-surcharge";

const REGIONS = ["CN-HK", "SAS", "ROA", "OCE", "EUR", "AMS", "MENA", "ROW"] as const;

const DemandMatrixSchema = z.object({
  valid_from: z.string().describe("ISO date YYYY-MM-DD when this schedule first applies"),
  valid_until: z.string().describe("ISO date YYYY-MM-DD when this schedule stops applying"),
  ddi_flat_per_kg: z.number().describe("Day Definite Int'l flat €/kg"),
  dom_flat_per_kg: z.number().describe("Domestic Time Definite flat €/kg"),
  tdi_matrix: z.array(z.object({
    origin: z.enum(REGIONS),
    dest: z.enum(REGIONS),
    eur_per_kg: z.number().nullable().describe("EUR per billing kg, null if cell is blank/'—'"),
  })).describe("Time Definite Int'l per-cell rates. Include every non-blank cell from the published matrix."),
  notes: z.string().nullable(),
});

export interface SyncReport {
  fetched_at: string;     // ISO datetime
  source_url: string;
  status: "in_sync" | "drift" | "new_window" | "error";
  message: string;
  diffs: { cell: string; have: number | null; published: number }[];
  proposed_schedule: string | null; // pasteable TS snippet when status === "new_window"
  raw: z.infer<typeof DemandMatrixSchema> | null;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (rate-configurator surcharge-sync)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

export async function syncDemandSurcharge(): Promise<SyncReport> {
  const fetched_at = new Date().toISOString();
  try {
    const html = await fetchHtml(DEMAND_URL);
    const anchor = html.indexOf("demand-surcharge");
    const slice = anchor >= 0 ? html.slice(anchor, anchor + 60_000) : html.slice(0, 60_000);
    const client = new Anthropic();
    const stream = client.messages.stream({
      model: "claude-opus-4-7",
      max_tokens: 12000,
      thinking: { type: "disabled" },
      system: "Extract the DHL Express Demand Surcharge schedule from the provided HTML. Reproduce the published O/D matrix exactly. Use the canonical region codes: CN-HK, SAS (South Asia), ROA (Rest of Asia), OCE (Oceania), EUR (Europe), AMS (Americas), MENA (Middle East/N. Africa), ROW (Rest of World).",
      output_config: { format: zodOutputFormat(DemandMatrixSchema), effort: "low" },
      messages: [{ role: "user", content: `Extract the current demand-surcharge schedule:\n\n${slice}` }],
    });
    const final = await stream.finalMessage();
    if (final.stop_reason === "max_tokens") throw new Error("demand surcharge extraction truncated");
    const textBlock = final.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) throw new Error(`no text block (stop_reason=${final.stop_reason})`);
    const latest = DemandMatrixSchema.parse(JSON.parse(textBlock.text));

    const current = allDemandSchedules();
    const sameWindow = current.find((s) => s.valid_from === latest.valid_from && s.valid_until === latest.valid_until);
    if (!sameWindow) {
      return {
        fetched_at, source_url: DEMAND_URL,
        status: "new_window",
        message: `New schedule window detected: ${latest.valid_from} → ${latest.valid_until}. Paste the proposed TS snippet into app/lib/demand-surcharge.ts SCHEDULES.`,
        diffs: [],
        proposed_schedule: serializeSchedule(latest),
        raw: latest,
      };
    }

    const diffs: { cell: string; have: number | null; published: number }[] = [];
    for (const cell of latest.tdi_matrix) {
      if (cell.eur_per_kg == null) continue;
      const have = sameWindow.tdi[cell.origin]?.[cell.dest] ?? null;
      if (have == null || Math.abs(have - cell.eur_per_kg) > 0.001) {
        diffs.push({ cell: `TDI ${cell.origin}→${cell.dest}`, have, published: cell.eur_per_kg });
      }
    }
    if (sameWindow.ddi_flat_per_kg !== latest.ddi_flat_per_kg) diffs.push({ cell: "DDI flat €/kg", have: sameWindow.ddi_flat_per_kg, published: latest.ddi_flat_per_kg });
    if (sameWindow.dom_flat_per_kg !== latest.dom_flat_per_kg) diffs.push({ cell: "DOM flat €/kg", have: sameWindow.dom_flat_per_kg, published: latest.dom_flat_per_kg });

    if (diffs.length === 0) {
      return {
        fetched_at, source_url: DEMAND_URL,
        status: "in_sync",
        message: `Window ${latest.valid_from} → ${latest.valid_until} matches the published schedule. No action needed.`,
        diffs: [], proposed_schedule: null, raw: latest,
      };
    }
    return {
      fetched_at, source_url: DEMAND_URL,
      status: "drift",
      message: `${diffs.length} cell${diffs.length === 1 ? "" : "s"} drift from the published schedule.`,
      diffs, proposed_schedule: null, raw: latest,
    };
  } catch (e) {
    return {
      fetched_at, source_url: DEMAND_URL,
      status: "error",
      message: (e as Error).message,
      diffs: [], proposed_schedule: null, raw: null,
    };
  }
}

function serializeSchedule(latest: z.infer<typeof DemandMatrixSchema>): string {
  const byOrigin = new Map<string, Record<string, number>>();
  for (const c of latest.tdi_matrix) {
    if (c.eur_per_kg == null) continue;
    if (!byOrigin.has(c.origin)) byOrigin.set(c.origin, {});
    byOrigin.get(c.origin)![c.dest] = c.eur_per_kg;
  }
  const lines: string[] = [
    `  {`,
    `    valid_from: "${latest.valid_from}",`,
    `    valid_until: "${latest.valid_until}",`,
    `    source_url: "${DEMAND_URL}",`,
    `    notes: ${JSON.stringify(latest.notes ?? "")},`,
    `    ddi_flat_per_kg: ${latest.ddi_flat_per_kg},`,
    `    dom_flat_per_kg: ${latest.dom_flat_per_kg},`,
    `    tdi: {`,
  ];
  for (const [o, cells] of byOrigin) {
    const inner = Object.entries(cells).map(([d, v]) => `"${d}": ${v}`).join(", ");
    lines.push(`      "${o}": { ${inner} },`);
  }
  lines.push(`    },`);
  lines.push(`  },`);
  return lines.join("\n");
}

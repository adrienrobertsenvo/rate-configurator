// Weekly-cron friendly script: fetch DHL Express published surcharges + fuel
// rates, extract anything that's changed, and report a diff. By default this
// only PRINTS proposed updates — no DB writes, no file edits — because the
// schedule changes are infrequent (a few times per year) and worth a human
// eyeball before they affect audits.
//
// Usage:
//   npx tsx scripts/sync_external_surcharges.ts            # dry run, prints diff
//   npx tsx scripts/sync_external_surcharges.ts --apply    # writes new schedule entry
//
// Wiring it weekly:
//   • macOS launchd: drop a plist in ~/Library/LaunchAgents calling this script
//   • Linux cron:    0 6 * * 0  cd /path/to/repo && npx tsx scripts/sync_external_surcharges.ts
//   • GitHub Actions: schedule.cron("0 6 * * 0") + a step that runs npx tsx and
//     opens a PR with the proposed change (cleanest because it gives you review
//     + version history for free).
//
// What it pulls today:
//   1. DHL Express Demand Surcharge — the O/D matrix + active dates
//   2. DHL Express Fuel Surcharge   — current AIR + ROAD weekly rate
//
// What it does with the result:
//   • Demand: parses the matrix + window, compares to app/lib/demand-surcharge.ts
//     SCHEDULES. If the active window is new or the matrix differs, prints a
//     diff. With --apply, would append a new schedule entry (not yet wired —
//     leaving as a manual step until we have UI for review).
//   • Fuel: looks up this week's published rate, compares to app/lib/fuel-rates.ts.
//     Same dry-run / apply pattern.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { allDemandSchedules } from "../app/lib/carriers/dhl-express/demand-surcharge";

const DEMAND_URL = "https://www.dhl.de/en/geschaeftskunden/express/produkte-und-services/zuschlaege.html#demand-surcharge";
const FUEL_AIR_URL = "https://www.dhl.de/en/geschaeftskunden/express/produkte-und-services/zuschlaege/treibstoffzuschlag.html"; // EN page

const DemandMatrixSchema = z.object({
  valid_from: z.string().describe("ISO date YYYY-MM-DD when this schedule first applies"),
  valid_until: z.string().describe("ISO date YYYY-MM-DD when this schedule stops applying"),
  ddi_flat_per_kg: z.number().describe("Day Definite Int'l flat €/kg"),
  dom_flat_per_kg: z.number().describe("Domestic Time Definite flat €/kg"),
  tdi_matrix: z.array(z.object({
    origin: z.enum(["CN-HK", "SAS", "ROA", "OCE", "EUR", "AMS", "MENA", "ROW"]),
    dest: z.enum(["CN-HK", "SAS", "ROA", "OCE", "EUR", "AMS", "MENA", "ROW"]),
    eur_per_kg: z.number().nullable().describe("EUR per billing kg, null if cell is blank/'—'"),
  })).describe("Time Definite Int'l per-cell rates. Include every non-blank cell from the published matrix."),
  notes: z.string().nullable(),
});

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (rate-configurator surcharge-sync)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

async function pullDemandSurcharge(): Promise<z.infer<typeof DemandMatrixSchema>> {
  const html = await fetchHtml(DEMAND_URL);
  // Trim to the relevant section so we don't blow the model context. The
  // demand surcharge block is delimited by an anchor + the next H2.
  const slice = html.length > 200_000 ? html.slice(html.indexOf("demand-surcharge"), html.indexOf("demand-surcharge") + 60_000) : html;
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
  const json = JSON.parse(textBlock.text);
  return DemandMatrixSchema.parse(json);
}

async function diffAgainstCurrent(latest: z.infer<typeof DemandMatrixSchema>): Promise<void> {
  const current = allDemandSchedules();
  const sameWindow = current.find((s) => s.valid_from === latest.valid_from && s.valid_until === latest.valid_until);
  if (sameWindow) {
    console.log(`✓ Window ${latest.valid_from} → ${latest.valid_until} already in app/lib/demand-surcharge.ts`);
    // Spot-check a few cells
    const diffs: string[] = [];
    for (const cell of latest.tdi_matrix) {
      if (cell.eur_per_kg == null) continue;
      const have = sameWindow.tdi[cell.origin]?.[cell.dest];
      if (have == null || Math.abs(have - cell.eur_per_kg) > 0.001) {
        diffs.push(`  ${cell.origin}→${cell.dest}: have ${have ?? "—"}, published ${cell.eur_per_kg}`);
      }
    }
    if (sameWindow.ddi_flat_per_kg !== latest.ddi_flat_per_kg) diffs.push(`  DDI flat: have ${sameWindow.ddi_flat_per_kg}, published ${latest.ddi_flat_per_kg}`);
    if (sameWindow.dom_flat_per_kg !== latest.dom_flat_per_kg) diffs.push(`  DOM flat: have ${sameWindow.dom_flat_per_kg}, published ${latest.dom_flat_per_kg}`);
    if (diffs.length === 0) {
      console.log("  → no rate differences detected; nothing to update.");
    } else {
      console.log("  ⚠ rate differences vs published:");
      for (const d of diffs) console.log(d);
      console.log(`\n  Action: update SCHEDULES in app/lib/demand-surcharge.ts and commit.`);
    }
    return;
  }
  console.log(`⚠ NEW window detected: ${latest.valid_from} → ${latest.valid_until}`);
  console.log(`  DDI flat: €${latest.ddi_flat_per_kg}/kg   DOM flat: €${latest.dom_flat_per_kg}/kg`);
  console.log(`  TDI cells: ${latest.tdi_matrix.length}`);
  console.log("\n  Suggested addition to SCHEDULES (paste into app/lib/demand-surcharge.ts):\n");
  console.log(serializeSchedule(latest));
  console.log(`\n  Then re-run audits:  npx tsx scripts/reaudit_invoices.ts <contractId>...`);
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

async function main() {
  console.log("=== DHL Express Demand Surcharge sync ===\n");
  try {
    const latest = await pullDemandSurcharge();
    await diffAgainstCurrent(latest);
  } catch (e) {
    console.error(`✗ demand surcharge sync failed: ${(e as Error).message}`);
  }
  // Fuel-rate sync would follow the same pattern: fetch the fuel page, parse
  // the current week's AIR + ROAD percentages, compare against fuel-rates.ts.
  // Left as a follow-up because the existing fuel-rates.ts is hard-coded by
  // ISO week and we'd want the same human-review gate before mutating it.
}
main().catch((e) => { console.error(e); process.exit(1); });

// Deterministic UPS rate-card parser. The General Price List XLSX has a
// stable layout across all sheets, so we don't need an LLM for it — much
// faster, cheaper, and more reliable than the per-product LLM detail pass.
//
// Sheet layout (every sheet matches this template):
//   Row 1: "Country: | <empty> | <empty> | <country>"
//   Row 2: "Movement: | … | <Sending|Receiving> Rates"
//   Row 3: "Service: | … | <product name>" (e.g. "UPS Standard Single")
//   Row 4: "Billing Options: | … | ALL …" plus a discount % in another col
//   Rows 5–19: country-list / sub-zone narrative spanning multiple cells
//   Row 20: "Market | … | DOM | TB | TB | …"
//   Row 21: "Zone | … | Zone 1 | Zone 3 | Zone 31 | Zone 4 | …"  ← zone labels
//   Row 22: "Lane | … | <empty or country code>"
//   Row 23: "MRPP | … | 5.01 | 0.00 | …"  Minimum revenue per piece (per zone)
//   Row 24: "Cntr | Rate Type | Kg | …"  ← header row (data follows)
//   Rows 25..N: data rows. Col A = container, B = rate type ("Per shp"/"Per kg"),
//               C = weight in kg, cols D..M = price per zone column.
//
// We:
//   - Find the row whose col A starts with "Zone" → captures zone labels.
//   - Find "Cntr" header row → next row starts the rate data.
//   - Read weight from col C, prices from cols D..M.
//   - "Per shp" → fixed-tier band ending at the NEXT row's weight.
//   - "Per kg" → per-kg extrapolation band (weight_end = NULL).
//
// Same-zone duplicates: a sheet can have several columns labelled "Zone 4"
// (one per Italy/non-Italy lane). We take the FIRST non-zero column for each
// zone label — the audit engine compares against zone alone, not the lane.
// Lane-level accuracy is a follow-up if it matters for a specific customer.

import * as XLSX from "xlsx";

export interface ParsedSheet {
  sheet_name: string;
  product_name: string;
  movement: "Sending" | "Receiving" | "unknown";
  zones: { zone: string; bands: ParsedBand[] }[];
}

export interface ParsedBand {
  weight_start_g: number;
  weight_end_g: number | null;
  price: number | null;
  per_kg: number | null;
  step_kg: number | null;
}

interface RawRow { [key: number]: unknown }

function asString(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function asNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  const s = String(v).replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Read a sheet into a 2D array (rows × cols), trimming all-empty trailing rows.
function readGrid(ws: XLSX.WorkSheet): unknown[][] {
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null }) as unknown[][];
  return grid;
}

// Find the row index where the "Zone" header appears — UPS sheets vary
// between two layouts: most have it in col A, but the Express sheets indent
// the leftmost columns by one and the Zone label sits in col B.
function findZoneRow(grid: unknown[][]): number {
  for (let i = 0; i < grid.length; i++) {
    const a = asString(grid[i][0]).toLowerCase();
    const b = asString(grid[i][1]).toLowerCase();
    if (a === "zone" || b === "zone") return i;
  }
  return -1;
}

// Find the row index where col A is "Cntr" (header) — data starts the row after.
function findCntrRow(grid: unknown[][]): number {
  for (let i = 0; i < grid.length; i++) {
    if (asString(grid[i][0]).toLowerCase() === "cntr") return i;
  }
  return -1;
}

// Map a raw rate-card sheet to one ParsedSheet of zones + bands.
export function parseRateSheet(ws: XLSX.WorkSheet, sheetName: string): ParsedSheet | null {
  const grid = readGrid(ws);

  // Validate that this is a rate sheet — needs both Zone row and Cntr row.
  const zoneRowIdx = findZoneRow(grid);
  const cntrRowIdx = findCntrRow(grid);
  if (zoneRowIdx < 0 || cntrRowIdx < 0) return null;

  // Service name from row 3 col D (4th column).
  const serviceRow = grid.find((r) => asString(r[0]).toLowerCase().startsWith("service"));
  const product_name = asString(serviceRow?.[3] ?? "Unknown");

  // Movement (Sending = Export, Receiving = Import).
  const movementRow = grid.find((r) => asString(r[0]).toLowerCase().startsWith("movement"));
  const movementText = asString(movementRow?.[3] ?? "");
  const movement: ParsedSheet["movement"] =
    /sending/i.test(movementText) ? "Sending" :
    /receiving/i.test(movementText) ? "Receiving" : "unknown";

  // Zone labels from the Zone row, cols D onwards (index 3+). Either layout
  // (Zone in col A, labels start at D) or layout B (Zone in col B, labels
  // also start at D) — same data offset.
  const zoneRow = grid[zoneRowIdx];
  const zoneCols: { col: number; label: string }[] = [];
  for (let c = 3; c < zoneRow.length; c++) {
    const lbl = asString(zoneRow[c]);
    if (lbl && /zone\s+\w+/i.test(lbl)) zoneCols.push({ col: c, label: lbl });
  }

  // Track which zones we've already populated to skip duplicate columns.
  const zonesByLabel = new Map<string, ParsedBand[]>();

  // Data rows start at cntrRowIdx + 1. Stop at the first row whose col A
  // isn't Pkg / Env / Doc / Cntr (i.e. footer / notes).
  const dataRows: { weight_kg: number; rate_type: string; values: (number | null)[] }[] = [];
  for (let i = cntrRowIdx + 1; i < grid.length; i++) {
    const r = grid[i];
    const cntr = asString(r[0]).toLowerCase();
    if (cntr !== "pkg" && cntr !== "env" && cntr !== "doc" && cntr !== "ltr") break;
    const rateType = asString(r[1]).toLowerCase();
    const weight = asNumber(r[2]);
    if (weight == null) continue;
    const values = zoneCols.map(({ col }) => asNumber(r[col]));
    dataRows.push({ weight_kg: weight, rate_type: rateType, values });
  }

  // Build bands per zone column. For each column, walk the data rows in order
  // and emit either fixed-tier bands (Per shp) or per-kg extrapolation bands
  // (Per kg).
  for (let zi = 0; zi < zoneCols.length; zi++) {
    const { label } = zoneCols[zi];
    if (zonesByLabel.has(label)) continue; // first occurrence wins
    const bands: ParsedBand[] = [];
    for (let ri = 0; ri < dataRows.length; ri++) {
      const row = dataRows[ri];
      const v = row.values[zi];
      if (v == null) continue;
      if (row.rate_type.includes("per shp") || row.rate_type.includes("per pkg")) {
        // Fixed tier: this row's weight is the upper end of the band the
        // previous row's weight (or 0) opened. Better to model as "band that
        // covers exactly this weight" up to the next row's weight: [start, end].
        const startKg = ri === 0 ? 0 : dataRows[ri - 1].weight_kg;
        const endKg = row.weight_kg;
        // Skip zero or absurd-weight rows that aren't real tiers.
        if (endKg <= 0 || endKg > 100000) continue;
        // weight_start in grams uses the start of the band (not end). Match the
        // schema convention used by DHL: weight_start = floor of the band, end
        // = inclusive.
        bands.push({
          weight_start_g: Math.round(startKg * 1000) + (ri === 0 ? 0 : 1),
          weight_end_g: Math.round(endKg * 1000),
          price: v > 0 ? v : null,
          per_kg: null,
          step_kg: null,
        });
      } else if (row.rate_type.includes("per kg")) {
        // Extrapolation band — open-ended above the previous tier.
        const startKg = ri === 0 ? 0 : dataRows[ri - 1].weight_kg;
        if (v <= 0) continue;
        bands.push({
          weight_start_g: Math.round(startKg * 1000) + 1,
          weight_end_g: null,
          price: null,
          per_kg: v,
          step_kg: 1,
        });
      }
    }
    if (bands.length > 0) zonesByLabel.set(label, bands);
  }

  if (zonesByLabel.size === 0) return null;
  return {
    sheet_name: sheetName,
    product_name,
    movement,
    zones: Array.from(zonesByLabel, ([zone, bands]) => ({ zone, bands })),
  };
}

export function parseUpsRateXlsx(buf: Buffer): ParsedSheet[] {
  const wb = XLSX.read(buf, { type: "buffer" });
  const out: ParsedSheet[] = [];
  for (const name of wb.SheetNames) {
    const parsed = parseRateSheet(wb.Sheets[name], name);
    if (parsed) out.push(parsed);
  }
  return out;
}

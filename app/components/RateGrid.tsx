"use client";

import { useMemo, useState, useTransition } from "react";
import type { SubProductDTO, PriceBandDTO } from "../lib/types";
import { setBulkBands } from "../actions/contract";

interface Row {
  weight_start: number;
  weight_end: number;
  prices: Record<string, number | "">;
  confidence: Record<string, number | null>;
}

type TailBand = Extract<PriceBandDTO, { per_kg: number }>;

function splitBands(sub: SubProductDTO): { rows: Row[]; tails: Record<string, TailBand[]>; zones: string[] } {
  const zones = Object.keys(sub.prices);
  const tails: Record<string, TailBand[]> = {};
  const rowKeys = new Set<string>();
  for (const z of zones) {
    tails[z] = [];
    for (const b of sub.prices[z]) {
      if ("price" in b) rowKeys.add(`${b.weight_start}-${b.weight_end}`);
      else tails[z].push(b);
    }
  }
  const rows = [...rowKeys]
    .map((k) => {
      const [s, e] = k.split("-").map(Number);
      return { weight_start: s, weight_end: e };
    })
    .sort((a, b) => a.weight_start - b.weight_start)
    .map<Row>(({ weight_start, weight_end }) => {
      const prices: Record<string, number | ""> = {};
      const confidence: Record<string, number | null> = {};
      for (const z of zones) {
        const band = sub.prices[z].find(
          (b) => "price" in b && b.weight_start === weight_start && b.weight_end === weight_end,
        ) as Extract<PriceBandDTO, { price: number }> | undefined;
        prices[z] = band?.price ?? "";
        confidence[z] = band?.confidence ?? null;
      }
      return { weight_start, weight_end, prices, confidence };
    });
  return { rows, tails, zones };
}

function assemble(rows: Row[], tails: Record<string, TailBand[]>, zones: string[]): Record<string, PriceBandDTO[]> {
  const out: Record<string, PriceBandDTO[]> = {};
  for (const z of zones) {
    const bands: PriceBandDTO[] = [];
    for (const r of rows) {
      const p = r.prices[z];
      if (p !== "" && !Number.isNaN(Number(p))) {
        bands.push({ weight_start: r.weight_start, weight_end: r.weight_end, price: Number(p) });
      }
    }
    for (const t of tails[z] ?? []) bands.push(t);
    out[z] = bands;
  }
  return out;
}

export function RateGrid({ contractId, sub }: { contractId: number; sub: SubProductDTO }) {
  const initial = useMemo(() => splitBands(sub), [sub]);
  const [rows, setRows] = useState(initial.rows);
  const [zones, setZones] = useState<string[]>(initial.zones.length ? initial.zones : ["Zone 1"]);
  const [tails] = useState(initial.tails);
  const [pending, start] = useTransition();
  const [syncKey, setSyncKey] = useState(sub.id);

  if (syncKey !== sub.id) {
    setSyncKey(sub.id);
    setRows(initial.rows);
    setZones(initial.zones.length ? initial.zones : ["Zone 1"]);
  }

  const commit = (next: Row[], nextZones?: string[]) => {
    const zs = nextZones ?? zones;
    setRows(next);
    if (nextZones) setZones(nextZones);
    start(async () => {
      await setBulkBands(contractId, sub.id, assemble(next, tails, zs));
    });
  };

  const updateCell = (ri: number, zone: string, value: string) => {
    const next = [...rows];
    next[ri] = { ...next[ri], prices: { ...next[ri].prices, [zone]: value === "" ? "" : Number(value) } };
    commit(next);
  };

  const updateWeight = (ri: number, field: "weight_start" | "weight_end", value: string) => {
    const next = [...rows];
    next[ri] = { ...next[ri], [field]: Number(value) };
    commit(next);
  };

  const addRow = () => {
    const last = rows[rows.length - 1];
    const start = last ? last.weight_end : 0;
    const end = start + 500;
    const prices: Record<string, number | ""> = {};
    const confidence: Record<string, number | null> = {};
    for (const z of zones) {
      prices[z] = "";
      confidence[z] = null;
    }
    commit([...rows, { weight_start: start, weight_end: end, prices, confidence }]);
  };

  const removeRow = (ri: number) => commit(rows.filter((_, i) => i !== ri));

  const setZoneCount = (count: number) => {
    const next = Array.from({ length: Math.max(1, count) }, (_, i) => `Zone ${i + 1}`);
    const nextRows = rows.map((r) => {
      const prices: Record<string, number | ""> = {};
      for (const z of next) prices[z] = r.prices[z] ?? "";
      return { ...r, prices };
    });
    commit(nextRows, next);
  };

  const onCellPaste = (e: React.ClipboardEvent<HTMLInputElement>, rowStart: number, colStart: number) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text.includes("\t") && !text.includes("\n")) return;
    e.preventDefault();
    const grid = text
      .split(/\r?\n/)
      .filter((l) => l.length > 0)
      .map((l) => l.split("\t"));
    const next = [...rows];
    for (let r = 0; r < grid.length; r++) {
      const ri = rowStart + r;
      if (ri >= next.length) {
        const last = next[next.length - 1];
        const ws = last ? last.weight_end : 0;
        const prices: Record<string, number | ""> = {};
        const confidence: Record<string, number | null> = {};
        for (const z of zones) {
          prices[z] = "";
          confidence[z] = null;
        }
        next.push({ weight_start: ws, weight_end: ws + 500, prices, confidence });
      }
      for (let c = 0; c < grid[r].length; c++) {
        const zi = colStart + c;
        if (zi >= zones.length) break;
        const raw = grid[r][c].replace(",", ".").trim();
        const num = Number(raw);
        const prices = { ...next[ri].prices };
        const confidence = { ...next[ri].confidence };
        prices[zones[zi]] = raw === "" || Number.isNaN(num) ? "" : num;
        confidence[zones[zi]] = 1.0;
        next[ri] = { ...next[ri], prices, confidence };
      }
    }
    commit(next);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <label className="text-gray-600">Zones:</label>
        <input
          type="number"
          min={1}
          max={40}
          value={zones.length}
          onChange={(e) => setZoneCount(Number(e.target.value))}
          className="w-20 rounded border border-gray-300 px-2 py-1"
        />
        <span className="text-gray-500 text-xs ml-2">Paste tab-separated from Excel. Weight is in grams.</span>
        {pending && <span className="ml-auto text-xs text-blue-600">saving…</span>}
      </div>
      <div className="overflow-auto border border-gray-200 rounded bg-white">
        <table className="text-sm border-collapse">
          <thead className="bg-gray-50 sticky top-0 z-10">
            <tr>
              <th className="px-2 py-1 border-b border-r border-gray-200 text-left">From (g)</th>
              <th className="px-2 py-1 border-b border-r border-gray-200 text-left">To (g)</th>
              {zones.map((z) => (
                <th key={z} className="px-2 py-1 border-b border-r border-gray-200 text-left font-medium">
                  {z}
                </th>
              ))}
              <th className="px-2 py-1 border-b border-gray-200"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className="even:bg-gray-50">
                <td className="border-b border-r border-gray-100 p-0">
                  <input
                    className="w-24 px-2 py-1 bg-transparent focus:bg-yellow-50 outline-none"
                    type="number"
                    value={r.weight_start}
                    onChange={(e) => updateWeight(ri, "weight_start", e.target.value)}
                  />
                </td>
                <td className="border-b border-r border-gray-100 p-0">
                  <input
                    className="w-24 px-2 py-1 bg-transparent focus:bg-yellow-50 outline-none"
                    type="number"
                    value={r.weight_end}
                    onChange={(e) => updateWeight(ri, "weight_end", e.target.value)}
                  />
                </td>
                {zones.map((z, ci) => {
                  const c = r.confidence[z];
                  const bg =
                    c == null || r.prices[z] === ""
                      ? ""
                      : c < 0.5
                        ? "bg-red-50"
                        : c < 0.8
                          ? "bg-amber-50"
                          : "";
                  const title = c == null ? undefined : `confidence: ${(c * 100).toFixed(0)}%`;
                  return (
                    <td key={z} className={`border-b border-r border-gray-100 p-0 ${bg}`} title={title}>
                      <input
                        className="w-24 px-2 py-1 bg-transparent focus:bg-yellow-100 outline-none text-right"
                        type="number"
                        step="0.01"
                        value={r.prices[z] ?? ""}
                        onChange={(e) => updateCell(ri, z, e.target.value)}
                        onPaste={(e) => onCellPaste(e, ri, ci)}
                      />
                    </td>
                  );
                })}
                <td className="border-b border-gray-100 text-center">
                  <button className="text-xs text-red-600 px-2 hover:underline" onClick={() => removeRow(ri)}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="text-sm px-2 py-1 rounded bg-gray-100 hover:bg-gray-200" onClick={addRow}>
        + weight break
      </button>
    </div>
  );
}

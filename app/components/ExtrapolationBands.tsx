"use client";

import { useMemo, useState, useTransition } from "react";
import type { SubProductDTO, PriceBandDTO } from "../lib/types";
import { setZoneBands } from "../actions/contract";

type TailBand = Extract<PriceBandDTO, { per_kg: number }>;

export function ExtrapolationBands({ contractId, sub }: { contractId: number; sub: SubProductDTO }) {
  const zones = useMemo(() => Object.keys(sub.prices), [sub.prices]);
  const initialTails = useMemo(() => {
    const out: Record<string, TailBand[]> = {};
    for (const z of zones) out[z] = sub.prices[z].filter((b): b is TailBand => "per_kg" in b);
    return out;
  }, [sub.prices, zones]);

  const [tails, setTails] = useState(initialTails);
  const [pending, start] = useTransition();
  const [syncKey, setSyncKey] = useState(sub.id);

  if (syncKey !== sub.id) {
    setSyncKey(sub.id);
    setTails(initialTails);
  }

  const persist = (zone: string, nextTails: TailBand[]) => {
    const fixed = sub.prices[zone].filter((b) => "price" in b);
    start(async () => {
      await setZoneBands(contractId, sub.id, zone, [...fixed, ...nextTails]);
    });
  };

  const updateTail = (zone: string, idx: number, patch: Partial<TailBand>) => {
    const next = { ...tails };
    const arr = [...(next[zone] ?? [])];
    arr[idx] = { ...arr[idx], ...patch };
    next[zone] = arr;
    setTails(next);
    persist(zone, arr);
  };

  const addTail = (zone: string) => {
    const existing = tails[zone] ?? [];
    const last = existing[existing.length - 1];
    const weight_start = last ? (last.step ? last.weight_start + last.step * 1000 : last.weight_start + 1000) : 30000;
    const arr: TailBand[] = [...existing, { weight_start, per_kg: 1 }];
    setTails({ ...tails, [zone]: arr });
    persist(zone, arr);
  };

  const removeTail = (zone: string, idx: number) => {
    const arr = (tails[zone] ?? []).filter((_, i) => i !== idx);
    setTails({ ...tails, [zone]: arr });
    persist(zone, arr);
  };

  return (
    <div className="mt-4 bg-white rounded border border-gray-200 p-3">
      <div className="flex items-baseline justify-between mb-2">
        <h4 className="text-sm font-medium">Extrapolation bands (Folgeraten)</h4>
        <span className="text-xs text-gray-500">
          per-kg rates above the main table {pending && <span className="ml-2 text-blue-600">saving…</span>}
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {zones.map((z) => (
          <div key={z} className="border border-gray-100 rounded p-2">
            <div className="text-xs font-medium text-gray-700 mb-1">{z}</div>
            <table className="text-xs w-full">
              <thead className="text-gray-500">
                <tr>
                  <th className="text-left font-normal">from (g)</th>
                  <th className="text-left font-normal">per kg</th>
                  <th className="text-left font-normal">step</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(tails[z] ?? []).map((t, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        type="number"
                        className="w-20 border rounded px-1 py-0.5"
                        value={t.weight_start}
                        onChange={(e) => updateTail(z, i, { weight_start: Number(e.target.value) })}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.01"
                        className="w-16 border rounded px-1 py-0.5"
                        value={t.per_kg}
                        onChange={(e) => updateTail(z, i, { per_kg: Number(e.target.value) })}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        className="w-12 border rounded px-1 py-0.5"
                        value={t.step ?? ""}
                        onChange={(e) =>
                          updateTail(z, i, { step: e.target.value === "" ? null : Number(e.target.value) })
                        }
                      />
                    </td>
                    <td>
                      <button className="text-red-600 hover:underline px-1" onClick={() => removeTail(z, i)}>
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="text-xs text-blue-600 hover:underline mt-1" onClick={() => addTail(z)}>
              + band
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

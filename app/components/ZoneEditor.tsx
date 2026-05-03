"use client";

import { useMemo, useState, useTransition } from "react";
import { removeCountry, setCountryZone, updateZoneMap } from "../actions/zones";
import { ZoneBulkImport } from "./ZoneBulkImport";

interface Props {
  zoneMap: {
    id: number;
    carrier: string;
    billing_country: string;
    zone_group: string;
    spec_name: string;
    valid_from: string;
    currency_code: string;
    contractId: number | null;
    contractName: string | null;
    countries: { country: string; zone: number }[];
  };
}

export function ZoneEditor({ zoneMap }: Props) {
  const [newCc, setNewCc] = useState("");
  const [newZone, setNewZone] = useState(1);
  const [filter, setFilter] = useState("");
  const [pending, start] = useTransition();

  const entries = useMemo(() => {
    const arr = [...zoneMap.countries].sort((a, b) => a.country.localeCompare(b.country));
    return filter ? arr.filter((e) => e.country.includes(filter.toUpperCase())) : arr;
  }, [zoneMap.countries, filter]);

  const meta = (patch: Parameters<typeof updateZoneMap>[1]) =>
    start(async () => {
      await updateZoneMap(zoneMap.id, patch);
    });

  return (
    <div className="p-4 space-y-4">
      <div className="text-xs text-gray-600">
        {zoneMap.contractId
          ? `Contract override · ${zoneMap.contractName ?? `contract ${zoneMap.contractId}`}`
          : "Baseline (all contracts without override)"}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-sm">
        <div className="md:col-span-2">
          <div className="text-xs uppercase text-gray-600">Spec name</div>
          <input className="w-full rounded border px-2 py-1" defaultValue={zoneMap.spec_name} onBlur={(e) => meta({ spec_name: e.target.value })} />
        </div>
        <div>
          <div className="text-xs uppercase text-gray-600">Carrier</div>
          <input className="w-full rounded border px-2 py-1" defaultValue={zoneMap.carrier} onBlur={(e) => meta({ carrier: e.target.value })} />
        </div>
        <div>
          <div className="text-xs uppercase text-gray-600">Billing country</div>
          <input className="w-full rounded border px-2 py-1 font-mono uppercase" maxLength={2} defaultValue={zoneMap.billing_country} onBlur={(e) => meta({ billing_country: e.target.value.toUpperCase() })} />
        </div>
        <div>
          <div className="text-xs uppercase text-gray-600">Zone group</div>
          <input className="w-full rounded border px-2 py-1" defaultValue={zoneMap.zone_group} onBlur={(e) => meta({ zone_group: e.target.value })} />
        </div>
        <div>
          <div className="text-xs uppercase text-gray-600">Valid from</div>
          <input type="date" className="w-full rounded border px-2 py-1" defaultValue={zoneMap.valid_from} onBlur={(e) => meta({ valid_from: e.target.value })} />
        </div>
      </div>

      <ZoneBulkImport zoneMapId={zoneMap.id} />

      <div className="flex items-end gap-2">
        <div>
          <div className="text-xs uppercase text-gray-600">Filter</div>
          <input
            className="rounded border px-2 py-1"
            placeholder="DE"
            value={filter}
            onChange={(e) => setFilter(e.target.value.toUpperCase())}
          />
        </div>
        <div>
          <div className="text-xs uppercase text-gray-600">Country (ISO2)</div>
          <input
            className="w-24 rounded border px-2 py-1 font-mono"
            maxLength={2}
            value={newCc}
            onChange={(e) => setNewCc(e.target.value.toUpperCase())}
          />
        </div>
        <div>
          <div className="text-xs uppercase text-gray-600">Zone</div>
          <input
            className="w-20 rounded border px-2 py-1"
            type="number"
            min={1}
            value={newZone}
            onChange={(e) => setNewZone(Number(e.target.value))}
          />
        </div>
        <button
          className="rounded bg-blue-600 text-white px-3 py-1.5 text-sm disabled:opacity-50"
          disabled={newCc.length !== 2}
          onClick={() =>
            start(async () => {
              await setCountryZone(zoneMap.id, newCc, newZone);
              setNewCc("");
            })
          }
        >
          Add / update
        </button>
        {pending && <span className="text-xs text-blue-600 self-center">saving…</span>}
      </div>

      <div className="overflow-auto border rounded bg-white max-h-[60vh]">
        <table className="text-sm w-full">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              <th className="px-2 py-1 text-left border-b">Country</th>
              <th className="px-2 py-1 text-left border-b">Zone</th>
              <th className="border-b"></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.country} className="even:bg-gray-50">
                <td className="px-2 py-1 border-b font-mono">{e.country}</td>
                <td className="px-2 py-1 border-b">
                  <input
                    type="number"
                    min={1}
                    className="w-20 border rounded px-1 py-0.5"
                    defaultValue={e.zone}
                    onBlur={(ev) =>
                      start(async () => {
                        await setCountryZone(zoneMap.id, e.country, Number(ev.target.value));
                      })
                    }
                  />
                </td>
                <td className="px-2 py-1 border-b text-right">
                  <button
                    className="text-xs text-red-600 hover:underline"
                    onClick={() =>
                      start(async () => {
                        await removeCountry(zoneMap.id, e.country);
                      })
                    }
                  >
                    remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

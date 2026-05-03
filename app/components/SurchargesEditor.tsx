"use client";

import { useState, useTransition } from "react";
import type { SurchargeDTO } from "../lib/types";
import { addAddon, removeAddon, updateAddon } from "../actions/contract";
import { SURCHARGES } from "../lib/surcharge-meta";

const KINDS = ["flat", "per_kg", "per_shipment", "percent", "percent_of_value", "percent_of_taxes"] as const;
type Kind = (typeof KINDS)[number];

const SCOPES = ["any", "domestic", "international"] as const;
type Scope = (typeof SCOPES)[number];

function kindHint(kind: Kind, hasMin: boolean): string {
  switch (kind) {
    case "flat":
      return "fixed € per shipment";
    case "per_kg":
      return hasMin ? "max(€ × weight_kg, min)" : "€ × weight_kg";
    case "per_shipment":
      return "fixed € per shipment (labelled per-shipment)";
    case "percent":
      return "% of weight charge (enter 30 for 30%)";
    case "percent_of_value":
      return hasMin ? "max(% × declared_value, min)" : "% × declared_value (enter 1 for 1%)";
    case "percent_of_taxes":
      return hasMin ? "max(% × (Duty + VAT + levies), min) — DHL UK ‘Duty Tax Importer’" : "% × (Duty + VAT + levies)";
  }
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Canonical billing code lookup keyed by normalized surcharge name. Used to
// suggest the right invoice code when the contract still has a UNK-… placeholder.
const CANONICAL_CODE_BY_NAME = new Map<string, string>(
  SURCHARGES.map((s) => [normalizeName(s.name), s.code]),
);

function suggestCode(name: string, currentCode: string): string | null {
  const canonical = CANONICAL_CODE_BY_NAME.get(normalizeName(name));
  if (!canonical || canonical === currentCode) return null;
  return canonical;
}

export function SurchargesEditor({
  contractId,
  addons,
}: {
  contractId: number;
  addons: SurchargeDTO[];
}) {
  const [pending, start] = useTransition();
  const [entry, setEntry] = useState<{ code: string; name: string; kind: Kind; amount: string }>({
    code: "",
    name: "",
    kind: "flat",
    amount: "",
  });

  const sorted = [...addons].sort((a, b) => a.code.localeCompare(b.code));

  return (
    <div className="p-4 space-y-3 max-w-5xl">
      <div>
        <h3 className="text-sm font-medium">Surcharge rules</h3>
        <p className="text-xs text-gray-600 mt-1">
          These are the rules the audit engine uses to verify invoice surcharges. Codes must match what&apos;s on the invoice
          (e.g. <code className="font-mono">FF</code>, <code className="font-mono">YB</code>). Missing amounts leave that line&apos;s surcharge status as <em>unresolved</em>.
        </p>
      </div>

      <table className="text-sm w-full bg-white border border-gray-200 rounded">
        <thead className="bg-gray-50">
          <tr>
            <th className="text-left px-2 py-1 border-b w-32">Code</th>
            <th className="text-left px-2 py-1 border-b">Name</th>
            <th className="text-left px-2 py-1 border-b w-32">Kind</th>
            <th className="text-right px-2 py-1 border-b w-24">Amount</th>
            <th className="text-right px-2 py-1 border-b w-24" title="Minimum euro charge for per-kg surcharges. Final = max(amount × weight, min).">Min €</th>
            <th className="text-left px-2 py-1 border-b w-32" title="When DHL bills a single code (e.g. OO Remote Area) but the rate differs by class, scope this rule to domestic-only or international-only.">Scope</th>
            <th className="text-left px-2 py-1 border-b">Description</th>
            <th className="border-b w-16"></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => {
            const suggestion = suggestCode(s.name, s.code);
            return (
              <tr key={s.id} className="even:bg-gray-50">
                <td className="px-2 py-1 border-b">
                  <div className="flex items-center gap-1">
                    <input
                      className="w-20 border rounded px-1 py-0.5 font-mono"
                      defaultValue={s.code}
                      onBlur={(e) =>
                        start(async () => {
                          await updateAddon(contractId, s.id, { code: e.target.value.trim() });
                        })
                      }
                    />
                    {suggestion && (
                      <button
                        type="button"
                        title={`Apply canonical billing code "${suggestion}" — matches DHL's invoice code for "${s.name}".`}
                        className="text-xs text-blue-700 hover:underline whitespace-nowrap"
                        onClick={() =>
                          start(async () => {
                            await updateAddon(contractId, s.id, { code: suggestion });
                          })
                        }
                      >
                        →{suggestion}
                      </button>
                    )}
                  </div>
                </td>
                <td className="px-2 py-1 border-b">
                  <input
                    className="w-full border rounded px-1 py-0.5"
                    defaultValue={s.name}
                    onBlur={(e) =>
                      start(async () => {
                        await updateAddon(contractId, s.id, { name: e.target.value });
                      })
                    }
                  />
                </td>
                <td className="px-2 py-1 border-b">
                  <select
                    className="border rounded px-1 py-0.5"
                    defaultValue={s.kind}
                    onChange={(e) =>
                      start(async () => {
                        await updateAddon(contractId, s.id, { kind: e.target.value });
                      })
                    }
                  >
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-1 border-b text-right">
                  <input
                    type="number"
                    step="0.01"
                    className="w-20 border rounded px-1 py-0.5 text-right font-mono"
                    defaultValue={s.amount ?? ""}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      const num = v === "" ? null : Number(v);
                      start(async () => {
                        await updateAddon(contractId, s.id, {
                          amount: num != null && Number.isFinite(num) ? num : null,
                        });
                      });
                    }}
                  />
                </td>
                <td className="px-2 py-1 border-b text-right">
                  <input
                    type="number"
                    step="0.01"
                    className="w-20 border rounded px-1 py-0.5 text-right font-mono"
                    defaultValue={s.min_amount ?? ""}
                    placeholder="—"
                    disabled={s.kind !== "per_kg" && s.kind !== "percent_of_value" && s.kind !== "percent_of_taxes"}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      const num = v === "" ? null : Number(v);
                      start(async () => {
                        await updateAddon(contractId, s.id, {
                          min_amount: num != null && Number.isFinite(num) ? num : null,
                        });
                      });
                    }}
                  />
                </td>
                <td className="px-2 py-1 border-b">
                  <select
                    className="border rounded px-1 py-0.5"
                    defaultValue={s.applies_to ?? "any"}
                    onChange={(e) =>
                      start(async () => {
                        await updateAddon(contractId, s.id, { applies_to: e.target.value });
                      })
                    }
                  >
                    {SCOPES.map((sc) => (
                      <option key={sc} value={sc}>
                        {sc}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-1 border-b text-gray-600 text-xs">
                  <span title={kindHint(s.kind as Kind, s.min_amount != null)}>{kindHint(s.kind as Kind, s.min_amount != null)}</span>
                </td>
                <td className="px-2 py-1 border-b">
                  <button
                    className="text-red-600 text-xs hover:underline"
                    onClick={() =>
                      start(async () => {
                        await removeAddon(contractId, s.id);
                      })
                    }
                  >
                    remove
                  </button>
                </td>
              </tr>
            );
          })}
          <tr>
            <td className="px-2 py-1 border-t">
              <input
                className="w-20 border rounded px-1 py-0.5 font-mono"
                placeholder="FF"
                value={entry.code}
                onChange={(e) => setEntry({ ...entry, code: e.target.value })}
              />
            </td>
            <td className="px-2 py-1 border-t">
              <input
                className="w-full border rounded px-1 py-0.5"
                placeholder="Fuel Surcharge"
                value={entry.name}
                onChange={(e) => setEntry({ ...entry, name: e.target.value })}
              />
            </td>
            <td className="px-2 py-1 border-t">
              <select
                className="border rounded px-1 py-0.5"
                value={entry.kind}
                onChange={(e) => setEntry({ ...entry, kind: e.target.value as Kind })}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </td>
            <td className="px-2 py-1 border-t text-right">
              <input
                type="number"
                step="0.01"
                className="w-20 border rounded px-1 py-0.5 text-right font-mono"
                placeholder="30"
                value={entry.amount}
                onChange={(e) => setEntry({ ...entry, amount: e.target.value })}
              />
            </td>
            <td className="px-2 py-1 border-t text-right text-gray-300">—</td>
            <td className="px-2 py-1 border-t text-gray-400 text-xs">any</td>
            <td className="px-2 py-1 border-t text-gray-500 text-xs">{kindHint(entry.kind, false)}</td>
            <td className="px-2 py-1 border-t">
              <button
                className="text-sm bg-blue-600 text-white px-2 py-0.5 rounded disabled:opacity-50"
                disabled={!entry.code.trim() || !entry.name.trim()}
                onClick={() => {
                  const num = entry.amount.trim() === "" ? null : Number(entry.amount);
                  start(async () => {
                    await addAddon(contractId, {
                      code: entry.code.trim(),
                      name: entry.name.trim(),
                      kind: entry.kind,
                      amount: num != null && Number.isFinite(num) ? num : null,
                    });
                    setEntry({ code: "", name: "", kind: "flat", amount: "" });
                  });
                }}
              >
                add
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      {pending && <div className="text-xs text-blue-600">saving…</div>}
    </div>
  );
}

"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { ContractDTO } from "../lib/types";
import {
  addProduct,
  addSubProduct,
  removeProduct,
  removeSubProduct,
  updateContract,
  updateProduct,
  updateSubProduct,
} from "../actions/contract";
import { RateGrid } from "./RateGrid";
import { ExtrapolationBands } from "./ExtrapolationBands";
import { SurchargesEditor } from "./SurchargesEditor";

export function ContractEditor({ contract }: { contract: ContractDTO }) {
  const [selectedP, setSelectedP] = useState<number | null>(contract.freight[0]?.id ?? null);
  const [selectedSp, setSelectedSp] = useState<number | null>(contract.freight[0]?.sub_products[0]?.id ?? null);
  const [newProd, setNewProd] = useState("");
  const [tab, setTab] = useState<"rates" | "surcharges">("rates");
  const [pending, start] = useTransition();

  const product = contract.freight.find((p) => p.id === selectedP);
  const sub = product?.sub_products.find((sp) => sp.id === selectedSp);

  const field = "w-full rounded border border-gray-300 px-2 py-1 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-blue-500";
  const label = "text-xs font-medium text-gray-600 uppercase tracking-wide";

  const onMetaChange = (patch: Parameters<typeof updateContract>[1]) => {
    start(async () => {
      await updateContract(contract.id, patch);
    });
  };

  return (
    <div className="h-full flex flex-col">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4 bg-white border-b border-gray-200">
        <div>
          <div className={label}>Name</div>
          <input className={field} defaultValue={contract.name} onBlur={(e) => onMetaChange({ name: e.target.value })} />
        </div>
        <div>
          <div className={label}>Carrier</div>
          <input className={field} defaultValue={contract.carrier} onBlur={(e) => onMetaChange({ carrier: e.target.value })} />
        </div>
        <div>
          <div className={label}>Billing Country</div>
          <input
            className={field}
            maxLength={2}
            defaultValue={contract.billing_country}
            onBlur={(e) => onMetaChange({ billing_country: e.target.value.toUpperCase() })}
          />
        </div>
        <div>
          <div className={label}>Currency</div>
          <input
            className={field}
            maxLength={3}
            defaultValue={contract.currency_code}
            onBlur={(e) => onMetaChange({ currency_code: e.target.value.toUpperCase() })}
          />
        </div>
        <div>
          <div className={label}>Volumetric Divisor</div>
          <input
            className={field}
            type="number"
            defaultValue={contract.volumetric_divisor}
            onBlur={(e) => onMetaChange({ volumetric_divisor: Number(e.target.value) })}
          />
        </div>
        <div>
          <div className={label} title="Multiplier on the published fuel rate. 1.00 = standard. Refurbed-style 50% off prevailing fuel = 0.50.">Fuel Multiplier</div>
          <input
            className={field}
            type="number"
            step="0.01"
            min="0"
            max="2"
            defaultValue={contract.fuel_multiplier ?? 1}
            onBlur={(e) => {
              const v = Number(e.target.value);
              onMetaChange({ fuel_multiplier: Number.isFinite(v) ? v : 1 });
            }}
          />
        </div>
        <div>
          <div className={label}>Valid From</div>
          <input
            className={field}
            type="date"
            defaultValue={contract.valid_from}
            onBlur={(e) => onMetaChange({ valid_from: e.target.value })}
          />
        </div>
        <div>
          <div className={label}>Valid Until</div>
          <input
            className={field}
            type="date"
            defaultValue={contract.valid_until}
            onBlur={(e) => onMetaChange({ valid_until: e.target.value })}
          />
        </div>
        {pending && <div className="text-xs text-blue-600 self-center">saving…</div>}
      </div>

      <div className="px-4 pt-3 bg-white border-b border-gray-200 flex gap-1 text-sm">
        <button
          className={`px-3 py-1.5 rounded-t border border-b-0 ${
            tab === "rates" ? "bg-white border-gray-200 text-gray-900 font-medium" : "bg-gray-100 border-transparent text-gray-600 hover:text-gray-900"
          }`}
          onClick={() => setTab("rates")}
        >
          Rates
        </button>
        <button
          className={`px-3 py-1.5 rounded-t border border-b-0 ${
            tab === "surcharges" ? "bg-white border-gray-200 text-gray-900 font-medium" : "bg-gray-100 border-transparent text-gray-600 hover:text-gray-900"
          }`}
          onClick={() => setTab("surcharges")}
        >
          Surcharges <span className="text-xs text-gray-500">({contract.addons.length})</span>
        </button>
      </div>

      {tab === "surcharges" ? (
        <div className="flex-1 overflow-auto bg-gray-50">
          <SurchargesEditor contractId={contract.id} addons={contract.addons} />
        </div>
      ) : (
      <div className="flex-1 flex overflow-hidden">
        <aside className="w-72 border-r border-gray-200 overflow-auto bg-gray-50 p-3 space-y-2">
          <div className="text-xs uppercase tracking-wide text-gray-500 font-medium px-1">Products</div>
          {contract.freight.map((p) => {
            const open = selectedP === p.id;
            return (
              <div key={p.id} className="rounded border border-gray-200 bg-white">
                <div
                  className={`flex items-center justify-between px-2 py-1.5 cursor-pointer ${open ? "bg-blue-50" : ""}`}
                  onClick={() => {
                    setSelectedP(open ? null : p.id);
                    setSelectedSp(open ? null : p.sub_products[0]?.id ?? null);
                  }}
                >
                  <span className="text-sm font-medium">{p.name}</span>
                  <button
                    className="text-xs text-red-600 hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Remove ${p.name}?`)) {
                        start(async () => {
                          await removeProduct(contract.id, p.id);
                        });
                      }
                    }}
                  >
                    ×
                  </button>
                </div>
                {open && (
                  <div className="border-t border-gray-100 px-2 py-1 flex items-center gap-2 text-xs">
                    <span className="text-gray-500 uppercase tracking-wide">Zone group</span>
                    <input
                      className="border rounded px-1.5 py-0.5 font-mono w-28"
                      defaultValue={p.zone_group}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) =>
                        start(async () => {
                          await updateProduct(contract.id, p.id, { zone_group: e.target.value.trim() || "default" });
                        })
                      }
                    />
                    <Link
                      href={`/zones?group=${encodeURIComponent(p.zone_group)}&contract=${contract.id}`}
                      className="text-blue-600 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      edit zones →
                    </Link>
                  </div>
                )}
                {open && (
                  <div className="border-t border-gray-100 px-2 py-1.5 space-y-1">
                    {p.sub_products.map((sp) => (
                      <div
                        key={sp.id}
                        className={`flex items-center justify-between px-2 py-1 rounded text-sm cursor-pointer ${selectedSp === sp.id ? "bg-blue-100" : "hover:bg-gray-50"}`}
                        onClick={() => setSelectedSp(sp.id)}
                      >
                        <span>
                          {sp.name}
                          {sp.codes && <span className="ml-2 text-xs text-gray-500 font-mono">{sp.codes}</span>}
                        </span>
                        <button
                          className="text-xs text-red-600 hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            start(async () => {
                              await removeSubProduct(contract.id, sp.id);
                            });
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <button
                      className="text-xs text-blue-600 hover:underline px-2"
                      onClick={() => {
                        const n = prompt("Sub-product name");
                        if (n)
                          start(async () => {
                            await addSubProduct(contract.id, p.id, n);
                          });
                      }}
                    >
                      + sub-product
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          <form
            className="flex gap-1 pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (newProd.trim()) {
                const name = newProd.trim();
                setNewProd("");
                start(async () => {
                  await addProduct(contract.id, name);
                });
              }
            }}
          >
            <input
              className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
              placeholder="New product"
              value={newProd}
              onChange={(e) => setNewProd(e.target.value)}
            />
            <button className="px-2 py-1 text-sm rounded bg-blue-600 text-white">Add</button>
          </form>
        </aside>

        <main className="flex-1 overflow-auto">
          {!product && <div className="p-6 text-gray-500 text-sm">Select a product to begin.</div>}
          {product && !sub && (
            <div className="p-6 text-gray-500 text-sm">
              <div className="text-gray-800 font-medium mb-1">{product.name}</div>
              Select a sub-product or add one from the sidebar.
            </div>
          )}
          {product && sub && (
            <div className="p-4 space-y-3">
              <div className="flex items-baseline gap-3">
                <div className="text-xs text-gray-500">{product.name}</div>
                <span className="text-gray-300">›</span>
                <input
                  className="text-lg font-medium bg-transparent outline-none focus:bg-yellow-50 px-1"
                  defaultValue={sub.name}
                  onBlur={(e) =>
                    start(async () => {
                      await updateSubProduct(contract.id, sub.id, { name: e.target.value });
                    })
                  }
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <div className={label}>Description</div>
                  <input
                    className={field}
                    defaultValue={sub.description ?? ""}
                    onBlur={(e) =>
                      start(async () => {
                        await updateSubProduct(contract.id, sub.id, { description: e.target.value || null });
                      })
                    }
                  />
                </div>
                <div>
                  <div className={label}>Product code(s)</div>
                  <input
                    className={`${field} font-mono`}
                    placeholder="S  or  S,U"
                    defaultValue={sub.codes ?? ""}
                    onBlur={(e) =>
                      start(async () => {
                        await updateSubProduct(contract.id, sub.id, { codes: e.target.value.trim() || null });
                      })
                    }
                  />
                  <div className="text-xs text-gray-500 mt-1">Comma-separate multiple codes (e.g. EU + non-EU).</div>
                </div>
              </div>
              <RateGrid contractId={contract.id} sub={sub} />
              <ExtrapolationBands contractId={contract.id} sub={sub} />
            </div>
          )}
        </main>
      </div>
      )}
    </div>
  );
}

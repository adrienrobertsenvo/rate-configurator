"use client";

import { useState, useTransition } from "react";
import {
  addCatalogProduct,
  addCatalogSurcharge,
  removeCatalogProduct,
  removeCatalogSurcharge,
  setTaxRate,
  removeTaxRate,
} from "../actions/catalog";

interface Props {
  carrier: string;
  products: { code: string; product_name: string; sub_product_name: string; direction: string }[];
  surcharges: { code: string; name: string; kind: string }[];
  taxRates: { code: string; rate: number; description: string | null }[];
  productOptions: { name: string; subs: string[] }[];
}

export function CatalogEditor({ carrier, products, surcharges, taxRates, productOptions }: Props) {
  const [pEntry, setPEntry] = useState({ code: "", product_name: "", sub_product_name: "", direction: "any" });
  const [sEntry, setSEntry] = useState({ code: "", name: "", kind: "flat" });
  const [tEntry, setTEntry] = useState({ code: "", rate: "0", description: "" });
  const [pending, start] = useTransition();

  const subsFor = (name: string) => productOptions.find((p) => p.name === name)?.subs ?? [];

  return (
    <div className="p-4 space-y-6">
      <section>
        <h3 className="text-sm font-medium mb-2">Product codes ({carrier})</h3>
        <p className="text-xs text-gray-600 mb-2">
          A code can have separate <code>export</code> and <code>import</code> entries that route to different sub-products. The engine resolves
          direction from origin vs billing country; falls back to <code>any</code>.
        </p>
        <table className="text-sm w-full bg-white border border-gray-200 rounded">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-2 py-1 border-b">Code</th>
              <th className="text-left px-2 py-1 border-b">Direction</th>
              <th className="text-left px-2 py-1 border-b">Product</th>
              <th className="text-left px-2 py-1 border-b">Sub-product</th>
              <th className="border-b"></th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={`${p.code}-${p.direction}`} className="even:bg-gray-50">
                <td className="px-2 py-1 border-b font-mono">{p.code}</td>
                <td className="px-2 py-1 border-b text-xs">{p.direction}</td>
                <td className="px-2 py-1 border-b">{p.product_name}</td>
                <td className="px-2 py-1 border-b">{p.sub_product_name}</td>
                <td className="px-2 py-1 border-b">
                  <button
                    className="text-red-600 text-xs hover:underline"
                    onClick={() => start(async () => { await removeCatalogProduct(carrier, p.code, p.direction); })}
                  >
                    remove
                  </button>
                </td>
              </tr>
            ))}
            <tr>
              <td className="px-2 py-1 border-t">
                <input
                  className="w-20 border rounded px-1 py-0.5 font-mono"
                  placeholder="S"
                  value={pEntry.code}
                  onChange={(e) => setPEntry({ ...pEntry, code: e.target.value })}
                />
              </td>
              <td className="px-2 py-1 border-t">
                <select
                  className="border rounded px-1 py-0.5"
                  value={pEntry.direction}
                  onChange={(e) => setPEntry({ ...pEntry, direction: e.target.value })}
                >
                  <option value="any">any</option>
                  <option value="export">export</option>
                  <option value="import">import</option>
                </select>
              </td>
              <td className="px-2 py-1 border-t">
                <select
                  className="border rounded px-1 py-0.5"
                  value={pEntry.product_name}
                  onChange={(e) => setPEntry({ ...pEntry, product_name: e.target.value, sub_product_name: "" })}
                >
                  <option value="">— product —</option>
                  {productOptions.map((p) => (
                    <option key={p.name} value={p.name}>{p.name}</option>
                  ))}
                </select>
              </td>
              <td className="px-2 py-1 border-t">
                <select
                  className="border rounded px-1 py-0.5"
                  value={pEntry.sub_product_name}
                  onChange={(e) => setPEntry({ ...pEntry, sub_product_name: e.target.value })}
                >
                  <option value="">— sub —</option>
                  {subsFor(pEntry.product_name).map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </td>
              <td className="px-2 py-1 border-t">
                <button
                  className="text-sm bg-blue-600 text-white px-2 py-0.5 rounded disabled:opacity-50"
                  disabled={!pEntry.code || !pEntry.product_name || !pEntry.sub_product_name}
                  onClick={() => start(async () => {
                    await addCatalogProduct({ carrier, ...pEntry });
                    setPEntry({ code: "", product_name: "", sub_product_name: "", direction: "any" });
                  })}
                >
                  add
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h3 className="text-sm font-medium mb-2">Tax / VAT rates ({carrier})</h3>
        <p className="text-xs text-gray-600 mb-2">
          Maps the invoice&apos;s <code>Tax Code</code> column to a VAT rate (0..1). Used to reconcile <code>Total Tax</code> against the expected amount.
        </p>
        <table className="text-sm w-full bg-white border border-gray-200 rounded">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-2 py-1 border-b">Code</th>
              <th className="text-right px-2 py-1 border-b">Rate</th>
              <th className="text-left px-2 py-1 border-b">Description</th>
              <th className="border-b"></th>
            </tr>
          </thead>
          <tbody>
            {taxRates.map((t) => (
              <tr key={t.code} className="even:bg-gray-50">
                <td className="px-2 py-1 border-b font-mono">{t.code}</td>
                <td className="px-2 py-1 border-b text-right font-mono">{(t.rate * 100).toFixed(2)}%</td>
                <td className="px-2 py-1 border-b text-gray-600">{t.description ?? ""}</td>
                <td className="px-2 py-1 border-b">
                  <button
                    className="text-red-600 text-xs hover:underline"
                    onClick={() => start(async () => { await removeTaxRate(carrier, t.code); })}
                  >
                    remove
                  </button>
                </td>
              </tr>
            ))}
            <tr>
              <td className="px-2 py-1 border-t">
                <input
                  className="w-20 border rounded px-1 py-0.5 font-mono"
                  placeholder="A"
                  value={tEntry.code}
                  onChange={(e) => setTEntry({ ...tEntry, code: e.target.value })}
                />
              </td>
              <td className="px-2 py-1 border-t text-right">
                <input
                  type="number"
                  step="0.0001"
                  min={0}
                  max={1}
                  className="w-20 border rounded px-1 py-0.5 text-right"
                  placeholder="0.19"
                  value={tEntry.rate}
                  onChange={(e) => setTEntry({ ...tEntry, rate: e.target.value })}
                />
              </td>
              <td className="px-2 py-1 border-t">
                <input
                  className="border rounded px-1 py-0.5 w-full"
                  placeholder="Standard VAT (Germany 19%)"
                  value={tEntry.description}
                  onChange={(e) => setTEntry({ ...tEntry, description: e.target.value })}
                />
              </td>
              <td className="px-2 py-1 border-t">
                <button
                  className="text-sm bg-blue-600 text-white px-2 py-0.5 rounded disabled:opacity-50"
                  disabled={!tEntry.code || !Number.isFinite(Number(tEntry.rate))}
                  onClick={() => start(async () => {
                    await setTaxRate({
                      carrier,
                      code: tEntry.code,
                      rate: Number(tEntry.rate),
                      description: tEntry.description || null,
                    });
                    setTEntry({ code: "", rate: "0", description: "" });
                  })}
                >
                  add
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h3 className="text-sm font-medium mb-2">Surcharge codes ({carrier})</h3>
        <table className="text-sm w-full bg-white border border-gray-200 rounded">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-2 py-1 border-b">Code</th>
              <th className="text-left px-2 py-1 border-b">Name</th>
              <th className="text-left px-2 py-1 border-b">Kind</th>
              <th className="border-b"></th>
            </tr>
          </thead>
          <tbody>
            {surcharges.map((s) => (
              <tr key={s.code} className="even:bg-gray-50">
                <td className="px-2 py-1 border-b font-mono">{s.code}</td>
                <td className="px-2 py-1 border-b">{s.name}</td>
                <td className="px-2 py-1 border-b">{s.kind}</td>
                <td className="px-2 py-1 border-b">
                  <button
                    className="text-red-600 text-xs hover:underline"
                    onClick={() => start(async () => { await removeCatalogSurcharge(carrier, s.code); })}
                  >
                    remove
                  </button>
                </td>
              </tr>
            ))}
            <tr>
              <td className="px-2 py-1 border-t">
                <input
                  className="w-20 border rounded px-1 py-0.5 font-mono"
                  placeholder="FF"
                  value={sEntry.code}
                  onChange={(e) => setSEntry({ ...sEntry, code: e.target.value })}
                />
              </td>
              <td className="px-2 py-1 border-t">
                <input
                  className="border rounded px-1 py-0.5 w-full"
                  placeholder="Fuel Surcharge"
                  value={sEntry.name}
                  onChange={(e) => setSEntry({ ...sEntry, name: e.target.value })}
                />
              </td>
              <td className="px-2 py-1 border-t">
                <select
                  className="border rounded px-1 py-0.5"
                  value={sEntry.kind}
                  onChange={(e) => setSEntry({ ...sEntry, kind: e.target.value })}
                >
                  <option value="flat">flat</option>
                  <option value="per_kg">per_kg</option>
                  <option value="per_shipment">per_shipment</option>
                  <option value="percent">percent</option>
                </select>
              </td>
              <td className="px-2 py-1 border-t">
                <button
                  className="text-sm bg-blue-600 text-white px-2 py-0.5 rounded disabled:opacity-50"
                  disabled={!sEntry.code || !sEntry.name}
                  onClick={() => start(async () => {
                    await addCatalogSurcharge({ carrier, ...sEntry });
                    setSEntry({ code: "", name: "", kind: "flat" });
                  })}
                >
                  add
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        {pending && <div className="text-xs text-blue-600 mt-2">saving…</div>}
      </section>
    </div>
  );
}

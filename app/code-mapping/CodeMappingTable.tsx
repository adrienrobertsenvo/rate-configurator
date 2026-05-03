"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { setSurchargeCode, createSurchargeFromCode } from "../actions/code-mapping";

interface Row {
  contractId: number;
  contractName: string;
  carrier: string;
  code: string;
  invoiceName: string;
  count: number;
  total: number;
}

interface Rule {
  id: number;
  code: string;
  name: string;
  kind: string;
  amount: number | null;
  min_amount: number | null;
  applies_to: string;
}

interface CatalogEntry {
  code: string;
  name: string;
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Score a contract rule against the invoice surcharge: higher = better candidate.
// Exact code match is best (already resolved — we don't really need to map then).
// Catalog name match is the canonical signal. Direct name match is the fallback.
function scoreRule(rule: Rule, invoiceCode: string, invoiceName: string, catalogName: string | null): number {
  let score = 0;
  if (rule.code === invoiceCode) return 100; // already mapped
  if (catalogName && normalizeName(rule.name) === normalizeName(catalogName)) score += 50;
  if (catalogName && normalizeName(rule.name).includes(normalizeName(catalogName))) score += 20;
  if (normalizeName(rule.name) === normalizeName(invoiceName)) score += 30;
  if (normalizeName(rule.name).includes(normalizeName(invoiceName))) score += 10;
  return score;
}

export function CodeMappingTable({
  rows,
  rulesByContract,
  catalog,
}: {
  rows: Row[];
  rulesByContract: Record<number, Rule[]>;
  catalog: Record<string, Record<string, CatalogEntry>>;
}) {
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <RowCard key={`${r.contractId}|${r.code}`} row={r} rules={rulesByContract[r.contractId] ?? []} catalog={catalog[r.carrier] ?? {}} />
      ))}
    </div>
  );
}

function RowCard({ row, rules, catalog }: { row: Row; rules: Rule[]; catalog: Record<string, CatalogEntry> }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const catalogEntry = catalog[row.code];
  const catalogName = catalogEntry?.name ?? null;

  const ranked = [...rules]
    .map((r) => ({ rule: r, score: scoreRule(r, row.code, row.invoiceName, catalogName) }))
    .sort((a, b) => b.score - a.score);
  const suggestions = ranked.slice(0, 4).filter((x) => x.score > 0);
  const others = ranked.filter((x) => !suggestions.includes(x));

  function applyToRule(ruleId: number) {
    setError(null);
    start(async () => {
      try {
        await setSurchargeCode(row.contractId, ruleId, row.code);
      } catch (e) {
        setError(String((e as Error).message ?? e));
      }
    });
  }

  return (
    <div className="bg-white border rounded p-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <span className="font-mono font-semibold text-gray-900">{row.code}</span>
          {catalogName && <span className="ml-2 text-sm text-gray-700">{catalogName}</span>}
          <span className="ml-2 text-xs text-gray-500">invoice label: &quot;{row.invoiceName}&quot;</span>
        </div>
        <div className="text-xs text-gray-600">
          <span>{row.count} unresolved {row.count === 1 ? "line" : "lines"}</span>
          <span className="mx-2">·</span>
          <span>€{row.total.toFixed(2)} billed</span>
        </div>
      </div>
      <div className="text-xs text-gray-500 mt-1">
        in <Link href={`/contracts/${row.contractId}`} className="text-blue-700 hover:underline">{row.contractName}</Link>
      </div>

      {suggestions.length > 0 && (
        <div className="mt-2">
          <div className="text-xs font-medium text-gray-700 mb-1">Suggested rules to retag with code <span className="font-mono">{row.code}</span></div>
          <ul className="space-y-1">
            {suggestions.map((s) => (
              <li key={s.rule.id} className="flex items-center gap-2 text-sm">
                <span className="font-mono text-xs text-gray-600 w-20 truncate" title={s.rule.code}>{s.rule.code}</span>
                <span className="flex-1 truncate">{s.rule.name}</span>
                <span className="text-xs text-gray-500 whitespace-nowrap">
                  {s.rule.kind}{s.rule.amount != null ? ` · €${s.rule.amount}` : ""}
                  {s.rule.min_amount != null ? ` · min €${s.rule.min_amount}` : ""}
                  {s.rule.applies_to !== "any" ? ` · ${s.rule.applies_to}` : ""}
                </span>
                <button
                  className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded disabled:opacity-50 whitespace-nowrap"
                  onClick={() => applyToRule(s.rule.id)}
                  disabled={pending}
                >
                  Apply →{row.code}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="mt-2">
        <summary className="text-xs text-gray-600 cursor-pointer hover:text-gray-900">
          Other rules in this contract ({others.length}) · or create a new rule for this code
        </summary>
        <div className="mt-2 space-y-1">
          {others.map((s) => (
            <div key={s.rule.id} className="flex items-center gap-2 text-sm">
              <span className="font-mono text-xs text-gray-600 w-20 truncate" title={s.rule.code}>{s.rule.code}</span>
              <span className="flex-1 truncate">{s.rule.name}</span>
              <button
                className="text-xs text-blue-700 hover:underline"
                onClick={() => applyToRule(s.rule.id)}
                disabled={pending}
              >
                Apply →{row.code}
              </button>
            </div>
          ))}
          <button
            className="text-xs text-blue-700 hover:underline mt-2"
            onClick={() => setCreating((c) => !c)}
          >
            {creating ? "Cancel new rule" : `+ Create new rule with code ${row.code}`}
          </button>
          {creating && <NewRuleForm row={row} onDone={() => setCreating(false)} />}
        </div>
      </details>

      {error && <div className="text-xs text-rose-700 mt-2">{error}</div>}
      {pending && <div className="text-xs text-blue-600 mt-1">Saving…</div>}
    </div>
  );
}

function NewRuleForm({ row, onDone }: { row: Row; onDone: () => void }) {
  const [name, setName] = useState(row.invoiceName);
  const [kind, setKind] = useState<"flat" | "per_kg" | "per_shipment" | "percent">("flat");
  const [amount, setAmount] = useState("");
  const [min_amount, setMin] = useState("");
  const [scope, setScope] = useState<"any" | "domestic" | "international">("any");
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    setErr(null);
    const a = amount.trim() === "" ? null : Number(amount.replace(",", "."));
    const m = min_amount.trim() === "" ? null : Number(min_amount.replace(",", "."));
    if (a != null && !Number.isFinite(a)) { setErr("Amount must be a number"); return; }
    if (m != null && !Number.isFinite(m)) { setErr("Min must be a number"); return; }
    start(async () => {
      try {
        await createSurchargeFromCode(row.contractId, {
          code: row.code, name: name.trim() || row.invoiceName,
          kind, amount: a, min_amount: m, applies_to: scope,
        });
        onDone();
      } catch (e) {
        setErr(String((e as Error).message ?? e));
      }
    });
  }

  return (
    <div className="bg-gray-50 border rounded p-2 mt-2 space-y-1 text-xs">
      <div className="flex items-center gap-2">
        <label className="w-14 text-gray-500">Name</label>
        <input className="flex-1 border rounded px-1 py-0.5" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="flex items-center gap-2">
        <label className="w-14 text-gray-500">Kind</label>
        <select className="border rounded px-1 py-0.5" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="flat">flat</option>
          <option value="per_shipment">per_shipment</option>
          <option value="per_kg">per_kg</option>
          <option value="percent">percent</option>
        </select>
        <label className="ml-2 text-gray-500">Scope</label>
        <select className="border rounded px-1 py-0.5" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="any">any</option>
          <option value="domestic">domestic</option>
          <option value="international">international</option>
        </select>
      </div>
      <div className="flex items-center gap-2">
        <label className="w-14 text-gray-500">Amount</label>
        <input className="border rounded px-1 py-0.5 w-24 font-mono text-right" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        <label className="ml-2 text-gray-500">Min €</label>
        <input className="border rounded px-1 py-0.5 w-24 font-mono text-right" value={min_amount} onChange={(e) => setMin(e.target.value)} placeholder="—" disabled={kind !== "per_kg"} />
      </div>
      <div className="flex items-center gap-2">
        <button className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white text-xs rounded px-3 py-1" onClick={submit} disabled={pending}>
          {pending ? "Creating…" : "Create rule"}
        </button>
        <button className="text-xs text-gray-600 hover:text-gray-900" onClick={onDone} disabled={pending}>Cancel</button>
        {err && <span className="text-rose-700 ml-2">{err}</span>}
      </div>
    </div>
  );
}

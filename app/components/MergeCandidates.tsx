"use client";

import { useState, useTransition } from "react";
import { mergeContracts } from "../actions/merge-contracts";

interface ContractRef {
  id: number;
  name: string;
  carrier: string;
  billing_country: string;
  valid_from: string;
  valid_until: string;
  products: number;
}

// Strip the carrier prefix and trailing rate-card markers to get a customer key.
// Two contracts with the same customer key + same carrier + overlapping validity
// are flagged as merge candidates. Carrier base-rate contracts (named "Standard"
// or empty after stripping) are deliberately excluded — they're a distinct kind
// of contract (the published carrier rate card) and never merge with customer
// contracts.
function customerKey(name: string): string {
  return name
    .replace(/^DHL Express Germany\s*[—–-]\s*/i, "")
    .replace(/\s*(Worldwide & Economy\s+)?(Ratecard|Rates)\b.*$/i, "")
    .replace(/\s+\d{4}\s*$/i, "")
    .trim()
    .toLowerCase();
}

function isBaseRate(name: string): boolean {
  const k = customerKey(name);
  return k === "" || k === "standard" || /\bbase\s*rate(s)?\b/i.test(name);
}

function overlap(a: ContractRef, b: ContractRef): boolean {
  return a.valid_from <= b.valid_until && b.valid_from <= a.valid_until;
}

export function MergeCandidates({ contracts }: { contracts: ContractRef[] }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  const groups = new Map<string, ContractRef[]>();
  for (const c of contracts) {
    if (isBaseRate(c.name)) continue; // carrier base-rate contracts never enter merge groups
    // Country-specific contracts for the same customer (e.g. Refurbed DE/GB/FR)
    // must NEVER merge — different zone maps and rates per country.
    const key = `${c.carrier}|${c.billing_country}|${customerKey(c.name)}`;
    if (!key.endsWith("|") && customerKey(c.name)) {
      const list = groups.get(key) ?? [];
      list.push(c);
      groups.set(key, list);
    }
  }
  const candidates = Array.from(groups.values()).filter((g) => g.length >= 2 && g.some((a, i) => g.slice(i + 1).some((b) => overlap(a, b))));
  if (candidates.length === 0) return null;

  return (
    <div className="bg-white border rounded p-3 mb-3">
      <div className="text-sm font-medium text-gray-700 mb-2">
        Possible duplicates · these contracts share a customer and overlapping validity — merge them into one if they&apos;re really the same contract split across multiple PDFs.
      </div>
      <div className="space-y-2 text-sm">
        {candidates.map((group, i) => (
          <Group key={i} group={group} pending={pending} start={start} setResult={setResult} />
        ))}
      </div>
      {result && <div className="text-xs text-emerald-700 mt-2">{result}</div>}
    </div>
  );
}

function Group({
  group, pending, start, setResult,
}: {
  group: ContractRef[];
  pending: boolean;
  start: ReturnType<typeof useTransition>[1];
  setResult: (s: string) => void;
}) {
  const [primaryId, setPrimaryId] = useState<number>(
    [...group].sort((a, b) => b.products - a.products)[0].id, // default to the one with the most products
  );
  const [secondaryId, setSecondaryId] = useState<number>(
    [...group].sort((a, b) => a.products - b.products)[0].id,
  );

  function doMerge() {
    if (primaryId === secondaryId) {
      setResult("Pick two different contracts.");
      return;
    }
    const primary = group.find((c) => c.id === primaryId);
    const secondary = group.find((c) => c.id === secondaryId);
    if (!primary || !secondary) return;
    if (!confirm(`Merge "${secondary.name}" into "${primary.name}"? The secondary will be deleted.`)) return;
    start(async () => {
      try {
        const r = await mergeContracts(primaryId, secondaryId);
        setResult(
          `Merged: +${r.added_products} products, +${r.added_subs} sub-products (${r.skipped_subs} skipped as duplicates), +${r.added_surcharges} surcharges, ${r.moved_sources} source docs and ${r.moved_invoices} invoices reattached.`,
        );
      } catch (e) {
        setResult(String((e as Error).message ?? e));
      }
    });
  }

  return (
    <div className="border border-amber-200 bg-amber-50 rounded p-2">
      <ul className="text-xs space-y-0.5 mb-2">
        {group.map((c) => (
          <li key={c.id}>
            <span className="font-mono text-gray-500 mr-2">#{c.id}</span>
            {c.name} <span className="text-gray-500">· {c.valid_from}→{c.valid_until} · {c.products} products</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2 text-xs">
        <span>Keep:</span>
        <select className="border rounded px-1 py-0.5" value={primaryId} onChange={(e) => setPrimaryId(Number(e.target.value))}>
          {group.map((c) => <option key={c.id} value={c.id}>#{c.id} {c.name}</option>)}
        </select>
        <span>Merge in:</span>
        <select className="border rounded px-1 py-0.5" value={secondaryId} onChange={(e) => setSecondaryId(Number(e.target.value))}>
          {group.map((c) => <option key={c.id} value={c.id}>#{c.id} {c.name}</option>)}
        </select>
        <button
          onClick={doMerge}
          disabled={pending || primaryId === secondaryId}
          className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white text-xs rounded px-3 py-1"
        >
          {pending ? "Merging…" : "Merge"}
        </button>
      </div>
    </div>
  );
}

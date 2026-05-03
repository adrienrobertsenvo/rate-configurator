"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { uploadInvoice } from "../actions/invoice";

export interface ContractOption {
  id: number;
  name: string;
  customer_name: string | null;
  is_global: boolean;
  aliases: string[];           // brand_aliases — billing-account NAMES
  accountNumbers: string[];    // contract.account_numbers — DHL account NUMBERS
}

// Pull just enough of the file to read the header row + first data row.
// DHL CSVs put metadata on row 2 — both "Billing Account" (the numeric account)
// and "Billing Account Name" (the entity name) live there.
async function detectMeta(file: File): Promise<{ account_name: string | null; account_number: string | null; invoice_type: string | null }> {
  const slice = await file.slice(0, 16 * 1024).text();
  const parsed = Papa.parse<Record<string, string>>(slice, { header: true, skipEmptyLines: true });
  const row = parsed.data[0];
  if (!row) return { account_name: null, account_number: null, invoice_type: null };
  const account_name = (row["Billing Account Name"] ?? "").trim() || null;
  const account_number = (row["Billing Account"] ?? "").trim() || null;
  const invoice_type = (row["Invoice Type"] ?? "").trim() || null;
  return { account_name, account_number, invoice_type };
}

// Account-number match is the precise routing key (one DHL account → one
// contract). Brand-alias name match is the fallback for new accounts that
// haven't been added to the contract's account_numbers yet.
function pickSuggestion(
  meta: { account_name: string | null; account_number: string | null },
  contracts: ContractOption[],
): { contract: ContractOption; matchedBy: "account_number" | "alias" } | null {
  if (meta.account_number) {
    const num = meta.account_number.trim();
    const byNumber = contracts.find((c) => c.accountNumbers.includes(num));
    if (byNumber) return { contract: byNumber, matchedBy: "account_number" };
  }
  if (meta.account_name) {
    const norm = meta.account_name.toUpperCase().trim();
    const byAlias = contracts.find((c) => c.aliases.some((a) => a.toUpperCase().trim() === norm));
    if (byAlias) return { contract: byAlias, matchedBy: "alias" };
  }
  return null;
}

export function UploadInvoice({ contracts }: { contracts: ContractOption[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [detected, setDetected] = useState<{
    account_name: string | null;
    account_number: string | null;
    invoice_type: string | null;
    suggestion: ContractOption | null;
    matchedBy: "account_number" | "alias" | null;
  } | null>(null);
  const [contractId, setContractId] = useState<number>(contracts[0]?.id ?? 0);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setError(null);
    setFile(f);
    const meta = await detectMeta(f);
    const match = pickSuggestion(meta, contracts);
    setDetected({ ...meta, suggestion: match?.contract ?? null, matchedBy: match?.matchedBy ?? null });
    if (match) setContractId(match.contract.id);
  }

  function reset() {
    setFile(null);
    setDetected(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function confirmUpload() {
    if (!file) return;
    setError(null);
    const fd = new FormData();
    fd.append("csv", file);
    fd.append("contractId", String(contractId));
    start(async () => {
      try {
        const { invoiceId } = await uploadInvoice(fd);
        router.push(`/invoices/${invoiceId}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  // Compact "no file selected yet" state — just the file-picker button.
  if (!file) {
    return (
      <div className="flex items-center gap-3">
        <input ref={inputRef} type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" disabled={pending} />
        <button
          onClick={() => inputRef.current?.click()}
          disabled={pending || contracts.length === 0}
          className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          Upload invoice CSV
        </button>
        {contracts.length === 0 && (
          <span className="text-xs text-gray-500">Upload a contract first</span>
        )}
      </div>
    );
  }

  // File picked — show detection summary + contract selector + confirm button.
  const suggestion = detected?.suggestion;
  const detectedName = detected?.account_name;
  const detectedNumber = detected?.account_number;
  const detectedType = detected?.invoice_type;
  const matchedBy = detected?.matchedBy;
  return (
    <div className="border rounded bg-white p-3 max-w-2xl">
      <div className="text-sm font-medium mb-2">Confirm upload</div>
      <div className="text-xs text-gray-600 mb-2 font-mono">{file.name} <span className="text-gray-400">({(file.size / 1024).toFixed(1)} KB)</span></div>
      <div className="text-xs space-y-1 mb-3">
        <div>
          <span className="text-gray-500 mr-2">Billing account #:</span>
          {detectedNumber ? <span className="font-mono">{detectedNumber}</span> : <span className="text-gray-400">not detected</span>}
        </div>
        <div>
          <span className="text-gray-500 mr-2">Billing account name:</span>
          {detectedName ? <span className="font-mono">{detectedName}</span> : <span className="text-gray-400">not detected</span>}
        </div>
        <div>
          <span className="text-gray-500 mr-2">Invoice type:</span>
          <span className="font-mono">{detectedType || "freight"}</span>
        </div>
        {suggestion ? (
          <div className="text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">
            Auto-routed to <b>{suggestion.customer_name ?? suggestion.name}</b> · {suggestion.name}
            <span className="ml-2 text-emerald-600">(matched by {matchedBy === "account_number" ? "account number" : "name alias"})</span>
          </div>
        ) : (detectedNumber || detectedName) ? (
          <div className="text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
            No contract matches account {detectedNumber ? <b>#{detectedNumber}</b> : null}{detectedNumber && detectedName ? " / " : null}{detectedName ? <b>{detectedName}</b> : null}. Pick a contract manually below — once uploaded, the importer will remember this account number for next time.
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs text-gray-500 w-16">Contract</span>
        <select
          className="text-sm border rounded px-2 py-1 bg-white flex-1"
          value={contractId}
          onChange={(e) => setContractId(Number(e.target.value))}
          disabled={pending}
        >
          {contracts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.customer_name ? `${c.customer_name} · ` : ""}{c.name}{c.is_global ? " · [global]" : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={confirmUpload}
          disabled={pending || contractId === 0}
          className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {pending ? "Uploading…" : "Upload"}
        </button>
        <button
          onClick={reset}
          disabled={pending}
          className="text-sm px-2 py-1.5 text-gray-600 hover:text-gray-900"
        >
          Cancel
        </button>
        {error && <span className="text-xs text-red-600 ml-2">{error}</span>}
      </div>
    </div>
  );
}

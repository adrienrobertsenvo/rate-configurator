"use client";

import Link from "next/link";
import { useTransition } from "react";
import { rerunAudit } from "../actions/invoice";
import { isoWeekFromDate, lookupFuelRate, fuelClassForProduct } from "../lib/fuel-rates";
import { isFuelable, SURCHARGE_BY_CODE } from "../lib/surcharge-meta";
import { TAX_CODE_INFO } from "../lib/tax-codes";
import { ReviewPanel } from "./ReviewPanel";
import type { ReviewStatus } from "../actions/review";

interface Line {
  id: number;
  shipment_number: string | null;
  shipment_date: string | null;
  product_code: string | null;
  product_name: string | null;
  origin_country: string | null;
  dest_country: string | null;
  weight_kg: number | null;
  charged_amount: number | null;
  weight_charge: number | null;
  expected_amount: number | null;
  expected_weight_charge: number | null;
  delta: number | null;
  tax_code: string | null;
  total_tax: number | null;
  expected_tax: number | null;
  tax_delta: number | null;
  tax_status: string | null;
  surcharge_delta: number | null;
  surcharge_status: string | null;
  audit_status: string | null;
  audit_notes: string | null;
  matched_product: string | null;
  matched_sub_product: string | null;
  matched_zone: string | null;
  matched_band_json: string | null;
  surcharges_json: string | null;
  expected_surcharges_json: string | null;
  review_status: string | null;
  review_notes: string | null;
  reviewer: string | null;
  reviewed_at: Date | null;
}

interface ExpectedSurcharge {
  code: string;
  name: string;
  expected: number;
  actual: number;
  delta: number;
  status: string;
}

interface MatchedBand {
  weight_start: number;
  weight_end: number | null;
  price: number | null;
  per_kg: number | null;
  step: number | null;
  chargeable_kg?: number;
}

const TOLERANCE_EUR = 0.05;

function statusOf(delta: number | null): "ok" | "over" | "under" {
  if (delta == null || Math.abs(delta) <= TOLERANCE_EUR) return "ok";
  return delta > 0 ? "over" : "under";
}

function statusPill(s: string | null) {
  switch (s) {
    case "ok":          return "bg-green-100 text-green-800";
    case "over":        return "bg-red-100 text-red-800";
    case "under":       return "bg-amber-100 text-amber-800";
    case "cascade":     return "bg-purple-100 text-purple-800";
    case "passthrough": return "bg-sky-100 text-sky-800";
    default:            return "bg-gray-200 text-gray-700";
  }
}

function deltaCls(delta: number | null, status?: string | null): string {
  if (delta == null) return "";
  if (status === "cascade") return "text-purple-700";
  if (Math.abs(delta) <= TOLERANCE_EUR) return "text-gray-500";
  return delta > 0 ? "text-rose-700" : "text-amber-700";
}

// Local wrappers around the shared formatters — kept as named exports because
// the table cells reference them in dozens of places. Thousand separators are
// applied via the shared `fmtMoney` helper.
function fmtEur(v: number | null | undefined): string {
  if (v == null) return "—";
  return moneyNoSign.format(v);
}

function fmtDelta(v: number | null | undefined): string {
  if (v == null) return "—";
  if (Math.abs(v) < 0.005) return "0.00";
  return (v > 0 ? "+" : "") + moneyNoSign.format(Math.abs(v));
}

const moneyNoSign = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function formatBand(band: MatchedBand): string {
  if (band.price != null && band.weight_end != null) {
    return `${(band.weight_start / 1000).toFixed(2)}–${(band.weight_end / 1000).toFixed(2)} kg`;
  }
  const base = `${(band.weight_start / 1000).toFixed(2)} kg+ · €${band.per_kg?.toFixed(2) ?? "?"}/kg`;
  const step = band.step ? ` step ${band.step}kg` : "";
  const ch = band.chargeable_kg != null ? ` · chargeable ${band.chargeable_kg.toFixed(2)} kg` : "";
  return base + step + ch;
}

export function AuditView({ invoiceId, contractId, lines }: { invoiceId: number; contractId: number | null; lines: Line[] }) {
  const [pending, start] = useTransition();
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <button
          className="text-xs rounded bg-gray-200 hover:bg-gray-300 px-2 py-1 disabled:opacity-60"
          onClick={() => start(async () => { await rerunAudit(invoiceId); })}
          disabled={pending}
        >
          {pending ? "Re-running…" : "Re-run audit"}
        </button>
      </div>
      {/* No overflow-auto wrapper — the column-header `thead` is `sticky top-0`
          and we want it to stick relative to the nearest scrolling ancestor,
          which is `<main className="overflow-auto">` in app/layout.tsx, NOT
          this inner div. With overflow-auto here the sticky context becomes
          this div itself (which never scrolls) and the headers vanish off the
          top of the viewport instead. The `border` + `rounded` styling stays
          on the outer wrapper. */}
      <div className="border rounded bg-white">
        <table className="text-xs w-full">
          <thead className="bg-gray-50 sticky top-0 z-20 shadow-[0_1px_0_rgba(0,0,0,0.06)]">
            <tr>
              <th className="px-2 py-1.5 text-left border-b w-32">Charge</th>
              <th className="px-2 py-1.5 text-left border-b">Detail</th>
              <th className="px-2 py-1.5 text-right border-b">Invoiced</th>
              <th className="px-2 py-1.5 text-right border-b">Expected</th>
              <th className="px-2 py-1.5 text-right border-b">Δ</th>
              <th className="px-2 py-1.5 text-left border-b w-20">Status</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => <ShipmentBlock key={l.id} line={l} contractId={contractId} />)}
            {lines.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-gray-500">No lines match this filter.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Exported so the cross-invoice "By shipment" view on /invoices can render
// the same multi-row layout. The optional `invoice` prop adds an "in invoice
// X →" link in the shipment header for cross-invoice contexts; omitted on
// the per-invoice page where the parent invoice is already implied by the URL.
export function ShipmentBlock({ line: l, contractId, invoice }: { line: Line; contractId: number | null; invoice?: { id: number; number: string } }) {
  const band: MatchedBand | null = l.matched_band_json ? JSON.parse(l.matched_band_json) as MatchedBand : null;
  const expectedSurcharges: ExpectedSurcharge[] = l.expected_surcharges_json ? JSON.parse(l.expected_surcharges_json) as ExpectedSurcharge[] : [];
  const actualSurcharges: { code: string; name: string; charge: number }[] = l.surcharges_json ? JSON.parse(l.surcharges_json) : [];
  const expByCode = new Map(expectedSurcharges.map((s) => [s.code, s]));
  const actByCode = new Map(actualSurcharges.map((s) => [s.code, s]));
  const codes = Array.from(new Set([...expByCode.keys(), ...actByCode.keys()])).filter((c) => c !== "FF").sort();
  const ffExp = expByCode.get("FF");
  const ffAct = actByCode.get("FF");

  // Fuel rate context for the FF row's "detail" column.
  const klass = l.product_code ? fuelClassForProduct(l.product_code) : null;
  const isoWeek = l.shipment_date ? isoWeekFromDate(l.shipment_date) : null;
  const publishedRate = klass && l.shipment_date ? lookupFuelRate(klass, l.shipment_date)?.rate ?? null : null;
  const fuelableActualSum = actualSurcharges.filter((s) => isFuelable(s.code)).reduce((a, s) => a + s.charge, 0);
  const fuelBaseAct = (l.weight_charge ?? 0) + fuelableActualSum;
  const actImpliedRate = ffAct && fuelBaseAct > 0 ? ffAct.charge / fuelBaseAct : null;

  // Weight-charge audit
  const wcDelta = l.weight_charge != null && l.expected_weight_charge != null
    ? l.weight_charge - l.expected_weight_charge : null;
  const wcStatus = statusOf(wcDelta);

  return (
    <>
      {/* Shipment header — full-width, slightly emphasized */}
      <tr className="bg-blue-50 border-t-2 border-blue-200">
        <td colSpan={6} className="px-3 py-2">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="font-mono font-medium">{l.shipment_number ?? "—"}</span>
            <span className="text-gray-700">{l.product_code ?? "—"} · {l.product_name ?? "—"}</span>
            <span className="font-mono text-gray-700">{l.origin_country ?? "?"}→{l.dest_country ?? "?"}</span>
            <span className="text-gray-700">{l.matched_zone ?? ""}</span>
            <span className="text-gray-700">{l.weight_kg != null ? `${l.weight_kg.toFixed(2)} kg` : ""}</span>
            <span className="text-gray-500">{l.shipment_date ?? ""}{isoWeek ? ` (${isoWeek})` : ""}</span>
            <span className={`px-1.5 py-0.5 rounded ${statusPill(l.audit_status)}`}>{l.audit_status ?? "unresolved"}</span>
            <div className="ml-auto flex items-center gap-3">
              {invoice && (
                <Link href={`/invoices/${invoice.id}#line-${l.id}`} className="text-xs text-blue-700 hover:underline font-mono">
                  invoice {invoice.number} →
                </Link>
              )}
              {contractId && (
                <Link href={`/contracts/${contractId}`} className="text-xs text-blue-700 hover:underline">contract →</Link>
              )}
            </div>
          </div>
        </td>
      </tr>

      {/* Weight charge row */}
      <tr className="border-t border-gray-100">
        <td className="px-2 py-1 font-mono">WC</td>
        <td className="px-2 py-1 text-gray-600">Weight charge {band ? `· ${formatBand(band)}` : ""}</td>
        <td className="px-2 py-1 text-right font-mono">{fmtEur(l.weight_charge)}</td>
        <td className="px-2 py-1 text-right font-mono text-gray-600">{fmtEur(l.expected_weight_charge)}</td>
        <td className={`px-2 py-1 text-right font-mono ${deltaCls(wcDelta)}`}>{fmtDelta(wcDelta)}</td>
        <td className="px-2 py-1"><span className={`px-1.5 py-0.5 rounded ${statusPill(wcStatus)}`}>{wcStatus}</span></td>
      </tr>

      {/* Per-surcharge rows (excluding FF, which gets its own row below) */}
      {codes.map((code) => {
        const exp = expByCode.get(code);
        const act = actByCode.get(code);
        const meta = SURCHARGE_BY_CODE.get(code);
        const fuelable = meta?.fuelable ?? false;
        const status = exp?.status ?? "unresolved";
        const delta = exp?.delta ?? ((act?.charge ?? 0) - (exp?.expected ?? 0));
        return (
          <tr key={code} className="border-t border-gray-100">
            <td className="px-2 py-1 font-mono">{code}{fuelable ? <span className="ml-1 text-amber-700 text-xs">⛽</span> : null}</td>
            <td className="px-2 py-1 text-gray-600">{meta?.name ?? exp?.name ?? act?.name ?? code}</td>
            <td className="px-2 py-1 text-right font-mono">{fmtEur(act?.charge ?? null)}</td>
            <td className="px-2 py-1 text-right font-mono text-gray-600">{fmtEur(exp?.expected ?? null)}</td>
            <td className={`px-2 py-1 text-right font-mono ${deltaCls(delta)}`}>{fmtDelta(delta)}</td>
            <td className="px-2 py-1"><span className={`px-1.5 py-0.5 rounded ${statusPill(status)}`}>{status}</span></td>
          </tr>
        );
      })}

      {/* FF Fuel row — annotated with rates */}
      {(ffExp || ffAct) && (
        <tr className="border-t border-gray-100">
          <td className="px-2 py-1 font-mono">FF</td>
          <td className="px-2 py-1 text-gray-600">
            Fuel surcharge ({klass ?? "?"})
            {publishedRate != null && actImpliedRate != null && (
              <span className="ml-2 text-gray-500">
                published {(publishedRate * 100).toFixed(2)}% · billed {(actImpliedRate * 100).toFixed(2)}%
                {isoWeek ? ` · ${isoWeek}` : ""}
              </span>
            )}
            {ffExp?.status === "cascade" && (
              <span className="ml-2 text-purple-700 text-xs">rate correct — delta is downstream of WC</span>
            )}
          </td>
          <td className="px-2 py-1 text-right font-mono">{fmtEur(ffAct?.charge ?? null)}</td>
          <td className="px-2 py-1 text-right font-mono text-gray-600">{fmtEur(ffExp?.expected ?? null)}</td>
          <td className={`px-2 py-1 text-right font-mono ${deltaCls(ffExp?.delta ?? null, ffExp?.status)}`}>{fmtDelta(ffExp?.delta ?? null)}</td>
          <td className="px-2 py-1"><span className={`px-1.5 py-0.5 rounded ${statusPill(ffExp?.status ?? "unresolved")}`}>{ffExp?.status ?? "—"}</span></td>
        </tr>
      )}

      {/* Tax row */}
      {(l.tax_code || l.total_tax != null) && (
        <tr className="border-t border-gray-100">
          <td className="px-2 py-1 font-mono">VAT</td>
          <td className="px-2 py-1 text-gray-600">
            {l.tax_code ? (
              <>
                <span className="font-mono">{l.tax_code}</span>
                {TAX_CODE_INFO[l.tax_code] && (
                  <>
                    {" · "}{(TAX_CODE_INFO[l.tax_code].rate * 100).toFixed(0)}%
                    <span className="ml-2 text-gray-500" title={TAX_CODE_INFO[l.tax_code].description}>
                      {TAX_CODE_INFO[l.tax_code].label}
                    </span>
                  </>
                )}
              </>
            ) : (
              "Tax"
            )}
            {l.tax_status === "cascade" && (
              <span className="ml-2 text-purple-700 text-xs">rate correct — delta is downstream</span>
            )}
          </td>
          <td className="px-2 py-1 text-right font-mono">{fmtEur(l.total_tax)}</td>
          <td className="px-2 py-1 text-right font-mono text-gray-600">{fmtEur(l.expected_tax)}</td>
          <td className={`px-2 py-1 text-right font-mono ${deltaCls(l.tax_delta, l.tax_status)}`}>{fmtDelta(l.tax_delta)}</td>
          <td className="px-2 py-1"><span className={`px-1.5 py-0.5 rounded ${statusPill(l.tax_status)}`}>{l.tax_status ?? "—"}</span></td>
        </tr>
      )}

      {/* Total row */}
      <tr className="border-t border-gray-300 bg-gray-50 font-medium">
        <td className="px-2 py-1"></td>
        <td className="px-2 py-1 text-gray-700">Total excl. VAT</td>
        <td className="px-2 py-1 text-right font-mono">{fmtEur(l.charged_amount)}</td>
        <td className="px-2 py-1 text-right font-mono text-gray-700">{fmtEur(l.expected_amount)}</td>
        <td className={`px-2 py-1 text-right font-mono ${deltaCls(l.delta)}`}>{fmtDelta(l.delta)}</td>
        <td className="px-2 py-1"><span className={`px-1.5 py-0.5 rounded ${statusPill(l.audit_status)}`}>{l.audit_status ?? "—"}</span></td>
      </tr>

      {/* Notes row (if any) */}
      {l.audit_notes && (
        <tr className="bg-gray-50">
          <td className="px-2 py-0.5"></td>
          <td colSpan={5} className="px-2 py-0.5 text-gray-500 italic">{l.audit_notes}</td>
        </tr>
      )}

      {/* Reviewer panel: tag, notes, AI chat */}
      <ReviewPanel
        lineId={l.id}
        initialStatus={(l.review_status as ReviewStatus | null) ?? null}
        initialNotes={l.review_notes}
        initialReviewer={l.reviewer}
        reviewedAt={l.reviewed_at ? l.reviewed_at.toISOString() : null}
      />
    </>
  );
}

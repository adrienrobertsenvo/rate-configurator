// Audit-summary analytics — Total invoiced / over / under / cascade / net,
// "By charge type" table (one row per surcharge code with applied + delta
// buckets), and "By product · line counts". Pure UI: caller computes the
// `Analytics` value via `computeAnalytics` and passes it in.
//
// Used by:
//   - app/invoices/[id]/page.tsx     (single invoice scope)
//   - app/invoices/page.tsx          (cross-invoice scope on the shipment view)

import { Fragment } from "react";
import { SURCHARGE_BY_CODE } from "../lib/carriers/dhl-express/surcharge-meta";
import { fmtMoney, fmtMoneySigned, fmtInt } from "../lib/fmt";

const TOL = 0.05;

type Bucket = "over" | "under" | "cascade";
type StatusBucket = { count: number; sum: number };
export type ChargeStats = Record<Bucket, StatusBucket> & {
  applied: { count: number; sum: number };
  // sum is the BILLED amount on lines the audit couldn't form a verdict on —
  // i.e. money in limbo for that charge code. Useful headline ("how much is
  // unaudited?") that the previous count-only view didn't surface.
  unresolved: { count: number; sum: number };
};
export type ProductCounts = Record<string, { over: number; under: number; cascade: number; ok: number; unresolved: number }>;
// Per-product WC dollar stats — surfaced as indented sub-rows under the
// Weight Charge row in the By Charge table. Aligns with the same columns so
// the user can read product-level WC over/under at a glance.
export type ProductWcStats = Record<string, ChargeStats>;
export type Analytics = {
  totalOver: number;
  totalUnder: number;
  totalCascade: number;
  totalUnresolved: number; // sum of billed amount on lines we couldn't audit
  totalApplied: number;
  netDelta: number;
  byCharge: Record<string, ChargeStats>;
  byProduct: ProductCounts;
  wcByProduct: ProductWcStats;
};

export interface AnalyticsLine {
  weight_charge: number | null;
  expected_weight_charge: number | null;
  surcharges_json: string | null;
  expected_surcharges_json: string | null;
  tax_status: string | null;
  tax_delta: number | null;
  total_tax: number | null;
  product_code: string | null;
  product_name?: string | null;  // optional — used to display product names alongside codes
  audit_status: string | null;
  delta: number | null;
}

function emptyChargeStats(): ChargeStats {
  return {
    applied: { count: 0, sum: 0 },
    over: { count: 0, sum: 0 },
    under: { count: 0, sum: 0 },
    cascade: { count: 0, sum: 0 },
    unresolved: { count: 0, sum: 0 },
  };
}

function bumpCharge(by: Record<string, ChargeStats>, code: string, status: Bucket, delta: number) {
  if (!by[code]) by[code] = emptyChargeStats();
  by[code][status].count += 1;
  by[code][status].sum += delta;
}

function bumpApplied(by: Record<string, ChargeStats>, code: string, amount: number) {
  if (!by[code]) by[code] = emptyChargeStats();
  by[code].applied.count += 1;
  by[code].applied.sum += amount;
}

export function computeAnalytics(lines: AnalyticsLine[]): Analytics & { productNames: Record<string, string> } {
  const byCharge: Record<string, ChargeStats> = {};
  const byProduct: ProductCounts = {};
  const wcByProduct: ProductWcStats = {};
  // Per-product name frequency — most common product_name wins as the
  // display label for that code. Lets us show "S · EXPRESS WORLDWIDE nondoc"
  // instead of the bare code letter.
  const nameFreq: Record<string, Record<string, number>> = {};
  let totalApplied = 0;

  for (const l of lines) {
    const prod = l.product_code ?? "?";
    if (l.weight_charge != null && l.weight_charge > 0) {
      bumpApplied(byCharge, "WC", l.weight_charge);
      // Per-product breakdown of WC — same shape as byCharge so we can render
      // it with the same columns, indented under the WC row.
      bumpApplied(wcByProduct, prod, l.weight_charge);
      totalApplied += l.weight_charge;
    }
    if (l.weight_charge != null && l.expected_weight_charge != null) {
      const d = l.weight_charge - l.expected_weight_charge;
      if (Math.abs(d) > TOL) {
        bumpCharge(byCharge, "WC", d > 0 ? "over" : "under", d);
        bumpCharge(wcByProduct, prod, d > 0 ? "over" : "under", d);
      }
    }
    if (l.surcharges_json) {
      try {
        const arr = JSON.parse(l.surcharges_json) as { code: string; charge: number }[];
        for (const s of arr) {
          if (s.charge > 0) {
            bumpApplied(byCharge, s.code, s.charge);
            totalApplied += s.charge;
          }
        }
      } catch {}
    }
    if (l.expected_surcharges_json) {
      try {
        const arr = JSON.parse(l.expected_surcharges_json) as { code: string; status: string; delta: number; actual?: number }[];
        for (const s of arr) {
          if (s.status === "over" || s.status === "under" || s.status === "cascade") {
            bumpCharge(byCharge, s.code, s.status as Bucket, s.delta);
          } else if (s.status === "unresolved") {
            if (!byCharge[s.code]) byCharge[s.code] = emptyChargeStats();
            byCharge[s.code].unresolved.count += 1;
            byCharge[s.code].unresolved.sum += (s.actual ?? 0);
          }
        }
      } catch {}
    }
    if (l.total_tax != null && l.total_tax > 0) {
      bumpApplied(byCharge, "VAT", l.total_tax);
      totalApplied += l.total_tax;
    }
    if ((l.tax_status === "over" || l.tax_status === "under" || l.tax_status === "cascade") && l.tax_delta != null) {
      bumpCharge(byCharge, "VAT", l.tax_status as Bucket, l.tax_delta);
    }

    const lineStatus = (l.audit_status ?? "unresolved") as keyof ProductCounts[string];
    if (!byProduct[prod]) byProduct[prod] = { over: 0, under: 0, cascade: 0, ok: 0, unresolved: 0 };
    if (lineStatus in byProduct[prod]) byProduct[prod][lineStatus] += 1;
    if (l.product_name) {
      if (!nameFreq[prod]) nameFreq[prod] = {};
      nameFreq[prod][l.product_name] = (nameFreq[prod][l.product_name] ?? 0) + 1;
    }

  }

  // Pick the most common product_name per code as the display label.
  const productNames: Record<string, string> = {};
  for (const [code, names] of Object.entries(nameFreq)) {
    let best = "", bestN = 0;
    for (const [n, c] of Object.entries(names)) if (c > bestN) { best = n; bestN = c; }
    if (best) productNames[code] = best;
  }
  // Headline totals are derived from per-charge buckets so they EQUAL the
  // column sums in the "By charge type" table. Doing it the other way (rolling
  // up at the line level via line.audit_status) makes cascade vanish from the
  // headline because lines whose FF row is cascade typically have a non-cascade
  // overall audit_status — losing the FF cascade $ in the rollup.
  let totalOver = 0, totalUnder = 0, totalCascade = 0, totalUnresolved = 0;
  for (const s of Object.values(byCharge)) {
    totalOver      += s.over.sum;
    totalUnder     += s.under.sum;
    totalCascade   += s.cascade.sum;
    totalUnresolved += s.unresolved.sum;
  }
  // Net delta = signed sum of all $ deltas (over + under + cascade). Cascade is
  // included because it represents real money the carrier billed differently
  // from expected — it just happens to be downstream of an upstream error.
  // Unresolved is intentionally excluded — it's $ in limbo, not a delta.
  return { totalOver, totalUnder, totalCascade, totalUnresolved, totalApplied, netDelta: totalOver + totalUnder + totalCascade, byCharge, byProduct, wcByProduct, productNames };
}

export function InvoiceAnalytics({
  a, scopeLabel, productNames, productHref, activeProduct, surchargeHref, activeSurcharge, cellHref, productCellHref, activeStatus,
}: {
  a: Analytics;
  scopeLabel?: string;
  productNames?: Record<string, string>;
  // Clickable charge code (whole row) — toggles the surcharge URL filter.
  surchargeHref?: (code: string | null) => string;
  activeSurcharge?: string | null;
  // Clickable product code (indented under WC) — toggles the product URL filter.
  productHref?: (code: string | null) => string;
  activeProduct?: string | null;
  // Clickable status cell (Total billed / Over / Under / Cascade / Unresolved
  // intersection of a charge row) — sets BOTH surcharge AND status filters
  // in one click. Pass `status: null` to clear status (e.g. for the "Total
  // billed" cell where we just want to filter to the surcharge).
  cellHref?: (opts: { surcharge: string; status: string | null }) => string;
  // Same as cellHref but for the indented PRODUCT subrows under Weight charge.
  // Sets product + status filters (the surcharge is implicitly WC for these
  // rows, so the active surcharge filter is preserved as-is upstream).
  productCellHref?: (opts: { product: string; status: string | null }) => string;
  // Currently-active status filter (so cells can highlight when the user has
  // already drilled into e.g. "VAT under").
  activeStatus?: string | null;
}) {
  const charges = Object.entries(a.byCharge)
    .map(([code, s]) => ({ code, s, weight: Math.abs(s.applied.sum) + Math.abs(s.over.sum) + Math.abs(s.under.sum) + Math.abs(s.cascade.sum) }))
    .filter((r) => r.weight > 0)
    .sort((x, y) => y.weight - x.weight);
  const products = Object.entries(a.byProduct)
    .map(([code, c]) => ({ code, c, total: c.over + c.under + c.cascade + c.ok + c.unresolved }))
    .filter((r) => r.total > 0)
    .sort((x, y) => (y.c.over + y.c.under + y.c.cascade) - (x.c.over + x.c.under + x.c.cascade) || y.total - x.total);

  return (
    <div className="bg-white border rounded">
      <div className="px-4 py-3 border-b">
        <div className="text-sm font-medium text-gray-700 mb-3">
          Audit summary{scopeLabel ? <span className="text-gray-500 font-normal"> · {scopeLabel}</span> : null}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-x-6 gap-y-3">
          <Stat label="Total invoiced" amount={a.totalApplied} cls="text-gray-900" />
          <Stat label="Overcharged" amount={a.totalOver} cls="text-rose-700" />
          <Stat label="Undercharged" amount={a.totalUnder} cls="text-amber-700" />
          <Stat label="Cascade" amount={a.totalCascade} cls="text-purple-700" hint="Rate was right but billed against a wrong upstream base — usually FF or VAT inheriting a WC error." />
          <Stat label="Unresolved" amount={a.totalUnresolved} cls="text-gray-700" hint="Sum of what was billed on charges the audit couldn't form a verdict on (no contract rule, missing data) — money in limbo." absoluteDisplay />
          <Stat label="Net delta" amount={a.netDelta} cls={a.netDelta > 0 ? "text-rose-700" : a.netDelta < 0 ? "text-amber-700" : "text-gray-600"} hint="Signed sum of all $ deltas (over + under + cascade)." />
        </div>
      </div>

      <div className="px-4 py-3">
        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">By charge type</div>
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wide text-gray-400">
            <tr>
              <th className="text-left font-normal pb-2 pr-4 w-1/3">Charge</th>
              <th className="text-right font-normal pb-2 px-3" title="Sum of what was actually billed for this charge across the scope. Multiplier shows how many lines it appeared on.">Total billed</th>
              <th className="text-right font-normal pb-2 px-3 text-rose-600" title="Sum of overcharge deltas">Over</th>
              <th className="text-right font-normal pb-2 px-3 text-amber-600" title="Sum of undercharge deltas">Under</th>
              <th className="text-right font-normal pb-2 px-3 text-purple-600" title="Carrier applied the right rate to a wrong upstream base">Cascade</th>
              <th className="text-right font-normal pb-2 pl-3" title="No contract rule covered this charge — audit couldn't form a verdict">Unresolved</th>
            </tr>
          </thead>
          <tbody>
            {charges.length === 0 && (
              <tr><td colSpan={6} className="text-gray-500 py-2">No charges in scope.</td></tr>
            )}
            {charges.map((r) => {
              const meta = SURCHARGE_BY_CODE.get(r.code);
              const label = r.code === "WC" ? "Weight charge" : r.code === "VAT" ? "VAT" : `${r.code} ${meta?.name ?? ""}`.trim();
              const isActive = activeSurcharge === r.code;
              const chargeCell = surchargeHref ? (
                <a
                  href={surchargeHref(isActive ? null : r.code)}
                  className={`hover:underline ${isActive ? "text-blue-700 font-semibold" : "text-blue-600"}`}
                  title={isActive ? "Clear surcharge filter" : `Filter shipments to those carrying ${r.code}`}
                >
                  <span className="font-mono">{label}</span>
                  {isActive && <span className="text-gray-400 ml-1">× clear</span>}
                </a>
              ) : (
                <span className="font-mono">{label}</span>
              );
              return (
                <Fragment key={r.code}>
                  <tr className={`border-t border-gray-100 ${isActive ? "bg-blue-50" : ""}`}>
                    <td className="py-1.5 pr-4">{chargeCell}</td>
                    <AppliedCell    stats={r.s.applied}    href={cellHref?.({ surcharge: r.code, status: null })}      title={`Filter to ${r.code}`}            active={isActive && (activeStatus == null || activeStatus === "all")} />
                    <DeltaCell      stats={r.s.over}       cls="text-rose-700"   href={cellHref?.({ surcharge: r.code, status: "over" })}     title={`Filter to ${r.code} over`}     active={isActive && activeStatus === "over"} />
                    <DeltaCell      stats={r.s.under}      cls="text-amber-700"  href={cellHref?.({ surcharge: r.code, status: "under" })}    title={`Filter to ${r.code} under`}    active={isActive && activeStatus === "under"} />
                    <DeltaCell      stats={r.s.cascade}    cls="text-purple-700" href={cellHref?.({ surcharge: r.code, status: "cascade" })}  title={`Filter to ${r.code} cascade`}  active={isActive && activeStatus === "cascade"} />
                    <UnresolvedCell stats={r.s.unresolved} href={cellHref?.({ surcharge: r.code, status: "unresolved" })}                     title={`Filter to ${r.code} unresolved`} active={isActive && activeStatus === "unresolved"} />
                  </tr>
                  {r.code === "WC" && products.map((p) => {
                    const wc = a.wcByProduct[p.code];
                    const name = productNames?.[p.code];
                    const isProductActive = activeProduct === p.code;
                    const productCell = productHref ? (
                      <a
                        href={productHref(isProductActive ? null : p.code)}
                        className={`inline-flex items-center gap-1.5 hover:underline ${isProductActive ? "text-blue-700 font-semibold" : "text-blue-600"}`}
                        title={isProductActive ? "Clear product filter" : `Filter to product ${p.code}`}
                      >
                        <span className="font-mono">{p.code}</span>
                        {name && <span className="text-gray-700 font-sans">{name}</span>}
                        <span className="text-gray-400 ml-1">{fmtInt(p.total)} lines</span>
                        {isProductActive && <span className="text-gray-400 ml-1">× clear</span>}
                      </a>
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="font-mono">{p.code}</span>
                        {name && <span className="text-gray-700">{name}</span>}
                        <span className="text-gray-400 ml-1">{fmtInt(p.total)} lines</span>
                      </span>
                    );
                    return (
                      <tr key={`wc-${p.code}`} className={`border-t border-gray-50 text-[11px] ${isProductActive ? "bg-blue-50" : "bg-gray-50/40"}`}>
                        <td className="py-1 pr-4 pl-6 text-gray-600">↳ {productCell}</td>
                        {wc ? (
                          <>
                            <AppliedCell    stats={wc.applied}    href={productCellHref?.({ product: p.code, status: null })}        title={`Filter to product ${p.code}`}            active={isProductActive && (activeStatus == null || activeStatus === "all")} />
                            <DeltaCell      stats={wc.over}       cls="text-rose-700"   href={productCellHref?.({ product: p.code, status: "over" })}     title={`Filter to product ${p.code} over`}     active={isProductActive && activeStatus === "over"} />
                            <DeltaCell      stats={wc.under}      cls="text-amber-700"  href={productCellHref?.({ product: p.code, status: "under" })}    title={`Filter to product ${p.code} under`}    active={isProductActive && activeStatus === "under"} />
                            <DeltaCell      stats={wc.cascade}    cls="text-purple-700" href={productCellHref?.({ product: p.code, status: "cascade" })}  title={`Filter to product ${p.code} cascade`}  active={isProductActive && activeStatus === "cascade"} />
                            <UnresolvedCell stats={wc.unresolved} href={productCellHref?.({ product: p.code, status: "unresolved" })}                     title={`Filter to product ${p.code} unresolved`} active={isProductActive && activeStatus === "unresolved"} />
                          </>
                        ) : (
                          <td colSpan={5} className="py-1 px-3 text-right text-gray-400">no WC billed</td>
                        )}
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, amount, cls, hint, absoluteDisplay }: { label: string; amount: number; cls: string; hint?: string; absoluteDisplay?: boolean }) {
  // Unresolved is a billed-amount bucket, not a signed delta — render as
  // "€X" without sign. Everything else uses fmtMoneySigned so over shows "+",
  // under shows "−".
  const display = absoluteDisplay
    ? Math.abs(amount) < 0.005 ? "€0.00" : `€${fmtMoney(amount)}`
    : fmtMoneySigned(amount);
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500" title={hint}>{label}</div>
      <div className={`font-mono text-lg leading-tight tabular-nums ${cls}`}>{display}</div>
    </div>
  );
}

// Cell components are purely presentational: they render a value and, when
// the caller passes `href`, wrap it in an anchor so a click navigates to the
// pre-built filter URL. This decouples cells from filter DIMENSIONS — the
// charge rows pass surcharge+status URLs, the product sub-rows pass
// product+status URLs, both work the same way.
function CellShell({
  children, padding = "px-3", active, href, title,
}: {
  children: React.ReactNode;
  padding?: string;
  active?: boolean;
  href?: string;
  title?: string;
}) {
  const cls = `py-1.5 ${padding} text-right font-mono whitespace-nowrap tabular-nums ${active ? "bg-blue-100" : ""}`;
  if (href) {
    return (
      <td className={`${cls} hover:bg-blue-50 cursor-pointer`}>
        <a href={href} className="block w-full" title={title}>{children}</a>
      </td>
    );
  }
  return <td className={cls}>{children}</td>;
}

function DeltaCell({ stats, cls, href, active, title }: { stats: StatusBucket; cls: string; href?: string; active?: boolean; title?: string }) {
  if (stats.count === 0) return <td className="py-1.5 px-3 text-right font-mono text-gray-300">—</td>;
  return (
    <CellShell href={href} active={active} title={title}>
      <span className={cls}>{fmtMoneySigned(stats.sum)}</span>{" "}
      <span className="text-gray-400">{fmtInt(stats.count)}×</span>
    </CellShell>
  );
}

function AppliedCell({ stats, href, active, title }: { stats: StatusBucket; href?: string; active?: boolean; title?: string }) {
  if (stats.count === 0) return <td className="py-1.5 px-3 text-right font-mono text-gray-300">—</td>;
  return (
    <CellShell href={href} active={active} title={title}>
      <span className="text-gray-900">€{fmtMoney(stats.sum)}</span>{" "}
      <span className="text-gray-400">{fmtInt(stats.count)}×</span>
    </CellShell>
  );
}

function UnresolvedCell({ stats, href, active, title }: { stats?: { count: number; sum: number }; href?: string; active?: boolean; title?: string }) {
  if (!stats || stats.count === 0) return <td className="py-1.5 pl-3 text-right font-mono text-gray-300">—</td>;
  return (
    <CellShell href={href} active={active} title={title} padding="pl-3">
      <span className="text-gray-900">€{fmtMoney(stats.sum)}</span>{" "}
      <span className="text-gray-400">{fmtInt(stats.count)}×</span>
    </CellShell>
  );
}


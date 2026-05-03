import Link from "next/link";
import { db } from "../lib/db";
import { Nav } from "../components/Nav";
import { ShipmentBlock } from "../components/AuditView";
import { computeAnalytics, InvoiceAnalytics } from "../components/InvoiceAnalytics";
import { UploadInvoice } from "../components/UploadInvoice";
import { resolveCustomer, contractCustomerWhere } from "../lib/customer-context";
import { fmtMoney, fmtMoneySigned, fmtInt } from "../lib/fmt";

export const dynamic = "force-dynamic";

// Pull a short, human-friendly customer label out of the verbose contract name.
// Examples:
//   "DHL Express Germany - byrd technologies Germany GmbH"               → "byrd technologies Germany GmbH"
//   "DHL Express Germany — everstox GmbH Rates 2026"                     → "everstox GmbH"
//   "DHL Express Germany 2026 - BA Logistics GmbH"                       → "BA Logistics GmbH"
//   "DHL Express Germany — Standard"                                      → "Standard"
function customerLabel(name: string): string {
  const stripped = name.replace(/^DHL\s+Express\s+(?:Germany|UK|France|GB|FR|DE)?\s*\d{0,4}\s*[—–-]?\s*/i, "").trim();
  if (/^Standard\b/i.test(stripped)) return stripped;
  return stripped
    .replace(/\s*(Worldwide & Economy\s+)?(Ratecard|Rates)\b.*$/i, "")
    .replace(/\s+\d{4}\s*$/i, "")
    .trim() || stripped;
}

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ customer?: string; view?: string; product?: string; surcharge?: string; status?: string }> }) {
  const { customer: customerParam, view: viewParam, product: productParam, surcharge: surchargeParam, status: statusParam } = await searchParams;
  const customer = await resolveCustomer(customerParam);
  const cWhere = contractCustomerWhere(customer?.id ?? null);
  const view = viewParam === "shipments" ? "shipments" : "invoices";
  // ?product=S, ?surcharge=NX, ?status=over all narrow the shipments-view blocks
  // and drive the visual selection in the analytics + status pills. Independent
  // filters, applied as AND. Default status = "flagged" (over+under+unresolved+
  // cascade), matching the per-invoice "needs review" mental model.
  const productFilter = (productParam ?? "").trim().toUpperCase() || null;
  const surchargeFilter = (surchargeParam ?? "").trim().toUpperCase() || null;
  const STATUS_OPTIONS = ["all", "ok", "over", "under", "cascade", "unresolved"] as const;
  type StatusFilter = typeof STATUS_OPTIONS[number];
  const statusFilter: StatusFilter = (STATUS_OPTIONS as readonly string[]).includes(statusParam ?? "")
    ? (statusParam as StatusFilter)
    : "all";
  const [invoices, contracts] = await Promise.all([
    db.invoice.findMany({
      // Customer scope uses Invoice.customerId directly (set at upload time)
      // so customer-only invoices (no contract attached yet, e.g. SWAP) still
      // show up under their customer.
      where: customer ? { customerId: customer.id } : {},
      orderBy: { uploadedAt: "desc" },
      include: {
        contract: { select: { id: true, name: true, customerId: true } },
        _count: { select: { lines: true } },
      },
    }),
    db.contract.findMany({
      where: cWhere,
      orderBy: { updatedAt: "desc" },
      select: {
        id: true, name: true, customerId: true, account_numbers: true,
        customer: { select: { display_name: true, brand_aliases: true } },
      },
    }),
  ]);

  const invoiceIds = invoices.map((i) => i.id);
  const [stats, overSums, underSums, unresolvedSums] = invoiceIds.length
    ? await Promise.all([
        db.invoiceLine.groupBy({
          by: ["invoiceId", "audit_status"],
          _count: true,
          where: { invoiceId: { in: invoiceIds } },
        }),
        db.invoiceLine.groupBy({
          by: ["invoiceId"],
          _sum: { delta: true },
          where: { invoiceId: { in: invoiceIds }, audit_status: "over" },
        }),
        db.invoiceLine.groupBy({
          by: ["invoiceId"],
          _sum: { delta: true },
          where: { invoiceId: { in: invoiceIds }, audit_status: "under" },
        }),
        // For "unresolved" lines we don't have an expected amount — the engine
        // couldn't form a verdict — so we report the sum of what was BILLED
        // on those lines (the audit-blind exposure). Useful as a "how much
        // money is in limbo" headline.
        db.invoiceLine.groupBy({
          by: ["invoiceId"],
          _sum: { charged_amount: true },
          where: { invoiceId: { in: invoiceIds }, audit_status: "unresolved" },
        }),
      ])
    : [[], [], [], []];
  const statsByInvoice = new Map<number, Record<string, number>>();
  for (const s of stats) {
    if (!statsByInvoice.has(s.invoiceId)) statsByInvoice.set(s.invoiceId, {});
    statsByInvoice.get(s.invoiceId)![s.audit_status ?? "unresolved"] = s._count;
  }
  const overByInvoice = new Map<number, number>();
  for (const r of overSums) if (r._sum.delta != null) overByInvoice.set(r.invoiceId, r._sum.delta);
  const underByInvoice = new Map<number, number>();
  for (const r of underSums) if (r._sum.delta != null) underByInvoice.set(r.invoiceId, r._sum.delta);
  const unresolvedAmtByInvoice = new Map<number, number>();
  for (const r of unresolvedSums) if (r._sum.charged_amount != null) unresolvedAmtByInvoice.set(r.invoiceId, r._sum.charged_amount);

  // Roll up across all invoices in scope for the top summary panel.
  let sumOver = 0, sumUnder = 0, sumInvoiced = 0, sumUnresolvedAmt = 0;
  let cntOk = 0, cntOver = 0, cntUnder = 0, cntUnresolved = 0, cntNoContract = 0;
  for (const inv of invoices) {
    if (inv.total_excl_vat) sumInvoiced += inv.total_excl_vat;
    sumOver += overByInvoice.get(inv.id) ?? 0;
    sumUnder += underByInvoice.get(inv.id) ?? 0;
    sumUnresolvedAmt += unresolvedAmtByInvoice.get(inv.id) ?? 0;
    const s = statsByInvoice.get(inv.id) ?? {};
    cntOk += s.ok ?? 0;
    cntOver += s.over ?? 0;
    cntUnder += s.under ?? 0;
    cntUnresolved += s.unresolved ?? 0;
    cntNoContract += s.no_contract ?? 0;
  }

  // For "by shipment" view: top problem lines across all invoices in scope,
  // rendered in the same multi-row AuditView layout the per-invoice page uses
  // (WC / FF / NX / VAT broken out per shipment). Cap at 100 to keep the page
  // snappy at 50k+ lines in the DB.
  const TOP_N = 100;
  const topIssues = view === "shipments" && invoiceIds.length
    ? await db.invoiceLine.findMany({
        where: {
          invoiceId: { in: invoiceIds },
          // Status filter: "all" = every flagged + ok line; specific status
          // narrows to that one. `cascade` matches both audit_status="cascade"
          // AND lines whose tax/surcharge sub-rows have cascade — caught with
          // a JSON contains check on expected_surcharges_json.
          ...(statusFilter === "all"
            ? {}
            : statusFilter === "cascade"
              ? {
                  OR: [
                    { audit_status: "cascade" },
                    { tax_status: "cascade" },
                    { expected_surcharges_json: { contains: '"status":"cascade"' } },
                  ],
                }
              : { audit_status: statusFilter }),
          ...(productFilter ? { product_code: productFilter } : {}),
          ...(surchargeFilter
            ? surchargeFilter === "WC"
              ? { weight_charge: { gt: 0 } }
              : surchargeFilter === "VAT"
                ? { total_tax: { gt: 0 } }
                : { surcharges_json: { contains: `"code":"${surchargeFilter}"` } }
            : {}),
        },
        // We want the worst absolute deltas first. SQLite can't ORDER BY abs()
        // through Prisma, so pull a wider window ordered by |delta|-friendly
        // proxy and sort precisely in JS.
        orderBy: [{ delta: "desc" }],
        take: TOP_N * 4,
        include: {
          invoice: { select: { invoice_number: true, currency: true, contractId: true } },
        },
      })
    : [];
  topIssues.sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
  const topIssuesCapped = topIssues.slice(0, TOP_N);

  // Audit summary across ALL in-scope lines (not just the top-100 displayed
  // shipments). Same panel as the per-invoice page — gives an at-a-glance
  // breakdown of where money is leaking, by charge type and by product.
  // We deliberately do NOT apply the product filter here — the user wants to
  // see "23k undercharges in product N" even after they've drilled into S,
  // so the by-product table acts as a navigator.
  const allLinesForAnalytics = view === "shipments" && invoiceIds.length
    ? await db.invoiceLine.findMany({
        where: { invoiceId: { in: invoiceIds } },
        select: {
          weight_charge: true, expected_weight_charge: true,
          surcharges_json: true, expected_surcharges_json: true,
          tax_status: true, tax_delta: true, total_tax: true,
          product_code: true, product_name: true,
          audit_status: true, delta: true,
        },
      })
    : [];
  const shipmentAnalytics = view === "shipments" ? computeAnalytics(allLinesForAnalytics) : null;

  // Status pill counts — rolled up across all in-scope lines (irrespective of
  // current status/product/surcharge filters), so the pills always show "what
  // would I see if I clicked this filter".
  //
  // Cascade is a special case: line-level `audit_status === "cascade"` is rare
  // because cascade typically fires on the FF or VAT sub-row only, while the
  // line's overall status ends up "over" or "under". If we counted only
  // line-level cascade, the pill would show 0 while the headline cascade $
  // shows non-zero — confusingly inconsistent. So we count any line that has
  // a cascade indicator anywhere (audit_status, tax_status, or in the
  // expected_surcharges_json blob), matching the cascade FILTER's behavior.
  const statusCounts: Record<string, number> = { all: 0, ok: 0, over: 0, under: 0, cascade: 0, unresolved: 0 };
  if (view === "shipments" && invoiceIds.length) {
    const [grp, cascadeCount] = await Promise.all([
      db.invoiceLine.groupBy({
        by: ["audit_status"],
        _count: true,
        where: { invoiceId: { in: invoiceIds } },
      }),
      db.invoiceLine.count({
        where: {
          invoiceId: { in: invoiceIds },
          OR: [
            { audit_status: "cascade" },
            { tax_status: "cascade" },
            { expected_surcharges_json: { contains: '"status":"cascade"' } },
          ],
        },
      }),
    ]);
    for (const r of grp) {
      const s = r.audit_status ?? "unresolved";
      statusCounts.all += r._count;
      if (s in statusCounts) statusCounts[s] += r._count;
    }
    // Override the cascade count with the broader cascade-anywhere number.
    // Note: this can overlap with over/under/etc. counts (a line marked
    // "under" overall can also have a cascade FF), so the pill counts no
    // longer sum to `all`. That's intentional — cascade is a cross-cutting
    // dimension, not a mutually-exclusive bucket.
    statusCounts.cascade = cascadeCount;
  }

  return (
    <>
      <Nav active="invoices" customer={customer?.code ?? null} />
      <main className="flex-1 overflow-auto p-6">
        <div className="max-w-7xl mx-auto space-y-4">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-semibold">Invoices</h1>
            <UploadInvoice
              contracts={contracts.map((c) => {
                let aliases: string[] = [];
                let accountNumbers: string[] = [];
                try { aliases = c.customer?.brand_aliases ? JSON.parse(c.customer.brand_aliases) : []; } catch {}
                try { accountNumbers = c.account_numbers ? JSON.parse(c.account_numbers) : []; } catch {}
                return {
                  id: c.id,
                  name: c.name,
                  customer_name: c.customer?.display_name ?? null,
                  is_global: c.customerId == null,
                  aliases,
                  accountNumbers,
                };
              })}
            />
          </div>

          {/* Cross-invoice summary — only on the by-invoice list view; the
              shipments view uses the richer InvoiceAnalytics panel below
              instead, which would otherwise duplicate these stats. */}
          {invoices.length > 0 && view === "invoices" && (
            <div className="bg-white border border-gray-200 rounded p-4">
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">
                Across {fmtInt(invoices.length)} invoice{invoices.length === 1 ? "" : "s"}
                {customer ? ` · ${customer.display_name}` : ""}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 mb-4">
                <SummaryStat label="Total invoiced" value={`€${fmtMoney(sumInvoiced)}`} cls="text-gray-900" />
                <SummaryStat label="Net over" value={fmtMoneySigned(sumOver)} cls="text-rose-700" />
                <SummaryStat label="Net under" value={fmtMoneySigned(sumUnder)} cls="text-amber-700" />
                <SummaryStat
                  label="Unresolved billed"
                  value={`€${fmtMoney(sumUnresolvedAmt)}`}
                  cls="text-gray-700"
                  hint="Sum of what was billed on lines the audit couldn't form a verdict on (no contract rule, missing data, etc.) — money in limbo."
                />
              </div>
              {/* Match the column count of the top row so the two grids line
                  up cell-for-cell. Tuck no-contract under "unresolved" as a
                  sub-line when present, instead of adding a 5th column that
                  would force the row wider than the top one. */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 pt-3 border-t border-gray-100">
                <SummaryStat label="Lines: ok" value={fmtInt(cntOk)} cls="text-emerald-700" />
                <SummaryStat label="Lines: over" value={fmtInt(cntOver)} cls="text-rose-700" />
                <SummaryStat label="Lines: under" value={fmtInt(cntUnder)} cls="text-amber-700" />
                <SummaryStat
                  label="Lines: unresolved"
                  value={fmtInt(cntUnresolved)}
                  cls="text-gray-700"
                  sublabel={cntNoContract > 0 ? `+ ${fmtInt(cntNoContract)} no-contract` : undefined}
                  hint={cntNoContract > 0 ? "Plus N lines stored but not audited — customer has no contract attached yet." : undefined}
                />
              </div>
            </div>
          )}

          {/* Empty state when filtered to a customer with zero invoices */}
          {invoices.length === 0 && customer && (
            <div className="bg-white border border-gray-200 rounded p-12 text-center">
              <div className="text-gray-700 font-medium mb-1">No invoices for {customer.display_name}</div>
              <div className="text-sm text-gray-500">
                Upload a DHL CSV with the button above, or run the bulk ingester to attach existing invoices to this customer.
              </div>
            </div>
          )}

          {invoices.length > 0 && (
            <>
              {/* Toggle between per-invoice and per-shipment views */}
              <div className="flex gap-1 text-sm">
                <ViewTab label="By invoice" href={`/invoices${customer ? `?customer=${customer.code}` : ""}`} active={view === "invoices"} />
                <ViewTab
                  label="By shipment issues"
                  href={`/invoices?view=shipments${customer ? `&customer=${customer.code}` : ""}`}
                  active={view === "shipments"}
                />
              </div>

              {view === "invoices" ? (
                <InvoiceTable
                  invoices={invoices}
                  statsByInvoice={statsByInvoice}
                  overByInvoice={overByInvoice}
                  underByInvoice={underByInvoice}
                  showCustomer={customer == null}
                />
              ) : (
                <>
                  {/* Status pill row — same set as the per-invoice page, but
                      counts are rolled up from all in-scope lines via groupBy. */}
                  <StatusPills
                    counts={statusCounts}
                    active={statusFilter}
                    hrefFor={(s) => buildShipmentsHref(customer?.code ?? null, { product: productFilter, surcharge: surchargeFilter, status: s })}
                  />
                  {shipmentAnalytics && (
                    <InvoiceAnalytics
                      a={shipmentAnalytics}
                      scopeLabel={`across ${fmtInt(allLinesForAnalytics.length)} line${allLinesForAnalytics.length === 1 ? "" : "s"} in ${fmtInt(invoices.length)} invoice${invoices.length === 1 ? "" : "s"}`}
                      productNames={shipmentAnalytics.productNames}
                      productHref={(code) => buildShipmentsHref(customer?.code ?? null, { product: code, surcharge: surchargeFilter, status: statusFilter })}
                      activeProduct={productFilter}
                      surchargeHref={(code) => buildShipmentsHref(customer?.code ?? null, { product: productFilter, surcharge: code, status: statusFilter })}
                      activeSurcharge={surchargeFilter}
                      cellHref={({ surcharge, status }) => buildShipmentsHref(customer?.code ?? null, { product: productFilter, surcharge, status })}
                      productCellHref={({ product, status }) => buildShipmentsHref(customer?.code ?? null, { product, surcharge: surchargeFilter, status })}
                      activeStatus={statusFilter}
                    />
                  )}
                  {(productFilter || surchargeFilter) && (
                    <div className="bg-blue-50 border border-blue-200 rounded px-3 py-2 text-xs flex flex-wrap items-center gap-2">
                      <span className="text-gray-600 uppercase tracking-wide">Filter</span>
                      {productFilter && (
                        <span className="inline-flex items-center gap-1.5 bg-white border border-blue-200 rounded px-2 py-0.5">
                          <span className="font-mono text-blue-800 font-medium">product = {productFilter}</span>
                          {shipmentAnalytics?.productNames?.[productFilter] && (
                            <span className="text-blue-700">· {shipmentAnalytics.productNames[productFilter]}</span>
                          )}
                          <Link href={buildShipmentsHref(customer?.code ?? null, { product: null, surcharge: surchargeFilter })} className="text-gray-500 hover:text-rose-600 ml-1">×</Link>
                        </span>
                      )}
                      {surchargeFilter && (
                        <span className="inline-flex items-center gap-1.5 bg-white border border-blue-200 rounded px-2 py-0.5">
                          <span className="font-mono text-blue-800 font-medium">surcharge = {surchargeFilter}</span>
                          <Link href={buildShipmentsHref(customer?.code ?? null, { product: productFilter, surcharge: null })} className="text-gray-500 hover:text-rose-600 ml-1">×</Link>
                        </span>
                      )}
                      {(productFilter && surchargeFilter) && (
                        <Link href={buildShipmentsHref(customer?.code ?? null, { product: null, surcharge: null })} className="ml-auto text-blue-700 hover:underline">
                          clear all
                        </Link>
                      )}
                    </div>
                  )}
                  <ShipmentBlocksList issues={topIssuesCapped} cap={TOP_N} productFilter={productFilter} surchargeFilter={surchargeFilter} />
                </>
              )}
            </>
          )}
        </div>
      </main>
    </>
  );
}

function SummaryStat({ label, value, cls, hint, sublabel }: { label: string; value: string; cls: string; hint?: string; sublabel?: string }) {
  return (
    <div title={hint}>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`font-mono text-base leading-tight tabular-nums ${cls}`}>{value}</div>
      {sublabel && <div className="text-[10px] text-slate-500 mt-0.5">{sublabel}</div>}
    </div>
  );
}

// Build the shipments-view URL preserving the customer scope and toggling the
// product/surcharge/status filters independently. Pass `null` for any to clear.
function buildShipmentsHref(customerCode: string | null, opts: { product?: string | null; surcharge?: string | null; status?: string | null }): string {
  const params = new URLSearchParams();
  params.set("view", "shipments");
  if (customerCode) params.set("customer", customerCode);
  if (opts.product) params.set("product", opts.product);
  if (opts.surcharge) params.set("surcharge", opts.surcharge);
  if (opts.status && opts.status !== "all") params.set("status", opts.status);
  return `/invoices?${params.toString()}`;
}

// Status filter pills — same six options as the per-invoice page, so the
// shipments view across all invoices behaves the same way the audit-status
// row behaves when you're inside one.
function StatusPills({ counts, active, hrefFor }: { counts: Record<string, number>; active: string; hrefFor: (s: string) => string }) {
  const items: ReadonlyArray<readonly [string, string]> = [
    ["all", "bg-gray-100 text-gray-800"],
    ["ok", "bg-green-100 text-green-800"],
    ["over", "bg-red-100 text-red-800"],
    ["under", "bg-amber-100 text-amber-800"],
    ["cascade", "bg-purple-100 text-purple-800"],
    ["unresolved", "bg-gray-200 text-gray-700"],
  ];
  return (
    <div className="flex gap-2 text-sm flex-wrap">
      {items.map(([label, cls]) => (
        <Link
          key={label}
          href={hrefFor(label)}
          className={`px-3 py-1 rounded ${cls} ${active === label ? "ring-2 ring-blue-400 ring-offset-1" : ""}`}
        >
          {label}: {fmtInt(counts[label] ?? 0)}
        </Link>
      ))}
    </div>
  );
}

function ViewTab({ label, href, active }: { label: string; href: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`px-3 py-1.5 rounded ${active ? "bg-blue-600 text-white" : "bg-white border border-gray-300 text-gray-700 hover:bg-gray-50"}`}
    >
      {label}
    </Link>
  );
}

interface InvRow {
  id: number;
  invoice_number: string;
  invoice_date: string;
  total_excl_vat: number | null;
  currency: string;
  contract: { id: number; name: string; customerId: number | null } | null;
  _count: { lines: number };
}

function InvoiceTable({
  invoices, statsByInvoice, overByInvoice, underByInvoice, showCustomer,
}: {
  invoices: InvRow[];
  statsByInvoice: Map<number, Record<string, number>>;
  overByInvoice: Map<number, number>;
  underByInvoice: Map<number, number>;
  showCustomer: boolean;
}) {
  return (
    <div className="bg-white rounded border border-gray-200 overflow-hidden">
      <table className="w-full text-sm tabular-nums">
        <thead className="bg-gray-50">
          <tr className="text-xs text-gray-600">
            <th className="px-3 py-2 text-left border-b font-medium whitespace-nowrap">Invoice #</th>
            <th className="px-3 py-2 text-left border-b font-medium whitespace-nowrap">Date</th>
            {showCustomer && <th className="px-3 py-2 text-left border-b font-medium whitespace-nowrap">Customer</th>}
            <th className="px-3 py-2 text-right border-b font-medium whitespace-nowrap">Lines</th>
            <th className="px-3 py-2 text-right border-b font-medium whitespace-nowrap">OK</th>
            <th className="px-3 py-2 text-right border-b font-medium whitespace-nowrap">Over</th>
            <th className="px-3 py-2 text-right border-b font-medium whitespace-nowrap">Under</th>
            <th className="px-3 py-2 text-right border-b font-medium whitespace-nowrap">Unresolved</th>
            <th className="px-3 py-2 text-right border-b font-medium whitespace-nowrap">Net over €</th>
            <th className="px-3 py-2 text-right border-b font-medium whitespace-nowrap">Net under €</th>
            <th className="px-3 py-2 text-right border-b font-medium whitespace-nowrap">Total (excl. VAT)</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => {
            const s = statsByInvoice.get(inv.id) ?? {};
            const netOver = overByInvoice.get(inv.id) ?? 0;
            const netUnder = underByInvoice.get(inv.id) ?? 0;
            const isGlobal = inv.contract?.customerId == null;
            return (
              <tr key={inv.id} className="even:bg-gray-50 hover:bg-blue-50">
                <td className="px-3 py-2 border-b font-mono text-xs whitespace-nowrap">
                  <Link href={`/invoices/${inv.id}`} className="text-blue-600 hover:underline">
                    {inv.invoice_number}
                  </Link>
                </td>
                <td className="px-3 py-2 border-b whitespace-nowrap">{inv.invoice_date}</td>
                {showCustomer && (
                  <td className="px-3 py-2 border-b text-xs">
                    {inv.contract ? (
                      <span className="text-gray-700 inline-flex items-center gap-1.5" title={inv.contract.name}>
                        {customerLabel(inv.contract.name)}
                        {isGlobal && <GlobalBadge />}
                      </span>
                    ) : (
                      <span className="text-gray-500">—</span>
                    )}
                  </td>
                )}
                <td className="px-3 py-2 border-b text-right">{fmtInt(inv._count.lines)}</td>
                <td className="px-3 py-2 border-b text-right text-green-700">{fmtInt(s.ok ?? 0)}</td>
                <td className="px-3 py-2 border-b text-right text-red-700">{fmtInt(s.over ?? 0)}</td>
                <td className="px-3 py-2 border-b text-right text-amber-700">{fmtInt(s.under ?? 0)}</td>
                <td className="px-3 py-2 border-b text-right text-gray-500">{fmtInt(s.unresolved ?? 0)}</td>
                <td className={`px-3 py-2 border-b text-right font-mono text-xs whitespace-nowrap ${netOver > 0.005 ? "text-rose-700" : "text-gray-400"}`}>
                  {netOver > 0.005 ? `+${fmtMoney(netOver)}` : "—"}
                </td>
                <td className={`px-3 py-2 border-b text-right font-mono text-xs whitespace-nowrap ${netUnder < -0.005 ? "text-amber-700" : "text-gray-400"}`}>
                  {netUnder < -0.005 ? `−${fmtMoney(Math.abs(netUnder))}` : "—"}
                </td>
                <td className="px-3 py-2 border-b text-right font-mono text-xs whitespace-nowrap">
                  {inv.total_excl_vat == null ? "—" : `${fmtMoney(inv.total_excl_vat)} ${inv.currency}`}
                </td>
              </tr>
            );
          })}
          {invoices.length === 0 && (
            <tr>
              <td colSpan={showCustomer ? 11 : 10} className="px-3 py-6 text-center text-gray-500">
                No invoices yet. Select a contract above and upload a DHL standard CSV.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// Cross-invoice "By shipment" view — each problem shipment rendered as the
// same multi-row AuditView block the per-invoice page uses, just with a
// link to its parent invoice on each header. Lets the user see WC + FF +
// every surcharge per problem shipment without clicking into invoices.
type IssueLine = Parameters<typeof ShipmentBlock>[0]["line"] & {
  invoiceId: number;
  invoice: { invoice_number: string; currency: string; contractId: number | null } | null;
};

function ShipmentBlocksList({ issues, cap, productFilter, surchargeFilter }: { issues: IssueLine[]; cap: number; productFilter?: string | null; surchargeFilter?: string | null }) {
  const filterText = [
    productFilter ? `product = ${productFilter}` : null,
    surchargeFilter ? `surcharge = ${surchargeFilter}` : null,
  ].filter(Boolean).join(" + ");
  if (issues.length === 0) {
    return (
      <div className="bg-white rounded border border-gray-200 p-6 text-center text-gray-500">
        {filterText
          ? <>No flagged shipments matching <span className="font-mono">{filterText}</span>.</>
          : "No flagged shipments in scope."}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-500">
        Top {Math.min(issues.length, cap)} flagged shipments
        {filterText ? <> matching <span className="font-mono">{filterText}</span></> : " across all invoices in scope"},
        {" "}ordered by absolute delta.
      </div>
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
            {issues.map((l) => (
              <ShipmentBlock
                key={l.id}
                line={l}
                contractId={l.invoice?.contractId ?? null}
                invoice={l.invoice ? { id: l.invoiceId, number: l.invoice.invoice_number } : undefined}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GlobalBadge() {
  return (
    <span
      className="inline-block px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] uppercase tracking-wide"
      title="System contract — customer-agnostic baseline (e.g. DHL Standard, UK Customs Standard). Visible across all customer scopes."
    >
      global
    </span>
  );
}

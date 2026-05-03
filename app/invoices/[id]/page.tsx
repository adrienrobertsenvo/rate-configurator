import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "../../lib/db";
import { Nav } from "../../components/Nav";
import { AuditView } from "../../components/AuditView";
import { computeAnalytics, InvoiceAnalytics } from "../../components/InvoiceAnalytics";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ filter?: string; customer?: string; product?: string; surcharge?: string }>;
}

export default async function InvoiceDetail({ params, searchParams }: Props) {
  const { id } = await params;
  const invoiceId = Number(id);
  if (!Number.isFinite(invoiceId)) notFound();
  const { filter, customer: customerParam, product: productParam, surcharge: surchargeParam } = await searchParams;
  const productFilter = (productParam ?? "").trim().toUpperCase() || null;
  const surchargeFilter = (surchargeParam ?? "").trim().toUpperCase() || null;

  // True when the line carries an actual surcharge with the given code (or
  // qualifies for our two virtual codes — WC = has weight charge billed,
  // VAT = has VAT amount).
  function lineHasSurcharge(l: { surcharges_json: string | null; weight_charge: number | null; total_tax: number | null }, code: string): boolean {
    if (code === "WC") return (l.weight_charge ?? 0) > 0;
    if (code === "VAT") return (l.total_tax ?? 0) > 0;
    if (!l.surcharges_json) return false;
    try {
      const arr = JSON.parse(l.surcharges_json) as { code: string }[];
      return arr.some((s) => s.code === code);
    } catch { return false; }
  }

  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      contract: { select: { id: true, name: true } },
      lines: { orderBy: { id: "asc" } },
    },
  });
  if (!invoice) notFound();
  const sourceFilename = invoice.source_filename;
  const sourceSize = invoice.source_size_bytes;

  function hasCascadeRow(l: typeof invoice.lines[number]): boolean {
    if (l.tax_status === "cascade") return true;
    if (!l.expected_surcharges_json) return false;
    try {
      const arr = JSON.parse(l.expected_surcharges_json) as { status: string }[];
      return arr.some((s) => s.status === "cascade");
    } catch {
      return false;
    }
  }

  const counts = invoice.lines.reduce(
    (acc, l) => {
      const status = l.audit_status ?? "unresolved";
      acc[status] = (acc[status] ?? 0) + 1;
      if (hasCascadeRow(l)) acc.cascade = (acc.cascade ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  // Review-workflow counts: how many flagged lines have been triaged, by verdict.
  // "needs_review" = audit said over/under/unresolved but reviewer hasn't tagged it yet.
  const reviewCounts = invoice.lines.reduce(
    (acc, l) => {
      const flagged = l.audit_status === "over" || l.audit_status === "under" || l.audit_status === "unresolved";
      if (l.review_status) {
        acc[l.review_status] = (acc[l.review_status] ?? 0) + 1;
        acc.reviewed = (acc.reviewed ?? 0) + 1;
      } else if (flagged) {
        acc.needs_review = (acc.needs_review ?? 0) + 1;
      }
      return acc;
    },
    {} as Record<string, number>,
  );

  const statusFiltered =
    filter && filter !== "all"
      ? filter === "cascade"
        ? invoice.lines.filter(hasCascadeRow)
        : ["correct", "valid_claim", "dispute", "other"].includes(filter)
          ? invoice.lines.filter((l) => l.review_status === filter)
          : filter === "needs_review"
            ? invoice.lines.filter((l) => !l.review_status && (l.audit_status === "over" || l.audit_status === "under" || l.audit_status === "unresolved"))
            : invoice.lines.filter((l) => (l.audit_status ?? "unresolved") === filter)
      : invoice.lines;
  const productFiltered = productFilter
    ? statusFiltered.filter((l) => (l.product_code ?? "").toUpperCase() === productFilter)
    : statusFiltered;
  const filtered = surchargeFilter
    ? productFiltered.filter((l) => lineHasSurcharge(l, surchargeFilter))
    : productFiltered;

  // Analytics is built over ALL lines (not filtered) so the by-product table
  // remains a navigator across the full invoice — clicking a product narrows
  // the audit table below without changing what the analytics shows.
  const analytics = computeAnalytics(invoice.lines);

  // Build URL helpers that preserve the other params when toggling product
  // or surcharge filter.
  const buildHref = (opts: { product?: string | null; surcharge?: string | null }) => {
    const params = new URLSearchParams();
    if (filter) params.set("filter", filter);
    if (customerParam) params.set("customer", customerParam);
    const product = opts.product === undefined ? productFilter : opts.product;
    const surcharge = opts.surcharge === undefined ? surchargeFilter : opts.surcharge;
    if (product) params.set("product", product);
    if (surcharge) params.set("surcharge", surcharge);
    const qs = params.toString();
    return `/invoices/${invoice.id}${qs ? `?${qs}` : ""}`;
  };

  return (
    <>
      <Nav active="invoices" customer={customerParam ?? null} />
      <main className="flex-1 overflow-auto p-6">
        <div className="max-w-7xl mx-auto space-y-4">
          <div>
            <div className="text-xs text-gray-500">
              <Link href="/invoices" className="hover:underline">Invoices</Link> / {invoice.invoice_number}
            </div>
            <div className="flex items-baseline justify-between mt-1">
              <h1 className="text-lg font-semibold">
                {invoice.invoice_number} <span className="text-gray-500 font-normal">· {invoice.invoice_date}</span>
              </h1>
              <div className="text-sm text-gray-600 flex items-center gap-3">
                <span>
                  Contract:{" "}
                  {invoice.contract ? (
                    <Link href={`/contracts/${invoice.contract.id}`} className="text-blue-600 hover:underline">
                      {invoice.contract.name}
                    </Link>
                  ) : (
                    "—"
                  )}
                </span>
                {sourceFilename ? (
                  <a
                    href={`/api/invoice-sources/${invoice.id}`}
                    download
                    className="text-xs text-blue-700 hover:underline"
                    title={`Download original CSV (${sourceSize ? `${(sourceSize / 1024).toFixed(1)} KB` : ""})`}
                  >
                    ↓ {sourceFilename}
                  </a>
                ) : (
                  <span className="text-xs text-gray-400" title="This invoice was loaded before originals were retained.">original not stored</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex gap-2 text-sm flex-wrap">
            {(
              [
                ["all", invoice.lines.length, "bg-gray-100 text-gray-800"],
                ["ok", counts.ok ?? 0, "bg-green-100 text-green-800"],
                ["over", counts.over ?? 0, "bg-red-100 text-red-800"],
                ["under", counts.under ?? 0, "bg-amber-100 text-amber-800"],
                ["cascade", counts.cascade ?? 0, "bg-purple-100 text-purple-800"],
                ["unresolved", counts.unresolved ?? 0, "bg-gray-200 text-gray-700"],
              ] as const
            ).map(([label, count, cls]) => (
              <Link
                key={label}
                href={`/invoices/${invoice.id}?filter=${label}`}
                className={`px-3 py-1 rounded ${cls} ${
                  (filter ?? "all") === label ? "ring-2 ring-blue-400 ring-offset-1" : ""
                }`}
              >
                {label}: {count}
              </Link>
            ))}
          </div>

          {/* Review-workflow counters — separate row so audit verdicts and reviewer triage stay visually distinct */}
          <div className="flex gap-2 text-sm flex-wrap items-center">
            <span className="text-xs text-gray-500 uppercase tracking-wide w-16">Review</span>
            {(
              [
                ["needs_review", reviewCounts.needs_review ?? 0, "bg-blue-100 text-blue-800"],
                ["correct", reviewCounts.correct ?? 0, "bg-emerald-100 text-emerald-800"],
                ["valid_claim", reviewCounts.valid_claim ?? 0, "bg-rose-100 text-rose-800"],
                ["dispute", reviewCounts.dispute ?? 0, "bg-amber-100 text-amber-800"],
                ["other", reviewCounts.other ?? 0, "bg-gray-100 text-gray-800"],
              ] as const
            ).map(([label, count, cls]) => (
              <Link
                key={label}
                href={`/invoices/${invoice.id}?filter=${label}`}
                className={`px-3 py-1 rounded text-xs ${cls} ${
                  filter === label ? "ring-2 ring-blue-400 ring-offset-1" : ""
                }`}
              >
                {label.replace("_", " ")}: {count}
              </Link>
            ))}
          </div>

          <InvoiceAnalytics
            a={analytics}
            productNames={analytics.productNames}
            productHref={(code) => buildHref({ product: code })}
            activeProduct={productFilter}
            surchargeHref={(code) => buildHref({ surcharge: code })}
            activeSurcharge={surchargeFilter}
            // Combined click: sets surcharge + status (the per-invoice page
            // expresses status via the legacy `filter` URL param). Cells with
            // status===null clear the status filter, so e.g. clicking the
            // "Total billed" cell on VAT just narrows by surcharge.
            cellHref={({ surcharge, status }) => {
              const params = new URLSearchParams();
              if (status) params.set("filter", status); else if (filter) params.set("filter", filter);
              if (customerParam) params.set("customer", customerParam);
              if (productFilter) params.set("product", productFilter);
              params.set("surcharge", surcharge);
              const qs = params.toString();
              return `/invoices/${invoice.id}${qs ? `?${qs}` : ""}`;
            }}
            productCellHref={({ product, status }) => {
              const params = new URLSearchParams();
              if (status) params.set("filter", status); else if (filter) params.set("filter", filter);
              if (customerParam) params.set("customer", customerParam);
              params.set("product", product);
              if (surchargeFilter) params.set("surcharge", surchargeFilter);
              const qs = params.toString();
              return `/invoices/${invoice.id}${qs ? `?${qs}` : ""}`;
            }}
            activeStatus={filter ?? null}
          />

          {(productFilter || surchargeFilter) && (
            <div className="bg-blue-50 border border-blue-200 rounded px-3 py-2 text-xs flex flex-wrap items-center gap-2">
              <span className="text-gray-600 uppercase tracking-wide">Filter</span>
              {productFilter && (
                <span className="inline-flex items-center gap-1.5 bg-white border border-blue-200 rounded px-2 py-0.5">
                  <span className="font-mono text-blue-800 font-medium">product = {productFilter}</span>
                  {analytics.productNames[productFilter] && <span className="text-blue-700">· {analytics.productNames[productFilter]}</span>}
                  <Link href={buildHref({ product: null })} className="text-gray-500 hover:text-rose-600 ml-1">×</Link>
                </span>
              )}
              {surchargeFilter && (
                <span className="inline-flex items-center gap-1.5 bg-white border border-blue-200 rounded px-2 py-0.5">
                  <span className="font-mono text-blue-800 font-medium">surcharge = {surchargeFilter}</span>
                  <Link href={buildHref({ surcharge: null })} className="text-gray-500 hover:text-rose-600 ml-1">×</Link>
                </span>
              )}
              <span className="text-gray-500">· {filtered.length} of {statusFiltered.length} line{statusFiltered.length === 1 ? "" : "s"}</span>
              {(productFilter && surchargeFilter) && (
                <Link href={buildHref({ product: null, surcharge: null })} className="ml-auto text-blue-700 hover:underline">clear all</Link>
              )}
            </div>
          )}

          <AuditView invoiceId={invoice.id} contractId={invoice.contract?.id ?? null} lines={filtered} />
        </div>
      </main>
    </>
  );
}


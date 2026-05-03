import Link from "next/link";
import { Nav } from "../components/Nav";
import { db } from "../lib/db";
import { FUEL_RATES, type FuelClass } from "../lib/carriers/dhl-express/fuel-rates";
import { SURCHARGES } from "../lib/carriers/dhl-express/surcharge-meta";
import { UPS_FUEL_RATES, type UpsFuelClass } from "../lib/carriers/ups/fuel-rates";
import { SURCHARGES as UPS_SURCHARGES } from "../lib/carriers/ups/surcharge-meta";
import { SyncSurchargesButton } from "../components/SyncSurchargesButton";

export const dynamic = "force-dynamic";

async function loadWorkedExample() {
  // Pull a real invoice line that exercises weight + a fuelable surcharge + fuel.
  const line = await db.invoiceLine.findFirst({
    where: { weight_charge: { gt: 0 }, charged_amount: { gt: 0 } },
    orderBy: { id: "desc" },
    include: { invoice: { select: { invoice_number: true, contract: { select: { name: true } } } } },
  });
  return line;
}

export default async function RulesPage({ searchParams }: { searchParams: Promise<{ customer?: string; carrier?: string }> }) {
  const { customer: customerParam, carrier: carrierParam } = await searchParams;
  const carrier: "dhl" | "ups" = carrierParam === "ups" ? "ups" : "dhl";
  const example = await loadWorkedExample();
  function tabHref(c: string) {
    const params = new URLSearchParams();
    if (customerParam) params.set("customer", customerParam);
    if (c !== "dhl") params.set("carrier", c);
    const qs = params.toString();
    return `/rules${qs ? `?${qs}` : ""}`;
  }
  return (
    <>
      <Nav active="rules" customer={customerParam ?? null} />
      <main className="flex-1 overflow-auto p-6">
        <div className="max-w-4xl mx-auto prose prose-sm prose-slate">
          {/* Carrier tabs — same UX as the Invoices page so both surfaces
              feel consistent. The DHL tab is the default. */}
          <div className="flex gap-1 text-sm not-prose mb-3">
            <Link href={tabHref("dhl")} className={`px-3 py-1.5 rounded ${carrier === "dhl" ? "bg-amber-100 text-amber-900 ring-2 ring-blue-400 ring-offset-1" : "bg-amber-50 text-amber-900 hover:bg-amber-100"}`}>DHL Express</Link>
            <Link href={tabHref("ups")} className={`px-3 py-1.5 rounded ${carrier === "ups" ? "bg-stone-100 text-stone-900 ring-2 ring-blue-400 ring-offset-1" : "bg-stone-50 text-stone-900 hover:bg-stone-100"}`}>UPS</Link>
          </div>

          {carrier === "ups" && <UpsRulesSection />}
          {carrier === "dhl" && <DhlRulesSection example={example} />}
        </div>
      </main>
    </>
  );
}

function DhlRulesSection({ example }: { example: Awaited<ReturnType<typeof loadWorkedExample>> }) {
  return (
    <>
          <h1 className="text-xl font-semibold mb-1">DHL Express Germany — Pricing Rule Set</h1>
          <p className="text-sm text-gray-600">
            How an invoice line is built, derived from DHL&rsquo;s published pages and validated against ~7,000
            real invoice lines (BA Logistics, Byrd Technologies, Apothekerei Grintz, Apothekerei Giesing, everstox).
            Currency is EUR throughout. All weights in kg unless noted.
          </p>

          <div className="my-4">
            <SyncSurchargesButton />
          </div>

          <h2 className="mt-6 text-base font-semibold">1. The formula in one line</h2>
          <pre className="bg-gray-900 text-gray-100 text-xs p-3 rounded overflow-auto">{`Total (excl. VAT) =
    Weight Charge
  + Σ non-fuelable surcharges  (FD, MA, RD, DD, …)
  + Σ fuelable surcharges      (NX, OO, YL, YO, YB, CA, YK, …)
  + Fuel Surcharge   = fuel_rate(week, class) × (Weight Charge + Σ fuelable surcharges)

Total (incl. VAT)   = Total (excl. VAT) × (1 + tax_rate(tax_code))`}</pre>

          <h2 className="mt-6 text-base font-semibold">2. Step-by-step</h2>
          <ol className="list-decimal pl-5 space-y-2 text-sm">
            <li><b>Chargeable weight.</b> <code>chargeable_kg = max(actual_kg, volumetric_kg)</code> where{" "}
              <code>volumetric_kg = (L × W × H) / divisor</code>. DHL Express divisor is <b>5000</b> for cm³ → kg.
              Invoice CSV reports the choice in &quot;Weight Flag&quot; (<code>A</code> = actual, <code>V</code> = volumetric, <code>B</code> = both equal).
            </li>
            <li><b>Zone lookup.</b> The destination ISO-2 code maps to a numbered zone via the carrier&rsquo;s zone map. DHL Express Germany uses <b>10 zones</b> (a contract may override).
              Zone 1 is domestic; higher zones are progressively further. EU vs non-EU is also product-coded (S/U for Express, V/N for Economy).
            </li>
            <li><b>Weight charge.</b> Look up the rate band for (<i>sub-product, zone, chargeable weight</i>). Below the &quot;tail&quot; threshold each band is a flat price; above it, billing is <code>per_kg × chargeable_kg</code>, often rounded up in fixed steps (e.g. 0.5 kg).</li>
            <li><b>Optional surcharges.</b> Each contract has flat (€), per-shipment, per-kg, or percent rules. Some are always charged when applicable (e.g. NX peak), others only when a service is selected (CA, FD, YK).</li>
            <li><b>Fuel surcharge.</b>{" "}
              <code>FF = rate × base</code> where <code>base = weight_charge + Σ fuelable_surcharges</code>.
              Fuel rate is published <b>weekly</b> by DHL and depends on which network the product flies through:
              <ul className="list-disc pl-5 mt-1">
                <li><b>AIR</b> — products S, U, T, Y (international Express). Index = US Gulf Coast jet fuel, 20-day average.</li>
                <li><b>ROAD</b> — products E, V, N (Domestic Express + Economy Select). Index = US Gulf Coast diesel, 20-day average.</li>
              </ul>
            </li>
            <li><b>Tax (VAT).</b> <code>VAT = total_excl_vat × rate(tax_code)</code>. Codes seen: <code>A</code> 19% (DE/EU), <code>B</code> 7%, <code>C</code> 0% (export, Art. 146), <code>X</code> tax-exempt, <code>Z</code> pass-through (duties).</li>
          </ol>

          <h2 className="mt-6 text-base font-semibold">3. Surcharge catalog</h2>
          <p className="text-sm">Whether a surcharge is in the fuel base — &quot;⛽&quot; below — comes from DHL&rsquo;s <a href="https://www.dhl.de/en/geschaeftskunden/express/produkte-und-services/zuschlaege/treibstoffzuschlag-air.html" className="underline">AIR</a> and{" "}
            <a href="https://www.dhl.de/en/geschaeftskunden/express/produkte-und-services/zuschlaege/treibstoffzuschlag-road.html" className="underline">ROAD</a> pages and was confirmed by regression on the invoice data.</p>
          <table className="w-full text-sm border border-gray-200">
            <thead className="bg-gray-50 text-left">
              <tr><th className="px-2 py-1">Code</th><th className="px-2 py-1">Name</th><th className="px-2 py-1">Kind</th><th className="px-2 py-1 text-center">⛽ Fuel base</th><th className="px-2 py-1">Notes</th></tr>
            </thead>
            <tbody>
              {SURCHARGES.map((s) => (
                <tr key={s.code} className="border-t">
                  <td className="px-2 py-1 font-mono">{s.code}</td>
                  <td className="px-2 py-1">{s.name}</td>
                  <td className="px-2 py-1 text-xs text-gray-700">{s.kind}</td>
                  <td className="px-2 py-1 text-center">{s.fuelable ? "⛽" : ""}</td>
                  <td className="px-2 py-1 text-xs text-gray-700">{s.notes ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2 className="mt-6 text-base font-semibold">4. Fuel surcharge — published rates</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FuelTable klass="AIR" />
            <FuelTable klass="ROAD" />
          </div>
          <p className="text-xs text-gray-600 mt-2">
            Source: dhl.de AIR + ROAD fuel-surcharge pages. Each entry takes effect at the start of the listed ISO week and stays in force until superseded.
          </p>

          <h2 className="mt-6 text-base font-semibold">5. Special cases</h2>
          <ul className="list-disc pl-5 space-y-1 text-sm">
            <li><b>Z product — Duties &amp; Taxes.</b> Z lines have weight charge €0; the line carries pass-through codes (<code>XB</code>, <code>XX</code>, <code>XK</code>, <code>XS</code>, <code>XE</code>) plus the DTP fee <code>DD</code>. No fuel surcharge.</li>
            <li><b>Domestic toll (RD).</b> Appears on every Domestic Express (E) line, small and variable (€0.10–0.30) per shipment. Not in the fuel base per DHL&rsquo;s ROAD page.</li>
            <li><b>NX (Demand Surcharge / Peak).</b> Most contracts price NX as <code>per_kg</code>; some apply a flat per-shipment minimum. Always in the fuel base.</li>
            <li><b>Multi-piece shipments.</b> Each piece&rsquo;s chargeable weight is computed individually, then the line bills the total chargeable weight (DHL&rsquo;s standard rule).</li>
          </ul>

          <h2 className="mt-6 text-base font-semibold">6. Worked example (real invoice line)</h2>
          {example ? (
            <WorkedExample line={example} />
          ) : (
            <p className="text-sm">No suitable invoice lines loaded yet — upload an invoice on the Invoices page to populate this section.</p>
          )}

          <h2 className="mt-8 text-base font-semibold">7. Engineering notes & assumptions</h2>
          <p className="text-sm text-gray-600">
            Decisions, gotchas, and load-bearing assumptions made while building the audit pipeline. Anything here
            is something a future developer or auditor needs to know that <em>isn&rsquo;t</em> obvious from reading
            the code or schema. Order is rough recency.
          </p>

          <h3 className="mt-4 text-sm font-semibold">Fuel-rate timing — the &ldquo;Apr 1 rule&rdquo;</h3>
          <p className="text-sm">
            <code>app/lib/fuel-rates.ts</code> publishes rates by ISO week, but real DHL billings show that
            <strong> at month boundaries the new rate applies from the 1st of the new month, not the preceding Monday</strong>.
            Concretely: shipments dated 2026-03-30 / 2026-03-31 (Mon/Tue of W14) are billed at the W13 rate;
            the new W14 rate only kicks in on Wed 2026-04-01. That single shift recovered ~2,500 false-under
            FF audit lines. The schema is now keyed by <code>effective_from</code> (an ISO date) instead of
            <code>iso_week</code>, with the W14 entries dated <code>2026-04-01</code>. Other entries are still
            on the Monday of their ISO week — if a future month-edge transition causes systematic
            &ldquo;under&rdquo; deltas around the 1st, shift that entry&rsquo;s <code>effective_from</code> too.
          </p>

          <h3 className="mt-4 text-sm font-semibold">Fuel base = WC + fuelable surcharges (which ones, exactly)</h3>
          <p className="text-sm">
            The fuel surcharge formula is <code>FF = rate × (WC + Σ fuelable surcharges)</code>. Which codes
            are fuelable is in <code>app/lib/surcharge-meta.ts</code> as the <code>fuelable: true</code> flag.
            Cross-validated against ~7k invoice lines: when the right codes are summed and the fuel rate is
            correct (per the &ldquo;Apr 1 rule&rdquo; above), the implied billing rate matches the published
            rate to ±0.5 percentage points.
          </p>
          <ul className="text-sm">
            <li><b>Fuelable</b>: NX (Demand), OO + OB (Remote Area Delivery + Pickup), YL/YO/YY (Non-Conveyable + Overweight), YB (Oversize), CA (Elevated Risk), YK (Premium 12:00), WP (Restricted Destination).</li>
            <li><b>Not fuelable</b>: FD (GoGreen Plus), MA (Address Correction), RD (Toll), DD (Duty Tax Paid admin fee), all customs pass-through codes (XB/XX/XK/XS/XE/W*).</li>
          </ul>

          <h3 className="mt-4 text-sm font-semibold">Demand Surcharge (NX) — externally-published, not contract-priced</h3>
          <p className="text-sm">
            DHL publishes the demand-surcharge matrix on{" "}
            <a className="text-blue-600 hover:underline" href="https://www.dhl.de/en/geschaeftskunden/express/produkte-und-services/zuschlaege.html#demand-surcharge" target="_blank" rel="noopener">dhl.de</a>{" "}
            and changes it a few times per year. Live schedules live in <code>app/lib/demand-surcharge.ts</code>;
            origin/destination regions are mapped via <code>app/lib/region-map.ts</code> (8 regions: CN-HK,
            SAS, ROA, OCE, EUR, AMS, MENA, ROW). The published O/D matrix collapses South Asia + Rest of Asia
            into one destination column &mdash; we canonicalize SAS&rarr;ROA on dest-side lookup. Contract NX
            rules with <code>kind: &quot;external_demand&quot;</code> defer to this schedule; contracts with
            no NX rule still get auto-rated against the public schedule (with a note in audit_notes).
            <strong> Use the &ldquo;Sync now&rdquo; button at the top of this page to compare the published
            matrix against our local copy.</strong> Propose-only — no auto-apply.
          </p>

          <h3 className="mt-4 text-sm font-semibold">Account-number routing</h3>
          <p className="text-sm">
            On invoice upload we route to a contract by matching the CSV&rsquo;s <em>Billing Account</em> (column 12 of row 2)
            against <code>Contract.account_numbers</code> (a JSON array of DHL account numbers). Account-number match
            wins over name/alias match because one customer can have multiple accounts and multiple contracts (e.g.
            Byrd has separate contracts for the Byrd account 144114670 and the GoCase account 145462725 &mdash; both
            under the same Customer). When a user manually picks a contract for a never-seen account number, the
            account number is appended to the contract&rsquo;s <code>account_numbers</code> &mdash; <strong>auto-learn:
            next upload routes itself</strong>.
          </p>

          <h3 className="mt-4 text-sm font-semibold">Customer-only invoices (no contract attached)</h3>
          <p className="text-sm">
            <code>Invoice.customerId</code> is a separate column from <code>contract.customerId</code> so we can
            store invoices for a customer who doesn&rsquo;t yet have a contract loaded (e.g. SWAP Commerce&rsquo;s
            72 freight CSVs while we wait for their DHL Express ratecard). Lines on those invoices get
            <code>audit_status = &quot;no_contract&quot;</code>. The customer scope on <code>/invoices</code> filters
            by <code>customerId</code>, so they show up correctly. Re-attaching a contract later + re-running
            <code>scripts/reaudit_invoices.ts &lt;contractId&gt;</code> populates real verdicts.
          </p>

          <h3 className="mt-4 text-sm font-semibold">Cascade detection on FF</h3>
          <p className="text-sm">
            When the fuel rate matches the published rate within ±0.5pp <em>but</em> the upstream weight charge is
            wrong, the FF row is marked <code>cascade</code> instead of over/under. This stops the FF row from
            screaming &ldquo;wrong&rdquo; just because WC was off &mdash; the fuel itself was applied correctly.
            Same logic applies to VAT and tax rows. See <code>app/lib/rate-engine.ts</code> &ldquo;cascade
            detection&rdquo; comment.
          </p>

          <h3 className="mt-4 text-sm font-semibold">Customs / Z-product invoices</h3>
          <p className="text-sm">
            UK Customs invoices (Z product, AVB invoice prefix) bypass the freight engine entirely &mdash; routed
            via <code>computeCustomsLine</code> in <code>app/lib/rate-engine.ts</code>. WC is €0; codes XB/XX/XK/XS/XE
            are pass-through (audit status = &ldquo;passthrough&rdquo;); WC/WD/DD are admin fees priced as
            <code>percent_of_taxes</code> with a configurable minimum. Detected at parse time via
            <code>Invoice.invoice_type</code> (&ldquo;customs&rdquo; vs &ldquo;freight&rdquo;).
          </p>

          <h3 className="mt-4 text-sm font-semibold">Per-band time-bound rates</h3>
          <p className="text-sm">
            <code>PriceBand.valid_from</code> / <code>valid_until</code> let a single contract carry multiple
            rate sets that overlap in (zone, weight) but apply at different shipment dates. Used by everstox
            where a published rate set and a &ldquo;New Offer&rdquo; rate set co-exist; the engine picks the
            band whose validity contains the shipment&rsquo;s <code>shipment_date</code>. NULL values inherit
            the parent contract&rsquo;s validity.
          </p>

          <h3 className="mt-4 text-sm font-semibold">Country aliases</h3>
          <p className="text-sm">
            <code>app/lib/country-aliases.ts</code> normalizes non-standard country codes seen on real invoices
            (notably <code>KV</code> &rarr; <code>XK</code> for Kosovo). Apply at zone lookup, not at parse time
            &mdash; we keep the original string on the InvoiceLine for fidelity.
          </p>

          <h3 className="mt-4 text-sm font-semibold">Original CSVs are stored on every Invoice</h3>
          <p className="text-sm">
            <code>Invoice.source_bytes</code> + <code>source_filename</code> + <code>source_sha256</code> hold the
            original uploaded CSV verbatim. Served back via the <code>/api/invoice-sources/[id]</code> route as a
            download link on the invoice detail page. Lets the user verify against what they uploaded; also
            unblocks the <code>backfill_account_numbers.ts</code> script which re-derives DHL accounts from the
            stored row 2 of each invoice.
          </p>

          <h3 className="mt-4 text-sm font-semibold">Import-direction zone lookup</h3>
          <p className="text-sm">
            For products mapped as <code>direction === &quot;import&quot;</code> in the catalog (W/H/V), the zone
            is looked up by <code>origin_country</code> instead of <code>dest_country</code>. Otherwise import
            shipments would all hit Germany&rsquo;s domestic zone and audit OK incorrectly.
          </p>

          <h3 className="mt-4 text-sm font-semibold">System (global) contracts &amp; zone maps</h3>
          <p className="text-sm">
            Rows with <code>customerId = NULL</code> are <em>system</em> baselines &mdash; the DHL Express Standard
            ratecard (#1), UK Customs Standard (#11), and the GB/FR/DE-economy ZoneMaps. Visible across all
            customer scopes; tagged with a <code>global</code> pill in the UI to make their special status obvious.
          </p>
    </>
  );
}

function FuelTable({ klass }: { klass: FuelClass }) {
  const rows = FUEL_RATES[klass];
  return (
    <div>
      <h3 className="font-medium text-sm">{klass} {klass === "AIR" ? " — international Express (S/U/T/Y)" : " — Domestic + Economy (E/V/N)"}</h3>
      <table className="w-full text-xs border border-gray-200 mt-1">
        <thead className="bg-gray-50 text-left"><tr><th className="px-2 py-0.5">Week</th><th className="px-2 py-0.5 text-right">Rate</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.iso_week} className="border-t"><td className="px-2 py-0.5 font-mono">{r.iso_week}</td><td className="px-2 py-0.5 font-mono text-right">{(r.rate * 100).toFixed(2)}%</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type ExampleLine = NonNullable<Awaited<ReturnType<typeof loadWorkedExample>>>;

function WorkedExample({ line }: { line: ExampleLine }) {
  const surcharges: { code: string; name: string; charge: number }[] = line.surcharges_json ? JSON.parse(line.surcharges_json) : [];
  const ff = surcharges.find((s) => s.code === "FF");
  const fuelable = surcharges.filter((s) => SURCHARGES.find((m) => m.code === s.code)?.fuelable);
  const nonFuelable = surcharges.filter((s) => !SURCHARGES.find((m) => m.code === s.code)?.fuelable && s.code !== "FF");
  const fuel_base = (line.weight_charge ?? 0) + fuelable.reduce((a, s) => a + s.charge, 0);
  const implied_rate = ff && fuel_base ? ff.charge / fuel_base : null;

  return (
    <div className="bg-white border border-gray-200 rounded p-3 text-sm">
      <div className="text-xs text-gray-600 mb-2">{line.invoice?.invoice_number} · shipment {line.shipment_number} · {line.product_code} {line.origin_country}→{line.dest_country} · {line.weight_kg} kg ({line.weight_flag}) · {line.invoice?.contract?.name}</div>
      <table className="w-full text-sm">
        <tbody className="font-mono">
          <tr><td>Weight charge</td><td className="text-right">€{(line.weight_charge ?? 0).toFixed(2)}</td></tr>
          {fuelable.map((s) => (
            <tr key={s.code}><td>{s.code} {s.name} <span className="text-amber-700 text-xs">⛽</span></td><td className="text-right">€{s.charge.toFixed(2)}</td></tr>
          ))}
          <tr className="border-t"><td>Fuel base = WC + Σ ⛽</td><td className="text-right">€{fuel_base.toFixed(2)}</td></tr>
          {ff && implied_rate != null && (
            <tr><td>FF Fuel = {(implied_rate * 100).toFixed(2)}% × €{fuel_base.toFixed(2)}</td><td className="text-right">€{ff.charge.toFixed(2)}</td></tr>
          )}
          {nonFuelable.map((s) => (
            <tr key={s.code}><td>{s.code} {s.name}</td><td className="text-right">€{s.charge.toFixed(2)}</td></tr>
          ))}
          <tr className="border-t font-semibold"><td>Total excl. VAT (invoice)</td><td className="text-right">€{(line.charged_amount ?? 0).toFixed(2)}</td></tr>
          {line.tax_code && line.total_tax != null && (
            <tr><td>VAT ({line.tax_code})</td><td className="text-right">€{line.total_tax.toFixed(2)}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// =====================================================================
// UPS rules — narrative + reference tables. Same structure as the DHL
// section so the two are easy to compare. Anything that's "DERIVED" (not
// from the contract document) is called out so a reviewer can spot-check.
// =====================================================================
function UpsRulesSection() {
  return (
    <>
      <h1 className="text-xl font-semibold mb-1">UPS Germany — Pricing Rule Set</h1>
      <p className="text-sm text-gray-600">
        How a UPS invoice line is built, derived from UPS&rsquo;s published Fuel Surcharge page,
        the &ldquo;Forwarding Data Dictionary V5&rdquo; CSV format spec, the contract XLSX rate
        cards (everstox + Thomann had them, Quivo was PDF-only), and ~40,000 real
        invoice lines (everstox / Quivo / Thomann). Currency is EUR. Weights in kg unless noted.
      </p>

      <h2 className="mt-6 text-base font-semibold">1. The formula in one line</h2>
      <pre className="bg-gray-900 text-gray-100 text-xs p-3 rounded overflow-auto">{`Total per shipment =
    Weight Charge (FRT)        ← rate-band lookup by (sub-product, zone, weight)
  + Σ accessorials (ACC)        ← contract Surcharge rules per code
  + Fuel Surcharge (FSC)        ← published_rate × fuel_multiplier × (WC + Σ fuelable accessorials)
  + Pass-through (TAX)          ← VAT, audited as passthrough — engine doesn't price it

UPS bills tax as a separate row in the same CSV; INF and EXM rows are informational/exemption metadata, never billed.
MSC rows (Daily/Weekly Service Fee, late-payment) belong to the invoice as a whole, surfaced as a synthetic "INV" pseudo-shipment.`}</pre>

      <h2 className="mt-6 text-base font-semibold">2. CSV format — what makes UPS different from DHL</h2>
      <ul className="text-sm">
        <li><b>No header row.</b> Every row is data; column positions are fixed per UPS&rsquo;s &ldquo;Forwarding Data Dictionary V5&rdquo;.</li>
        <li><b>Row-per-CHARGE, not row-per-shipment.</b> A single shipment can produce 5–10 rows (FRT + ACC + FSC + TAX + INF), each with its own Net Amount. The parser groups by Tracking Number (col 21) to reconstruct the shipment.</li>
        <li><b>Latin-1 encoded.</b> German umlauts (&ldquo;Treibstoffzuschl&auml;ge&rdquo;) decode as mojibake under UTF-8. The parser decodes via <code>TextDecoder(&quot;latin1&quot;)</code>.</li>
        <li><b>Account numbers are 10-char alphanumeric with leading zeros</b> on the wire (<code>00000FV384</code>) but the user-facing UI form is 6-char (<code>0FV384</code>). <code>normalizeUpsAccount</code> strips leading zeros so both round-trip.</li>
        <li>Pricing columns at the row level: col 49 <code>Basis Value</code> (the base the charge is computed against — for FSC = freight base, for EVS = declared value), col 52 <code>Incentive Amount</code> (list/published rate), col 53 <code>Net Amount</code> (the actual billed amount). The audit compares against col 53.</li>
      </ul>

      <h2 className="mt-6 text-base font-semibold">3. Service codes (col 45 on FRT rows)</h2>
      <ul className="text-sm">
        <li><b>003</b> — UPS Domestic Standard (German &ldquo;Dom. Standard&rdquo;) · GROUND fuel class</li>
        <li><b>011</b> — UPS Standard (intra-Europe ground &ldquo;TB Standard&rdquo;) · GROUND</li>
        <li><b>007</b> — UPS Worldwide Express · AIR</li>
        <li><b>069</b> — UPS Worldwide Express Saver · AIR</li>
        <li><b>054</b> — UPS Worldwide Express Plus · AIR</li>
        <li><b>008</b> — UPS Worldwide Expedited · AIR</li>
        <li><b>066</b> — UPS Worldwide Express Freight · AIR</li>
        <li><b>017 / 072</b> — UPS Worldwide Economy DDU / DDP · AIR</li>
        <li><b>021</b> — UPS Economy · AIR</li>
        <li><b>074</b> — UPS Express 12:00 · AIR</li>
      </ul>

      <h2 className="mt-6 text-base font-semibold">4. Surcharge codes (col 45 on ACC rows)</h2>
      <table className="w-full text-xs border border-gray-200 mt-1">
        <thead className="bg-gray-50 text-left">
          <tr><th className="px-2 py-1">Code</th><th className="px-2 py-1">Name</th><th className="px-2 py-1">Kind</th><th className="px-2 py-1 text-center">Fuelable?</th></tr>
        </thead>
        <tbody>
          {UPS_SURCHARGES.map((s) => (
            <tr key={s.code} className="border-t">
              <td className="px-2 py-1 font-mono">{s.code}</td>
              <td className="px-2 py-1">{s.name}</td>
              <td className="px-2 py-1 font-mono">{s.kind}</td>
              <td className="px-2 py-1 text-center">{s.fuelable ? "✓" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="mt-6 text-base font-semibold">5. Fuel surcharge — published rates × per-customer multiplier</h2>
      <p className="text-sm">
        UPS publishes a single fuel-surcharge schedule (weekly, AIR vs GROUND); each contract
        negotiates a discount captured as <code>Contract.fuel_multiplier</code>. The audit then computes
        <code> expected_FSC = (WC + Σ fuelable accessorials) × published_rate × fuel_multiplier</code>.
        That&rsquo;s why the same row of <code>fuel-rates.ts</code> gives different expected dollar amounts per customer.
      </p>
      <p className="text-sm">
        <b>Fuelable list</b>: RES (Residential), PFR/PFC (Surge Fee), ESD (Extended Area Delivery),
        LTG (Lithium Battery Ground), PIF (Prohibited Items). Per UPS&rsquo;s page: &ldquo;Fuel surcharges apply to
        Saturday Delivery, Extended/Remote Area, Residential, Large Package, Additional Handling,
        Over Maximum Limits, Peak Surcharges&rdquo; — we match those to UPS&rsquo;s 3-letter codes above.
      </p>
      <h3 className="text-sm font-semibold mt-3">Published rate tables (read from ups.com via PDF on 2026-05-03)</h3>
      <div className="grid grid-cols-2 gap-4 not-prose">
        <UpsFuelTable klass="GROUND" />
        <UpsFuelTable klass="AIR" />
      </div>
      <p className="text-sm mt-2">
        Pre-2026-02-09 rates are <span className="bg-amber-100 px-1 rounded text-amber-900">[derived]</span> placeholders
        — UPS&rsquo;s page only retains a rolling 90 days, so older invoices fall back to a back-fitted estimate.
        When you re-audit older shipments, expect some FSC slippage until those weeks are confirmed against
        archived UPS announcements.
      </p>

      <h2 className="mt-6 text-base font-semibold">6. Engineering notes &amp; assumptions</h2>

      <h3 className="mt-4 text-sm font-semibold">Multi-piece &amp; direction routing</h3>
      <p className="text-sm">
        UPS contracts carry several rate cards per service:
        <code>Standard Single</code> vs <code>Standard Multi</code> (single vs multi-piece pricing),
        <code>(Export)</code> vs <code>(Import)</code>. The engine ranks candidate sub-products by (a) direction
        match — origin country vs <code>Contract.billing_country</code> — and (b) <code>package_quantity &gt; 1</code> for Multi.
        Most-specific match wins.
      </p>

      <h3 className="mt-4 text-sm font-semibold">Per-customer fuel multipliers — derived from real billings</h3>
      <p className="text-sm">
        UPS contracts often state &ldquo;X% off fuel surcharge&rdquo; as a percentage discount.
        For everstox, the LLM extractor caught it directly (&ldquo;20% off across all services&rdquo; → multiplier <code>0.80</code>).
        For Quivo and Thomann, the discount wasn&rsquo;t in the LLM-extracted text, so we{" "}
        <span className="bg-amber-100 px-1 rounded text-amber-900">[derived]</span>{" "}
        the multiplier empirically: median(implied_rate / published_rate) across hundreds of FSC lines.
        Result: Quivo <code>0.25</code> (75% off, 1,848 samples), Thomann <code>0.10</code> (90% off, 18,851 samples).
        Run <code>scripts/derive_ups_fuel_rates.ts</code> any time to refresh the median against current data.
        Spot-check against the signed contract whenever possible — the multiplier carries 90% of the
        FSC audit accuracy, so getting it right matters.
      </p>

      <h3 className="mt-4 text-sm font-semibold">Cascade detection on FSC</h3>
      <p className="text-sm">
        Same idea as DHL&rsquo;s FF cascade: when the carrier-implied FSC rate matches{" "}
        <code>published × multiplier</code> within ±0.5pp <em>but</em> the upstream WC is wrong, the FSC row is
        marked <code>cascade</code> rather than over/under. Avoids screaming &ldquo;wrong fuel&rdquo; when the fuel was
        applied correctly to the wrong base.
      </p>

      <h3 className="mt-4 text-sm font-semibold">Lane-specific zone rates — known limitation (Thomann)</h3>
      <p className="text-sm">
        Some UPS rate sheets carry <em>multiple</em> &ldquo;Zone 3&rdquo; columns, one per destination lane (BE/NL,
        DK, FR, LU, AT, PL, CZ in Thomann&rsquo;s case). The deterministic XLSX parser currently keeps the
        FIRST &ldquo;Zone 3&rdquo; only and the audit picks that. Result: Thomann shipments to AT
        ({"-€7.59 expected vs €9.24 if read as BE/NL"}) audit as &ldquo;under&rdquo; even though
        UPS billed correctly. To fix, store zone+lane as a composite key and route by destination
        country at audit time.
      </p>

      <h3 className="mt-4 text-sm font-semibold">German decimal commas in XLSX</h3>
      <p className="text-sm">
        Thomann&rsquo;s rate cells are stored as STRINGS like <code>&quot;5,66&quot;</code> (not numbers). The naive parser
        stripped commas as thousand-separators, producing &euro;566 instead of &euro;5.66 — which made
        rate cards look insane. <code>asNumber</code> in <code>extract-rates-xlsx.ts</code> now distinguishes:
        comma after dot = US thousand sep; comma alone with 1–2 trailing digits = German decimal.
      </p>

      <h3 className="mt-4 text-sm font-semibold">Quivo contract bands — re-extracted manually</h3>
      <p className="text-sm">
        The first LLM extraction of Quivo&rsquo;s contract PDF returned <em>0 bands</em> for the &ldquo;Standard&rdquo;
        product (the one Quivo bills almost exclusively). <code>scripts/reextract_quivo_standard.ts</code>
        re-runs only that product with a sharpened prompt, gets ~180 bands (Einzelpaket /
        Mehrpaket Frei Haus / Mehrpaket Rechnung Dritte). Quivo has no XLSX so deterministic
        extraction isn&rsquo;t an option — the LLM is the only source.
      </p>

      <h3 className="mt-4 text-sm font-semibold">UPS doesn&rsquo;t need ZoneMaps for audit (but populates them anyway for visibility)</h3>
      <p className="text-sm">
        Unlike DHL, UPS invoices ship the zone for every shipment (CSV col 34). The audit just
        compares that zone to the contract&rsquo;s rate-card zones — no country&rarr;zone lookup needed at audit
        time. We <em>do</em> populate ZoneMap rows for UPS so the /zones page shows country lists, but the
        engine doesn&rsquo;t consult them.
      </p>

      <h3 className="mt-4 text-sm font-semibold">Account-number routing</h3>
      <p className="text-sm">
        Same as DHL: <code>Contract.account_numbers</code> holds a JSON list. UPS account numbers are
        alphanumeric (<code>0FV384</code>, <code>823289</code>, <code>H9R702</code>). The CSV pads to 10 chars
        with leading zeros; we strip those before matching.
      </p>

      <h3 className="mt-4 text-sm font-semibold">Service guide PDFs are too big for the LLM (Thomann)</h3>
      <p className="text-sm">
        Thomann&rsquo;s contract bundle includes a 27 MB UPS service-guide PDF that exceeds Anthropic&rsquo;s
        request size. <code>scripts/upload_ups_thomann.ts</code> sidesteps this by extracting only
        the small &ldquo;Accessorials&rdquo; sheet of the price-list XLSX for the LLM (surcharges) and using
        the deterministic XLSX parser for rate bands.
      </p>
    </>
  );
}

function UpsFuelTable({ klass }: { klass: UpsFuelClass }) {
  const rows = UPS_FUEL_RATES[klass];
  return (
    <div>
      <h4 className="font-medium text-xs">{klass} — {klass === "AIR" ? "Express + Expedited" : "Standard / Dom. Standard"}</h4>
      <table className="w-full text-xs border border-gray-200 mt-1">
        <thead className="bg-gray-50 text-left">
          <tr><th className="px-2 py-0.5">Effective</th><th className="px-2 py-0.5 text-right">Rate</th><th className="px-2 py-0.5">Source</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const derived = /derived|extrapolated|placeholder|sample/i.test(r.source);
            return (
              <tr key={r.effective_from} className="border-t">
                <td className="px-2 py-0.5 font-mono">{r.effective_from}</td>
                <td className="px-2 py-0.5 font-mono text-right">{(r.rate * 100).toFixed(2)}%</td>
                <td className="px-2 py-0.5 text-[10px]">
                  {derived
                    ? <span className="bg-amber-100 px-1 rounded text-amber-900">[derived] {r.source.slice(0, 40)}</span>
                    : <span className="text-gray-500">{r.source.slice(0, 40)}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

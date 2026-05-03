import { Nav } from "../components/Nav";
import { db } from "../lib/db";
import { FUEL_RATES, type FuelClass } from "../lib/fuel-rates";
import { SURCHARGES } from "../lib/surcharge-meta";
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

export default async function RulesPage({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  const { customer: customerParam } = await searchParams;
  const example = await loadWorkedExample();
  return (
    <>
      <Nav active="rules" customer={customerParam ?? null} />
      <main className="flex-1 overflow-auto p-6">
        <div className="max-w-4xl mx-auto prose prose-sm prose-slate">
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
        </div>
      </main>
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

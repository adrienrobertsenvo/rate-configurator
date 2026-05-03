"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { runSimulation, loadShipmentByNumber, type SimulateResponse } from "../actions/simulate";
import { SURCHARGES, SURCHARGE_BY_CODE, isFuelable } from "../lib/surcharge-meta";
import { FUEL_RATES, isoWeekFromDate, lookupFuelRate, fuelClassForProduct, type FuelClass } from "../lib/fuel-rates";

export type ContractInfo = {
  id: number;
  name: string;
  valid_from: string;
  valid_until: string;
  bands: number;
  available_codes: string[];
};

interface SimulationInputs {
  productCode: string;
  origin: string;
  destination: string;
  weight_kg: number;
  ship_date: string;
}

const PRODUCT_OPTIONS: { code: string; label: string }[] = [
  { code: "S", label: "S — Express Worldwide nondoc (intl, non-EU)" },
  { code: "U", label: "U — Express Worldwide nondoc (intl, EU)" },
  { code: "E", label: "E — Express Domestic" },
  { code: "T", label: "T — Express 12:00 doc" },
  { code: "Y", label: "Y — Express 12:00 nondoc" },
  { code: "V", label: "V — Economy Select (EU)" },
  { code: "N", label: "N — Economy Select (non-EU)" },
];

const OPTIONAL_CODES = SURCHARGES
  .filter((s) => s.code !== "FF" && s.kind !== "passthrough")
  .map((s) => ({ code: s.code, name: s.name, fuelable: s.fuelable }));

export function SimulatorForm({ contracts }: { contracts: ContractInfo[] }) {
  // Default to the first contract that actually has prices loaded.
  const defaultContract = contracts.find((c) => c.bands > 0) ?? contracts[0];
  const defaultContractId = defaultContract?.id ?? 0;
  const [contractId, setContractId] = useState<number>(defaultContractId);

  const selectedContract = contracts.find((c) => c.id === contractId);
  const visibleProducts = useMemo(
    () =>
      selectedContract?.available_codes.length
        ? PRODUCT_OPTIONS.filter((p) => selectedContract.available_codes.includes(p.code))
        : PRODUCT_OPTIONS,
    [selectedContract],
  );

  const [productCode, setProductCode] = useState(visibleProducts[0]?.code ?? "S");

  // Reset product when contract changes if current code isn't supported by new contract.
  useEffect(() => {
    if (!selectedContract) return;
    if (selectedContract.available_codes.length === 0) return; // nothing to filter against
    if (!selectedContract.available_codes.includes(productCode)) {
      setProductCode(selectedContract.available_codes[0]);
    }
  }, [contractId, selectedContract, productCode]);
  const [origin, setOrigin] = useState("DE");
  const [destination, setDestination] = useState("US");
  const [weight, setWeight] = useState("1.0");
  const [length, setLength] = useState("");
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [declaredValue, setDeclaredValue] = useState("");
  const [shipDate, setShipDate] = useState(new Date().toISOString().slice(0, 10));
  const [taxCode, setTaxCode] = useState("");
  const [shipmentNumber, setShipmentNumber] = useState("");
  const [findSimilar, setFindSimilar] = useState(false);
  const [optChecked, setOptChecked] = useState<Record<string, boolean>>({});
  const [optAmount, setOptAmount] = useState<Record<string, string>>({});
  const [response, setResponse] = useState<SimulateResponse | null>(null);
  const [lastSubmitted, setLastSubmitted] = useState<SimulationInputs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [loadingShipment, setLoadingShipment] = useState(false);
  const [loadHint, setLoadHint] = useState<string | null>(null);

  async function loadShipment() {
    if (!shipmentNumber.trim()) return;
    setLoadingShipment(true);
    setLoadHint(null);
    try {
      const loaded = await loadShipmentByNumber(shipmentNumber);
      if (!loaded) {
        setLoadHint(`No invoice line found for "${shipmentNumber.trim()}".`);
        return;
      }
      setContractId(loaded.contractId);
      setProductCode(loaded.productCode);
      setOrigin(loaded.origin);
      setDestination(loaded.destination);
      setWeight(String(loaded.weight_kg));
      if (loaded.ship_date) setShipDate(loaded.ship_date);
      if (loaded.tax_code) setTaxCode(loaded.tax_code);
      const next: Record<string, boolean> = {};
      for (const code of loaded.surcharge_codes) next[code] = true;
      setOptChecked(next);
      setLoadHint(`Loaded from ${loaded.invoice_number} · ${loaded.surcharge_codes.length} surcharge code(s) pre-selected.`);
    } catch (e) {
      setLoadHint(String((e as Error).message ?? e));
    } finally {
      setLoadingShipment(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const optional_surcharges = Object.entries(optChecked)
      .filter(([, on]) => on)
      .map(([code]) => {
        const raw = optAmount[code]?.trim();
        const amount = raw ? Number(raw.replace(",", ".")) : undefined;
        return { code, amount: Number.isFinite(amount as number) ? amount : undefined };
      });
    const inputs: SimulationInputs = {
      productCode,
      origin: origin.toUpperCase(),
      destination: destination.toUpperCase(),
      weight_kg: Number(weight.replace(",", ".")),
      ship_date: shipDate,
    };
    startTransition(async () => {
      try {
        const r = await runSimulation({
          contractId,
          ...inputs,
          length_cm: length ? Number(length.replace(",", ".")) : undefined,
          width_cm: width ? Number(width.replace(",", ".")) : undefined,
          height_cm: height ? Number(height.replace(",", ".")) : undefined,
          declared_value: declaredValue ? Number(declaredValue.replace(",", ".")) : undefined,
          optional_surcharges,
          tax_code: taxCode || undefined,
          compare_shipment_number: shipmentNumber.trim() || undefined,
          find_similar: findSimilar && !shipmentNumber.trim(),
        });
        setResponse(r);
        setLastSubmitted(inputs);
      } catch (e) {
        setError(String((e as Error).message ?? e));
        setResponse(null);
      }
    });
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <form onSubmit={submit} className="bg-white rounded border border-gray-200 p-4 space-y-3">
        <h2 className="font-medium">Inputs</h2>

        <Field label="Contract">
          <select className="w-full border rounded px-2 py-1 text-sm" value={contractId} onChange={(e) => setContractId(Number(e.target.value))}>
            {contracts.map((c) => {
              const validity = `${c.valid_from} → ${c.valid_until}`;
              const suffix = c.bands === 0 ? "  ⚠ no prices loaded" : `  · ${c.bands} bands`;
              return <option key={c.id} value={c.id}>{c.name}  ({validity}){suffix}</option>;
            })}
          </select>
          {contracts.find((c) => c.id === contractId)?.bands === 0 && (
            <div className="text-xs text-amber-700 mt-1">This contract has no rate bands loaded — pricing will fail. Pick a contract with prices, or upload its rate-card PDF on the Contracts page.</div>
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Product">
            <select className="w-full border rounded px-2 py-1 text-sm" value={productCode} onChange={(e) => setProductCode(e.target.value)}>
              {visibleProducts.length === 0 ? (
                <option value="">(no products available in this contract)</option>
              ) : (
                visibleProducts.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)
              )}
            </select>
          </Field>
          <Field label="Ship date">
            <input type="date" className="w-full border rounded px-2 py-1 text-sm" value={shipDate} onChange={(e) => setShipDate(e.target.value)} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Origin (ISO-2)">
            <input className="w-full border rounded px-2 py-1 text-sm uppercase" value={origin} maxLength={2} onChange={(e) => setOrigin(e.target.value.toUpperCase())} />
          </Field>
          <Field label="Destination (ISO-2)">
            <input className="w-full border rounded px-2 py-1 text-sm uppercase" value={destination} maxLength={2} onChange={(e) => setDestination(e.target.value.toUpperCase())} />
          </Field>
        </div>

        <Field label="Actual weight (kg)">
          <input className="w-full border rounded px-2 py-1 text-sm" value={weight} onChange={(e) => setWeight(e.target.value)} />
        </Field>

        <Field label="Dimensions (L × W × H, cm) — optional, used for volumetric weight">
          <div className="grid grid-cols-3 gap-2">
            <input placeholder="L" className="border rounded px-2 py-1 text-sm" value={length} onChange={(e) => setLength(e.target.value)} />
            <input placeholder="W" className="border rounded px-2 py-1 text-sm" value={width} onChange={(e) => setWidth(e.target.value)} />
            <input placeholder="H" className="border rounded px-2 py-1 text-sm" value={height} onChange={(e) => setHeight(e.target.value)} />
          </div>
        </Field>

        <Field label="Declared customs value (optional, used by II Shipment Insurance)">
          <input className="w-full border rounded px-2 py-1 text-sm" placeholder="0.00" value={declaredValue} onChange={(e) => setDeclaredValue(e.target.value)} />
        </Field>

        <Field label="Tax code (optional, otherwise inferred)">
          <input placeholder="A | B | C | X | Z" className="w-full border rounded px-2 py-1 text-sm uppercase" value={taxCode} onChange={(e) => setTaxCode(e.target.value.toUpperCase())} maxLength={1} />
        </Field>

        <details className="border-t pt-2">
          <summary className="text-sm font-medium cursor-pointer">Optional surcharges</summary>
          <div className="mt-2 space-y-1">
            {OPTIONAL_CODES.map((s) => (
              <div key={s.code} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={!!optChecked[s.code]} onChange={(e) => setOptChecked((p) => ({ ...p, [s.code]: e.target.checked }))} />
                <span className="font-mono text-xs w-7">{s.code}</span>
                <span className="flex-1">{s.name}{s.fuelable ? <span className="ml-1 text-amber-700 text-xs">⛽ fuelable</span> : null}</span>
                <input
                  placeholder="amt €"
                  className="w-20 border rounded px-1 py-0.5 text-xs"
                  value={optAmount[s.code] ?? ""}
                  onChange={(e) => setOptAmount((p) => ({ ...p, [s.code]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        </details>

        <Field label="Compare against invoice line (Shipment Number — optional)">
          <div className="flex gap-2">
            <input
              className="flex-1 border rounded px-2 py-1 text-sm"
              placeholder="e.g. 8307190334"
              value={shipmentNumber}
              onChange={(e) => setShipmentNumber(e.target.value)}
            />
            <button
              type="button"
              onClick={loadShipment}
              disabled={loadingShipment || !shipmentNumber.trim()}
              className="bg-gray-100 hover:bg-gray-200 disabled:bg-gray-50 disabled:text-gray-400 border border-gray-300 text-sm rounded px-3"
            >
              {loadingShipment ? "Loading…" : "Load"}
            </button>
          </div>
          {loadHint && <div className="text-xs text-gray-600 mt-1">{loadHint}</div>}
        </Field>

        <label className="flex items-center gap-2 text-sm border-t pt-3">
          <input type="checkbox" checked={findSimilar} onChange={(e) => setFindSimilar(e.target.checked)} disabled={!!shipmentNumber.trim()} />
          <span>
            On Simulate, search this contract&apos;s invoices for a similar shipment{" "}
            <span className="text-xs text-gray-500">(same product + dest, weight ±10%; off by default)</span>
          </span>
        </label>

        <button type="submit" disabled={pending} className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white text-sm rounded px-4 py-2">
          {pending ? "Calculating…" : "Simulate"}
        </button>
        {error && <div className="text-sm text-red-700">{error}</div>}
      </form>

      <div className="space-y-4">
        {response && <Breakdown response={response} simInputs={lastSubmitted} contracts={contracts} simContractId={contractId} />}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <div className="text-xs text-gray-600 mb-1">{label}</div>
      {children}
    </label>
  );
}

function Breakdown({ response, simInputs, contracts, simContractId }: { response: SimulateResponse; simInputs: SimulationInputs | null; contracts: ContractInfo[]; simContractId: number }) {
  const { result, compared } = response;
  const simContractName = contracts.find((c) => c.id === simContractId)?.name ?? null;
  return (
    <div className="bg-white rounded border border-gray-200 p-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-medium">Breakdown</h2>
        <div className="font-mono text-sm">
          <span className="text-gray-500 mr-2">total excl. VAT</span>
          <span className="font-semibold">€{result.total_excl_vat.toFixed(2)}</span>
          {result.tax_amount > 0 && (
            <span className="text-gray-500 ml-3">incl. VAT €{result.total_incl_vat.toFixed(2)}</span>
          )}
        </div>
      </div>
      <ol className="space-y-2 text-sm">
        {(() => {
          const lookup = result.steps.find((s): s is Extract<Step, { kind: "lookup" }> => s.kind === "lookup");
          const wc = result.steps.find((s): s is Extract<Step, { kind: "weight_charge" }> => s.kind === "weight_charge");
          const rendered: React.ReactNode[] = [];
          if (lookup && wc) {
            rendered.push(
              <li key="wc" className="text-sm flex items-baseline justify-between gap-2">
                <span>
                  <b>Weight charge</b>
                  <span className="text-gray-500 text-xs ml-2 font-mono">{lookup.sub_product} · {lookup.zone} · {describeBand(lookup.band)}</span>
                </span>
                <span className="font-mono">€{wc.amount.toFixed(2)}</span>
              </li>
            );
          }
          for (let i = 0; i < result.steps.length; i++) {
            const s = result.steps[i];
            if (s.kind === "lookup" || s.kind === "weight_charge") continue;
            rendered.push(<Step key={i} step={s} />);
          }
          return rendered;
        })()}
      </ol>
      {result.warnings.length > 0 && (
        <ul className="text-xs text-amber-800 list-disc pl-4">
          {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
      {compared && <Compare result={result} compared={compared} simInputs={simInputs} simContractName={simContractName} />}
    </div>
  );
}

type Step = SimulateResponse["result"]["steps"][number];
function Step({ step }: { step: Step }) {
  switch (step.kind) {
    case "weight": {
      const v = step.volumetric_kg;
      // If no dimensions given, the chargeable line is trivial — collapse to one line.
      if (v == null) return null;
      return (
        <li className="text-sm">
          <span className="text-gray-500">Chargeable weight: </span>
          actual <b>{step.actual_kg.toFixed(2)} kg</b> · volumetric <b>{v.toFixed(2)} kg</b> → <b>{step.chargeable_kg.toFixed(2)} kg</b> <span className="text-xs text-gray-500">(flag {step.flag})</span>
        </li>
      );
    }
    case "lookup":
      return null; // merged into the weight_charge row below
    case "weight_charge":
      return null; // rendered by Breakdown so it can pair with the preceding lookup step
    case "surcharge":
      return (
        <li className="text-sm flex items-baseline justify-between gap-2">
          <span>
            <b>{step.code}</b> {step.name}
            {step.fuelable ? <span className="ml-1 text-amber-700 text-xs">⛽</span> : null}
            <span className="text-gray-500 text-xs ml-2">{step.basis}</span>
          </span>
          <span className="font-mono">€{step.amount.toFixed(2)}</span>
        </li>
      );
    case "fuel_base":
      return null; // implicit in the fuel step's calc
    case "fuel":
      return (
        <li className="text-sm flex items-baseline justify-between gap-2 border-t pt-1">
          <span>
            <b>FF</b> Fuel surcharge ({step.klass})
            <span className="text-gray-500 text-xs ml-2 font-mono">€{step.base.toFixed(2)} × {(step.rate * 100).toFixed(2)}% · {step.iso_week}</span>
          </span>
          <span className="font-mono">€{step.amount.toFixed(2)}</span>
        </li>
      );
    case "subtotal":
      return (
        <li className="text-sm flex items-baseline justify-between gap-2 border-t pt-1 font-medium">
          <span>{step.label}</span>
          <span className="font-mono">€{step.amount.toFixed(2)}</span>
        </li>
      );
    case "tax":
      if (step.rate === 0) return null; // zero-rated → uninteresting
      return (
        <li className="text-sm flex items-baseline justify-between gap-2">
          <span>
            VAT <span className="text-gray-500 text-xs">code {step.code} · {(step.rate * 100).toFixed(0)}%</span>
          </span>
          <span className="font-mono">€{step.amount.toFixed(2)}</span>
        </li>
      );
    case "total":
      if (step.amount === 0) return null;
      return (
        <li className="text-sm flex items-baseline justify-between gap-2 border-t pt-1 font-semibold">
          <span>Total incl. VAT</span>
          <span className="font-mono">€{step.amount.toFixed(2)}</span>
        </li>
      );
    case "warning":
      return <li className="text-amber-800 text-xs">⚠ {step.message}</li>;
  }
}

function describeBand(b: SimulateResponse["result"]["steps"][number] extends { band: infer B } ? B : never): string {
  if (!b) return "";
  const start = `${(b.weight_start / 1000).toFixed(2)} kg`;
  if (b.price != null && b.weight_end != null) return `${start} – ${(b.weight_end / 1000).toFixed(2)} kg flat`;
  if (b.per_kg != null) return `≥ ${start} · €${b.per_kg.toFixed(2)}/kg${b.step ? ` step ${b.step}kg` : ""}${b.chargeable_kg != null ? ` (chargeable ${b.chargeable_kg.toFixed(2)} kg)` : ""}`;
  return "";
}

function Compare({ result, compared, simInputs }: { result: SimulateResponse["result"]; compared: NonNullable<SimulateResponse["compared"]>; simInputs: SimulationInputs | null; simContractName?: string | null }) {
  // Direct comparison: simulator output vs the matched invoice line's actuals.
  // Non-fuel items are time-stable within a contract, so any delta there is a
  // true audit signal. Fuel rates change weekly, so a delta is only meaningful
  // when the simulator's week and the matched line's week are the same.

  const simFuelStep = result.steps.find((s): s is Extract<Step, { kind: "fuel" }> => s.kind === "fuel");
  const simSurchargeSteps = result.steps.filter((s): s is Extract<Step, { kind: "surcharge" }> => s.kind === "surcharge");
  const simByCode = new Map(simSurchargeSteps.map((s) => [s.code, s]));

  const actByCode = new Map(compared.surcharges.filter((s) => s.code !== "FF").map((s) => [s.code, s]));
  const actFf = compared.surcharges.find((s) => s.code === "FF")?.charge ?? 0;
  const actFuelable = compared.surcharges.filter((s) => isFuelable(s.code)).reduce((a, s) => a + s.charge, 0);
  const actFuelBase = (compared.weight_charge ?? 0) + actFuelable;
  const actImpliedRate = actFf > 0 && actFuelBase > 0 ? actFf / actFuelBase : null;
  const actIsoWeek = compared.matched_on?.ship_date ? isoWeekFromDate(compared.matched_on.ship_date) : null;

  const codes = Array.from(new Set([...simByCode.keys(), ...actByCode.keys()])).sort();
  const codeRows = codes.map((code) => {
    const sim = simByCode.get(code);
    const act = actByCode.get(code);
    const name = sim?.name ?? act?.name ?? SURCHARGE_BY_CODE.get(code)?.name ?? code;
    const fuelable = SURCHARGE_BY_CODE.get(code)?.fuelable ?? false;
    return { code, name, fuelable, sim: sim?.amount ?? 0, act: act?.charge ?? 0 };
  });

  const sameWeek = simFuelStep?.iso_week != null && actIsoWeek != null && simFuelStep.iso_week === actIsoWeek;

  return (
    <div className="border-t pt-3">
      <h3 className="text-sm font-medium mb-2">
        Compared with invoice line
        {compared.match_kind === "similar" && <MatchBadge tier={compared.match_tier ?? "exact"} />}
      </h3>
      <div className="text-xs text-gray-600 mb-1">
        {compared.invoice_number} · shipment {compared.shipment_number}
      </div>
      {compared.matched_on && simInputs && <MatchAttributes sim={simInputs} match={compared.matched_on} />}
      {compared.match_notes && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-2">{compared.match_notes}</div>
      )}

      <table className="w-full text-sm mt-2">
        <thead className="text-xs text-gray-500">
          <tr>
            <th className="text-left pb-1">Item</th>
            <th className="text-right pb-1">Simulated</th>
            <th className="text-right pb-1">Invoiced</th>
            <th className="text-right pb-1">Δ</th>
          </tr>
        </thead>
        <tbody>
          <Row label="Weight charge" sim={result.weight_charge} act={compared.weight_charge ?? 0} />
          {codeRows.map((r) => (
            <Row
              key={r.code}
              label={`${r.code} ${r.name}`}
              labelSuffix={r.fuelable ? <span className="ml-1 text-amber-700 text-xs">⛽</span> : null}
              sim={r.sim}
              act={r.act}
            />
          ))}
          <FuelRow
            simAmount={result.fuel_amount}
            simRate={simFuelStep?.rate ?? null}
            simWeek={simFuelStep?.iso_week ?? null}
            actAmount={actFf}
            actRate={actImpliedRate}
            actWeek={actIsoWeek}
            sameWeek={sameWeek}
          />
          <Row
            label="Total excl. VAT"
            sim={result.total_excl_vat}
            act={compared.charged_amount ?? 0}
            bold
            suppressDelta={!sameWeek}
            deltaNote={!sameWeek ? "fuel weeks differ" : undefined}
          />
        </tbody>
      </table>

      <FuelRateContext
        simWeek={simFuelStep?.iso_week ?? null}
        actWeek={actIsoWeek}
        simKlass={simFuelStep?.klass ?? null}
      />
    </div>
  );
}

function FuelRow({
  simAmount, simRate, simWeek, actAmount, actRate, actWeek, sameWeek,
}: {
  simAmount: number; simRate: number | null; simWeek: string | null;
  actAmount: number; actRate: number | null; actWeek: string | null;
  sameWeek: boolean;
}) {
  return (
    <tr className="border-t border-gray-100">
      <td className="text-left py-1"><b>FF</b> Fuel surcharge</td>
      <td className="text-right py-1 font-mono">
        €{simAmount.toFixed(2)}
        {simRate != null && <div className="text-xs text-gray-500">{(simRate * 100).toFixed(2)}% · {simWeek}</div>}
      </td>
      <td className="text-right py-1 font-mono">
        €{actAmount.toFixed(2)}
        {actRate != null && <div className="text-xs text-gray-500">{(actRate * 100).toFixed(2)}% · {actWeek}</div>}
      </td>
      <td className="text-right py-1 font-mono">
        {sameWeek ? deltaCell(simAmount - actAmount) : <span className="text-gray-400 text-xs">weeks differ</span>}
      </td>
    </tr>
  );
}

function AuditHeadline({
  expFf, actFf, expRate, actRate, actIsoWeek, expectedTotal, actualTotal,
}: {
  expFf: { expected: number; actual: number; delta: number; status: string } | undefined;
  actFf: number;
  expRate: number | null;
  actRate: number | null;
  actIsoWeek: string | null;
  expectedTotal: number | null;
  actualTotal: number | null;
}) {
  if (expRate == null || actRate == null) return null;

  const totalDelta = expectedTotal != null && actualTotal != null ? expectedTotal - actualTotal : 0;
  const ratePp = (expRate - actRate) * 100;

  // Only show the headline when there's a real gap on either rate or total.
  // Rate gap > 0.5pp OR total euro gap > €0.50.
  const significant = Math.abs(ratePp) > 0.5 || Math.abs(totalDelta) > 0.5;
  if (!significant) return null;

  const overbilled = totalDelta < 0; // actual > expected = carrier overcharged
  const cls = overbilled ? "bg-rose-50 border-rose-200" : "bg-emerald-50 border-emerald-200";
  const headline = overbilled ? "Carrier OVER-billed this shipment" : "Carrier UNDER-billed this shipment";

  return (
    <div className={`text-sm border rounded p-2 mb-2 ${cls}`}>
      <span className="font-medium">{headline}</span>
      <span className="ml-2 text-xs font-mono text-gray-700">
        rate gap {ratePp > 0 ? "+" : ""}{ratePp.toFixed(2)}pp · total {deltaCell(totalDelta)}
      </span>
    </div>
  );
}

function Row({
  label,
  labelSuffix,
  sim,
  act,
  bold,
  suppressDelta,
  deltaNote,
}: {
  label: string;
  labelSuffix?: React.ReactNode;
  sim: number;
  act: number;
  bold?: boolean;
  suppressDelta?: boolean;
  deltaNote?: string;
}) {
  const cls = bold ? "border-t font-semibold" : "border-t border-gray-100";
  return (
    <tr className={cls}>
      <td className="text-left py-1">
        {label}
        {labelSuffix}
      </td>
      <td className="text-right py-1 font-mono">€{sim.toFixed(2)}</td>
      <td className="text-right py-1 font-mono">€{act.toFixed(2)}</td>
      <td className="text-right py-1 font-mono">
        {suppressDelta ? <span className="text-gray-400 text-xs">{deltaNote ?? "—"}</span> : deltaCell(sim - act)}
      </td>
    </tr>
  );
}

function deltaCell(n: number): React.ReactNode {
  if (Math.abs(n) < 0.005) return <span className="text-gray-400">€0.00</span>;
  // sim > actual (positive) → carrier under-billed (good for customer) → emerald
  // sim < actual (negative) → carrier over-billed (bad)               → rose
  const cls = n > 0 ? "text-emerald-700" : "text-rose-700";
  const sign = n > 0 ? "+" : "−";
  return <span className={cls}>{sign}€{Math.abs(n).toFixed(2)}</span>;
}

type MatchTier = NonNullable<NonNullable<SimulateResponse["compared"]>["match_tier"]>;

const MATCH_BADGE_STYLE: Record<MatchTier, { label: string; cls: string }> = {
  "exact":         { label: "exact match",          cls: "text-emerald-700 bg-emerald-50 border-emerald-200" },
  "family-tight":  { label: "~ family match",       cls: "text-amber-700 bg-amber-50 border-amber-200" },
  "family-loose":  { label: "~ loose weight match", cls: "text-amber-700 bg-amber-50 border-amber-200" },
};

function MatchAttributes({
  sim,
  match,
}: {
  sim: SimulationInputs;
  match: NonNullable<NonNullable<SimulateResponse["compared"]>["matched_on"]>;
}) {
  const simWeek = sim.ship_date ? isoWeekFromDate(sim.ship_date) : null;
  const matchWeek = match.ship_date ? isoWeekFromDate(match.ship_date) : null;
  const productSame = sim.productCode === match.product_code;
  const destSame = sim.destination === match.dest_country;
  const weightSame = Math.abs(sim.weight_kg - match.weight_kg) < 0.01;
  const dateSame = simWeek != null && matchWeek != null && simWeek === matchWeek;
  const klass = fuelClassForProduct(sim.productCode);
  const simRate = klass && sim.ship_date ? lookupFuelRate(klass, sim.ship_date)?.rate : null;
  const matchRate = klass && match.ship_date ? lookupFuelRate(klass, match.ship_date)?.rate : null;

  return (
    <div className="text-xs mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      <Attr label="Product" same={productSame} simVal={sim.productCode} matchVal={match.product_code} />
      <Attr label="Destination" same={destSame} simVal={sim.destination} matchVal={match.dest_country} />
      <Attr label="Weight" same={weightSame} simVal={`${sim.weight_kg.toFixed(2)} kg`} matchVal={`${match.weight_kg.toFixed(2)} kg`} />
      <span className="text-gray-500 self-start">Ship date</span>
      <span>
        {dateSame ? <span className="text-emerald-700 mr-1">✓</span> : <span className="text-amber-700 mr-1">⚠</span>}
        <span className="font-mono">
          Simulated <b>{simWeek ?? "?"}</b> ({sim.ship_date}){simRate != null ? <> · fuel <b>{(simRate * 100).toFixed(2)}%</b></> : null}
        </span>
        {!dateSame && (
          <>
            <br />
            <span className="ml-4 font-mono">
              Invoiced <b>{matchWeek ?? "?"}</b> ({match.ship_date ?? "?"}){matchRate != null ? <> · fuel <b>{(matchRate * 100).toFixed(2)}%</b></> : null}
            </span>
          </>
        )}
      </span>
    </div>
  );
}

function Attr({ label, same, simVal, matchVal }: { label: string; same: boolean; simVal: string; matchVal: string }) {
  return (
    <>
      <span className="text-gray-500">{label}</span>
      {same ? (
        <span><span className="text-emerald-700 mr-1">✓</span><span className="font-mono">{matchVal}</span></span>
      ) : (
        <span>
          <span className="text-amber-700 mr-1">⚠</span>
          <span className="font-mono">Simulated <b>{simVal}</b> · Invoiced <b>{matchVal}</b></span>
        </span>
      )}
    </>
  );
}

function MatchBadge({ tier }: { tier: MatchTier }) {
  const m = MATCH_BADGE_STYLE[tier];
  return <span className={`ml-2 text-xs border px-1.5 py-0.5 rounded ${m.cls}`}>{m.label}</span>;
}

function FuelRateContext({
  simWeek,
  actWeek,
  simKlass,
}: {
  simWeek: string | null;
  actWeek: string | null;
  simKlass: "AIR" | "ROAD" | null;
}) {
  // Show all aggregated DHL fuel rates (AIR + ROAD) with the simulated and actual weeks highlighted.
  // Compact two-column table; user can confirm which weekly rate fed each price.
  const allWeeks = Array.from(new Set([
    ...FUEL_RATES.AIR.map((r) => r.iso_week),
    ...FUEL_RATES.ROAD.map((r) => r.iso_week),
  ])).sort();
  const airBy = new Map(FUEL_RATES.AIR.map((r) => [r.iso_week, r.rate]));
  const roadBy = new Map(FUEL_RATES.ROAD.map((r) => [r.iso_week, r.rate]));

  return (
    <div className="mt-4 border-t pt-3">
      <div className="flex items-baseline justify-between mb-2">
        <h4 className="text-sm font-medium">DHL fuel surcharge by week</h4>
        <div className="text-xs text-gray-500">
          {simKlass ? <>Simulated uses <b>{simKlass}</b>.</> : null}
          <span className="ml-2"><span className="inline-block w-3 h-3 align-middle bg-blue-100 border border-blue-300 mr-1" />simulated</span>
          <span className="ml-2"><span className="inline-block w-3 h-3 align-middle bg-amber-100 border border-amber-300 mr-1" />invoiced</span>
        </div>
      </div>
      <div className="max-h-48 overflow-auto border border-gray-200 rounded">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 text-gray-600 sticky top-0">
            <tr><th className="text-left px-2 py-1">Week</th><th className="text-right px-2 py-1">AIR (S/U/T/Y)</th><th className="text-right px-2 py-1">ROAD (E/V/N)</th></tr>
          </thead>
          <tbody className="font-mono">
            {allWeeks.map((w) => {
              const isSim = w === simWeek;
              const isAct = w === actWeek;
              const rowCls = isSim && isAct
                ? "bg-purple-50"
                : isSim
                ? "bg-blue-50"
                : isAct
                ? "bg-amber-50"
                : "";
              const air = airBy.get(w);
              const road = roadBy.get(w);
              return (
                <tr key={w} className={`${rowCls} border-t border-gray-100`}>
                  <td className="px-2 py-0.5">{w}</td>
                  <td className="px-2 py-0.5 text-right">{air != null ? `${(air * 100).toFixed(2)}%` : "—"}</td>
                  <td className="px-2 py-0.5 text-right">{road != null ? `${(road * 100).toFixed(2)}%` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="text-xs text-gray-500 mt-1">Source: dhl.de fuel-surcharge pages, validated against ~7k invoice lines.</div>
    </div>
  );
}

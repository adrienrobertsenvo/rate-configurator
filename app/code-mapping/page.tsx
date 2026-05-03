import Link from "next/link";
import { db } from "../lib/db";
import { Nav } from "../components/Nav";
import { CodeMappingTable } from "./CodeMappingTable";
import { resolveCustomer, contractCustomerWhere } from "../lib/customer-context";

export const dynamic = "force-dynamic";

interface UnresolvedRow {
  contractId: number;
  contractName: string;
  carrier: string;
  code: string;
  invoiceName: string;
  count: number;
  total: number;
}

interface ContractRule {
  id: number;
  code: string;
  name: string;
  kind: string;
  amount: number | null;
  min_amount: number | null;
  applies_to: string;
}

interface CatalogRow {
  code: string;
  name: string;
}

export default async function CodeMappingPage({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  const { customer: customerParam } = await searchParams;
  const customer = await resolveCustomer(customerParam);
  // 1. Pull every audited surcharge entry with status=unresolved, broken down by
  //    (contract, code). For each, count lines and sum the actual charges.
  const lines = await db.invoiceLine.findMany({
    where: {
      expected_surcharges_json: { not: null },
      ...(customer ? { invoice: { is: { contract: { is: contractCustomerWhere(customer.id) } } } } : {}),
    },
    select: {
      expected_surcharges_json: true,
      invoice: {
        select: { contractId: true, contract: { select: { id: true, name: true, carrier: true } } },
      },
    },
  });

  type Row = { contractId: number; contractName: string; carrier: string; code: string; invoiceName: string; count: number; total: number };
  const unresolved = new Map<string, Row>();
  for (const l of lines) {
    if (!l.invoice?.contract) continue;
    const json = l.expected_surcharges_json;
    if (!json) continue;
    let arr: { code: string; name: string; status: string; actual: number }[];
    try { arr = JSON.parse(json); } catch { continue; }
    for (const s of arr) {
      if (s.status !== "unresolved") continue;
      const key = `${l.invoice.contract.id}|${s.code}`;
      const cur = unresolved.get(key);
      if (cur) {
        cur.count += 1;
        cur.total += Number(s.actual) || 0;
      } else {
        unresolved.set(key, {
          contractId: l.invoice.contract.id,
          contractName: l.invoice.contract.name,
          carrier: l.invoice.contract.carrier,
          code: s.code,
          invoiceName: s.name,
          count: 1,
          total: Number(s.actual) || 0,
        });
      }
    }
  }
  const rows: UnresolvedRow[] = Array.from(unresolved.values()).sort((a, b) => b.total - a.total);

  // 2. Pull each affected contract's rules so the UI can offer them as "apply this code to" candidates.
  const contractIds = Array.from(new Set(rows.map((r) => r.contractId)));
  const ruleRows = contractIds.length
    ? await db.surcharge.findMany({
        where: { contractId: { in: contractIds } },
        orderBy: [{ contractId: "asc" }, { name: "asc" }],
      })
    : [];
  const rulesByContract = new Map<number, ContractRule[]>();
  for (const r of ruleRows) {
    if (!rulesByContract.has(r.contractId)) rulesByContract.set(r.contractId, []);
    rulesByContract.get(r.contractId)!.push({
      id: r.id, code: r.code, name: r.name, kind: r.kind,
      amount: r.amount, min_amount: r.min_amount, applies_to: r.applies_to,
    });
  }

  // 3. Catalog (canonical name per invoice code) for "what this code usually means" hint.
  const carriers = Array.from(new Set(rows.map((r) => r.carrier)));
  const catalogRows = carriers.length
    ? await db.catalogSurcharge.findMany({ where: { carrier: { in: carriers } } })
    : [];
  const catalog: Record<string, Map<string, CatalogRow>> = {};
  for (const c of catalogRows) {
    if (!catalog[c.carrier]) catalog[c.carrier] = new Map();
    catalog[c.carrier].set(c.code, { code: c.code, name: c.name });
  }

  return (
    <>
      <Nav active="code-mapping" customer={customer?.code ?? null} />
      <main className="flex-1 overflow-auto p-6">
        <div className="max-w-6xl mx-auto space-y-3">
          <h1 className="text-lg font-semibold">Invoice code mapping</h1>
          <p className="text-sm text-gray-600">
            DHL invoice billing codes that audited as <em>unresolved</em> — i.e. the contract has no rule with that code.
            For each, pick a contract rule to re-tag with this code, or create a new rule. The audit re-runs on the next pass.
          </p>
          {rows.length === 0 ? (
            <div className="bg-emerald-50 border border-emerald-200 rounded p-3 text-sm">
              No unresolved invoice codes — every charge on every loaded invoice maps to a contract rule.
            </div>
          ) : (
            <CodeMappingTable
              rows={rows}
              rulesByContract={Object.fromEntries(rulesByContract)}
              catalog={Object.fromEntries(
                Object.entries(catalog).map(([carrier, m]) => [carrier, Object.fromEntries(m)]),
              )}
            />
          )}
          <div className="text-xs text-gray-500">
            <Link href="/invoices" className="text-blue-600 hover:underline">Invoices</Link> ·{" "}
            <Link href="/" className="text-blue-600 hover:underline">Contracts</Link>
          </div>
        </div>
      </main>
    </>
  );
}

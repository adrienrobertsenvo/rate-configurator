import Link from "next/link";
import { db } from "./lib/db";
import { ensureSeed } from "./lib/seed";
import { Nav } from "./components/Nav";
import { UploadContract } from "./components/UploadContract";
import { MergeCandidates } from "./components/MergeCandidates";
import { resolveCustomer, contractCustomerWhere } from "./lib/customer-context";
import { resolveCarrier, contractCarrierWhere } from "./lib/carrier-context";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ customer?: string; carrier?: string }> }) {
  await ensureSeed();
  const { customer: customerParam, carrier: carrierParam } = await searchParams;
  const customer = await resolveCustomer(customerParam);
  const carrier = resolveCarrier(carrierParam);
  const contracts = await db.contract.findMany({
    where: { AND: [contractCustomerWhere(customer?.id ?? null), contractCarrierWhere(carrier)] },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      carrier: true,
      billing_country: true,
      valid_from: true,
      valid_until: true,
      updatedAt: true,
      _count: { select: { freight: true, addons: true, invoices: true } },
    },
  });

  return (
    <>
      <Nav active="contracts" customer={customer?.code ?? null} carrier={carrier} />
      <main className="flex-1 overflow-auto p-6">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-lg font-semibold">Contracts</h1>
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500">
                {contracts.length} contract{contracts.length === 1 ? "" : "s"}
              </span>
              <UploadContract />
            </div>
          </div>
          <MergeCandidates contracts={contracts.map((c) => ({
            id: c.id, name: c.name, carrier: c.carrier, billing_country: c.billing_country,
            valid_from: c.valid_from, valid_until: c.valid_until,
            products: c._count.freight,
          }))} />

          <div className="bg-white rounded border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left border-b">Name</th>
                  <th className="px-3 py-2 text-left border-b">Carrier</th>
                  <th className="px-3 py-2 text-left border-b">Billing</th>
                  <th className="px-3 py-2 text-left border-b">Valid</th>
                  <th className="px-3 py-2 text-right border-b">Products</th>
                  <th className="px-3 py-2 text-right border-b">Addons</th>
                  <th className="px-3 py-2 text-right border-b">Invoices</th>
                </tr>
              </thead>
              <tbody>
                {contracts.map((c) => (
                  <tr key={c.id} className="even:bg-gray-50 hover:bg-blue-50">
                    <td className="px-3 py-2 border-b">
                      <Link href={`/contracts/${c.id}`} className="text-blue-600 hover:underline">
                        {c.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 border-b font-mono text-xs">{c.carrier}</td>
                    <td className="px-3 py-2 border-b font-mono text-xs">{c.billing_country}</td>
                    <td className="px-3 py-2 border-b text-xs">
                      {c.valid_from} → {c.valid_until}
                    </td>
                    <td className="px-3 py-2 border-b text-right">{c._count.freight}</td>
                    <td className="px-3 py-2 border-b text-right">{c._count.addons}</td>
                    <td className="px-3 py-2 border-b text-right">{c._count.invoices}</td>
                  </tr>
                ))}
                {contracts.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-gray-500">
                      No contracts yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-500 mt-4">
            Upload a carrier contract PDF and Claude will extract products, weight bands, and prices with per-cell confidence scores.
            Low-confidence cells are highlighted in the contract editor for verification.
          </p>
        </div>
      </main>
    </>
  );
}

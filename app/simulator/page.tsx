import { db } from "../lib/db";
import { Nav } from "../components/Nav";
import { SimulatorForm } from "./SimulatorForm";
import { resolveCustomer, contractCustomerWhere } from "../lib/customer-context";
import { resolveCarrier, contractCarrierWhere } from "../lib/carrier-context";

export const dynamic = "force-dynamic";

export default async function SimulatorPage({ searchParams }: { searchParams: Promise<{ customer?: string; carrier?: string }> }) {
  const { customer: customerParam, carrier: carrierParam } = await searchParams;
  const customer = await resolveCustomer(customerParam);
  const carrier = resolveCarrier(carrierParam);
  const [contracts, catalog] = await Promise.all([
    db.contract.findMany({
      where: { AND: [contractCustomerWhere(customer?.id ?? null), contractCarrierWhere(carrier)] },
      orderBy: { id: "asc" },
      include: {
        freight: {
          include: { sub_products: { select: { name: true, _count: { select: { bands: true } } } } },
        },
      },
    }),
    db.catalogProduct.findMany(),
  ]);

  const contractInfo = contracts.map((c) => {
    let bands = 0;
    const filledSubs = new Set<string>(); // "{product_name}|{sub_product_name}" with at least one band
    for (const fp of c.freight) {
      for (const sp of fp.sub_products) {
        bands += sp._count.bands;
        if (sp._count.bands > 0) filledSubs.add(`${fp.name}|${sp.name}`);
      }
    }
    const codes = new Set<string>();
    for (const e of catalog) {
      if (e.carrier !== c.carrier) continue;
      if (filledSubs.has(`${e.product_name}|${e.sub_product_name}`)) codes.add(e.code);
    }
    return {
      id: c.id,
      name: c.name,
      valid_from: c.valid_from,
      valid_until: c.valid_until,
      bands,
      available_codes: Array.from(codes).sort(),
    };
  });

  return (
    <>
      <Nav active="simulator" customer={customer?.code ?? null} carrier={carrier} />
      <main className="flex-1 overflow-auto p-6">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-lg font-semibold mb-1">Shipment Price Simulator</h1>
          <p className="text-sm text-gray-600 mb-4">
            Enter a shipment, see the priced breakdown step-by-step. Optionally compare against a real invoice line by
            shipment number.
          </p>
          <SimulatorForm contracts={contractInfo} />
        </div>
      </main>
    </>
  );
}

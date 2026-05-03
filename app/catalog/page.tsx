import { db } from "../lib/db";
import { ensureSeed } from "../lib/seed";
import { CatalogEditor } from "../components/CatalogEditor";
import { Nav } from "../components/Nav";

export const dynamic = "force-dynamic";

export default async function CatalogPage({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  await ensureSeed();
  const { customer: customerParam } = await searchParams;
  const contract = await db.contract.findFirst({
    orderBy: { id: "asc" },
    include: { freight: { include: { sub_products: true } } },
  });
  const carrier = contract?.carrier ?? "DHL-EXPRESS-DE";
  const [products, surcharges, taxRates] = await Promise.all([
    db.catalogProduct.findMany({ where: { carrier }, orderBy: [{ code: "asc" }, { direction: "asc" }] }),
    db.catalogSurcharge.findMany({ where: { carrier }, orderBy: { code: "asc" } }),
    db.taxRate.findMany({ where: { carrier }, orderBy: { code: "asc" } }),
  ]);

  const productOptions = (contract?.freight ?? []).map((p) => ({
    name: p.name,
    subs: p.sub_products.map((sp) => sp.name),
  }));

  return (
    <>
      <Nav active="catalog" customer={customerParam ?? null} />
      <main className="flex-1 overflow-auto">
        <CatalogEditor
          carrier={carrier}
          products={products.map((p) => ({
            code: p.code,
            product_name: p.product_name,
            sub_product_name: p.sub_product_name,
            direction: p.direction,
          }))}
          surcharges={surcharges.map((s) => ({ code: s.code, name: s.name, kind: s.kind }))}
          taxRates={taxRates.map((t) => ({ code: t.code, rate: t.rate, description: t.description }))}
          productOptions={productOptions}
        />
      </main>
    </>
  );
}

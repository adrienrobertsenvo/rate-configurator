import Link from "next/link";
import { db } from "../lib/db";
import { contractToDto } from "../lib/dto";
import { contractToYaml, zoneMapToYaml, catalogToYaml } from "../lib/yaml";
import { ExportPanel } from "../components/ExportPanel";
import { Nav } from "../components/Nav";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ contract?: string; customer?: string; carrier?: string }>;
}

export default async function ExportPage({ searchParams }: Props) {
  const { contract: contractParam, customer: customerParam, carrier: carrierParam } = await searchParams;
  const carrierForNav: "all" | "dhl" | "ups" = carrierParam === "dhl" || carrierParam === "ups" ? carrierParam : "all";
  const contractId = contractParam ? Number(contractParam) : null;

  const carrierWhere = carrierForNav === "all" ? {} : {
    OR: [
      { carrier: { startsWith: carrierForNav === "dhl" ? "DHL-EXPRESS" : "UPS-" } },
      { carrier: carrierForNav === "dhl" ? "dhl-express" : "ups" },
    ],
  };
  const contracts = await db.contract.findMany({ where: carrierWhere, orderBy: { id: "asc" }, select: { id: true, name: true } });
  const selected =
    contractId != null
      ? await db.contract.findUnique({
          where: { id: contractId },
          include: { freight: { include: { sub_products: { include: { bands: true } } } }, addons: true },
        })
      : contracts[0]
        ? await db.contract.findUnique({
            where: { id: contracts[0].id },
            include: { freight: { include: { sub_products: { include: { bands: true } } } }, addons: true },
          })
        : null;

  if (!selected) {
    return (
      <>
        <Nav active="export" customer={customerParam ?? null} carrier={carrierForNav} />
        <main className="p-6">No contracts available.</main>
      </>
    );
  }

  const dto = contractToDto(selected);
  const zoneMaps = await db.zoneMap.findMany({
    where: {
      carrier: dto.carrier,
      billing_country: dto.billing_country,
      OR: [{ contractId: null }, { contractId: selected.id }],
    },
    include: { countries: true },
    orderBy: [{ zone_group: "asc" }, { contractId: "asc" }],
  });
  const products = await db.catalogProduct.findMany({ where: { carrier: dto.carrier } });
  const surcharges = await db.catalogSurcharge.findMany({ where: { carrier: dto.carrier } });

  const ratesYaml = contractToYaml(dto);
  const zonesYaml =
    zoneMaps.length === 0
      ? "# no zone maps\n"
      : zoneMaps
          .map((zm) =>
            zoneMapToYaml({
              carrier: zm.carrier,
              valid_from: zm.valid_from,
              spec_name: zm.spec_name,
              currency_code: zm.currency_code,
              billing_country: zm.billing_country,
              zone_group: zm.zone_group,
              countries: zm.countries.map((c) => ({ country: c.country, zone: c.zone })),
            }),
          )
          .join("\n---\n");
  const catalogYaml = catalogToYaml({
    carrier: dto.carrier,
    products: products.map((p) => ({ code: p.code, product_name: p.product_name, sub_product_name: p.sub_product_name })),
    surcharges: surcharges.map((s) => ({ code: s.code, name: s.name, kind: s.kind })),
  });

  const baseName = `${dto.carrier.toLowerCase()}-${dto.valid_from.slice(0, 4)}`;

  return (
    <>
      <Nav active="export" customer={customerParam ?? null} carrier={carrierForNav} />
      <div className="px-4 py-2 bg-white border-b border-gray-200 flex items-center gap-3">
        <span className="text-xs uppercase text-gray-500">Contract:</span>
        <div className="flex gap-2">
          {contracts.map((c) => (
            <Link
              key={c.id}
              href={`/export?contract=${c.id}`}
              className={`text-xs px-2 py-1 rounded ${c.id === selected.id ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}
            >
              {c.name}
            </Link>
          ))}
        </div>
      </div>
      <main className="flex-1 overflow-hidden">
        <ExportPanel baseName={baseName} ratesYaml={ratesYaml} zonesYaml={zonesYaml} catalogYaml={catalogYaml} />
      </main>
    </>
  );
}

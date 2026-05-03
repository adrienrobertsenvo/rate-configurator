import Link from "next/link";
import { db } from "../lib/db";
import { ensureSeed } from "../lib/seed";
import { ZoneEditor } from "../components/ZoneEditor";
import { Nav } from "../components/Nav";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ id?: string; group?: string; contract?: string; customer?: string }>;
}

export default async function ZonesPage({ searchParams }: Props) {
  await ensureSeed();
  const { id: idParam, group: groupParam, contract: contractParam, customer: customerParam } = await searchParams;

  const allMaps = await db.zoneMap.findMany({
    include: { countries: true, contract: { select: { id: true, name: true } } },
    orderBy: [{ carrier: "asc" }, { billing_country: "asc" }, { zone_group: "asc" }, { contractId: "asc" }],
  });

  const idNum = idParam ? Number(idParam) : null;
  const contractNum = contractParam ? Number(contractParam) : null;
  let selected =
    (idNum != null ? allMaps.find((m) => m.id === idNum) : null) ??
    (groupParam
      ? allMaps.find(
          (m) =>
            m.zone_group === groupParam &&
            (contractNum != null ? m.contractId === contractNum : m.contractId === null),
        )
      : null) ??
    allMaps[0] ??
    null;

  if (!selected) {
    selected = await db.zoneMap.create({
      data: {
        carrier: "DHL-EXPRESS-DE",
        billing_country: "DE",
        zone_group: "worldwide",
        spec_name: "DHL Express Worldwide (DE baseline)",
        valid_from: new Date().toISOString().slice(0, 10),
        currency_code: "EUR",
      },
      include: { countries: true, contract: { select: { id: true, name: true } } },
    });
    allMaps.unshift(selected);
  }

  const dto = {
    id: selected.id,
    carrier: selected.carrier,
    billing_country: selected.billing_country,
    zone_group: selected.zone_group,
    spec_name: selected.spec_name,
    valid_from: selected.valid_from,
    currency_code: selected.currency_code,
    contractId: selected.contractId,
    contractName: selected.contract?.name ?? null,
    countries: selected.countries.map((c) => ({ country: c.country, zone: c.zone })),
  };

  return (
    <>
      <Nav active="zones" customer={customerParam ?? null} />
      <main className="flex-1 overflow-auto">
        <div className="flex">
          <aside className="w-64 border-r bg-white min-h-[calc(100vh-56px)]">
            <div className="p-3 border-b text-xs uppercase text-gray-600">Zone maps</div>
            <ul className="text-sm">
              {allMaps.map((m) => {
                const active = m.id === selected.id;
                const scope = m.contractId ? `override · ${m.contract?.name ?? `contract ${m.contractId}`}` : "baseline";
                return (
                  <li key={m.id}>
                    <Link
                      href={`/zones?id=${m.id}`}
                      className={`block px-3 py-2 border-b ${active ? "bg-blue-50 text-blue-900" : "hover:bg-gray-50"}`}
                    >
                      <div className="font-medium">{m.zone_group}</div>
                      <div className="text-xs text-gray-600">
                        {m.carrier} · {m.billing_country} · {scope}
                      </div>
                      <div className="text-xs text-gray-500">{m.countries.length} countries</div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </aside>
          <section className="flex-1">
            <ZoneEditor zoneMap={dto} />
          </section>
        </div>
      </main>
    </>
  );
}

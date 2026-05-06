import { notFound } from "next/navigation";
import { db } from "../../lib/db";
import { contractToDto } from "../../lib/dto";
import { ContractEditor } from "../../components/ContractEditor";
import { Nav } from "../../components/Nav";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ extracted?: string; customer?: string; carrier?: string }>;
}

export default async function ContractPage({ params, searchParams }: Params) {
  const { id } = await params;
  const { extracted, customer: customerParam, carrier: carrierParam } = await searchParams;
  const carrierForNav: "all" | "dhl" | "ups" = carrierParam === "dhl" || carrierParam === "ups" ? carrierParam : "all";
  const contractId = Number(id);
  if (!Number.isFinite(contractId)) return notFound();

  const [row, sources] = await Promise.all([
    db.contract.findUnique({
      where: { id: contractId },
      include: {
        freight: { include: { sub_products: { include: { bands: true } } } },
        addons: true,
      },
    }),
    db.contractSource.findMany({
      where: { contractId },
      select: { id: true, filename: true, kind: true, size_bytes: true, uploadedAt: true, sha256: true },
      orderBy: { uploadedAt: "asc" },
    }),
  ]);
  if (!row) return notFound();

  const dto = contractToDto(row);

  return (
    <>
      <Nav active="contracts" customer={customerParam ?? null} carrier={carrierForNav} />
      {extracted && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-sm text-amber-900">
          <strong>Extracted — please verify.</strong> Low-confidence cells are highlighted in the grid. Fix any
          mis-reads before running an invoice audit.
        </div>
      )}
      {sources.length > 0 && (
        <div className="px-4 pt-3">
          <div className="bg-white border rounded p-3 text-sm max-w-6xl mx-auto">
            <div className="text-xs font-medium text-gray-600 mb-2">Source documents</div>
            <ul className="space-y-1">
              {sources.map((s) => (
                <li key={s.id} className="flex items-center gap-3 text-xs">
                  <span className="font-mono uppercase text-gray-500 w-10">{s.kind}</span>
                  <a href={`/api/contract-sources/${s.id}`} className="text-blue-700 hover:underline" download>
                    {s.filename}
                  </a>
                  <span className="text-gray-500">{formatBytes(s.size_bytes)}</span>
                  <span className="text-gray-400">{s.uploadedAt.toISOString().slice(0, 10)}</span>
                  {s.sha256 && <span className="font-mono text-gray-300 text-[10px]" title={s.sha256}>{s.sha256.slice(0, 8)}…</span>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <ContractEditor contract={dto} />
    </>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

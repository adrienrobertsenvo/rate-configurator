import Link from "next/link";
import { loadCustomers } from "../lib/customer-context";
import { CustomerPicker } from "./CustomerPicker";
import { CarrierPicker } from "./CarrierPicker";

// Server component — fetches the customer list once per render so the picker
// has fresh contract counts. Both the customer and carrier filters live here
// so every page picks them up via URL params.
export async function Nav({ active, customer, carrier }: {
  active: "contracts" | "invoices" | "zones" | "catalog" | "export" | "simulator" | "rules" | "code-mapping";
  customer?: string | null;
  carrier?: "all" | "dhl" | "ups" | null;
}) {
  const customers = await loadCustomers();
  const selected = customer ?? null;
  const carrierSelected = carrier ?? "all";
  // Preserve both filters when switching tabs.
  const params = new URLSearchParams();
  if (selected) params.set("customer", selected);
  if (carrierSelected !== "all") params.set("carrier", carrierSelected);
  const qs = params.toString() ? `?${params.toString()}` : "";

  const tab = (id: string, label: string, href: string) => (
    <Link
      key={id}
      href={`${href}${qs}`}
      className={`text-sm px-3 py-1 rounded ${active === id ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-100"}`}
    >
      {label}
    </Link>
  );

  return (
    <header className="flex items-center justify-between px-4 py-2 bg-white border-b border-gray-200 gap-3 flex-wrap">
      <div className="flex items-baseline gap-3">
        <Link href={`/${qs}`} className="text-base font-semibold">Rate Audit and Configurator</Link>
        <span className="text-xs text-gray-500">Carrier contracts → YAML</span>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <CarrierPicker selected={carrierSelected} />
        <CustomerPicker customers={customers} selected={selected} />
        <nav className="flex gap-1 flex-wrap">
          {tab("contracts", "Contracts", "/")}
          {tab("invoices", "Invoices", "/invoices")}
          {tab("simulator", "Simulator", "/simulator")}
          {tab("rules", "Rules", "/rules")}
          {tab("code-mapping", "Code map", "/code-mapping")}
          {tab("zones", "Zones", "/zones")}
          {tab("catalog", "Catalog", "/catalog")}
          {tab("export", "Export", "/export")}
        </nav>
      </div>
    </header>
  );
}


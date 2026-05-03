// Helpers for threading the ?customer=<code> URL param through the app.

import { db } from "./db";

export interface CustomerOption {
  id: number;
  code: string;
  display_name: string;
  contract_count: number;
  invoice_count: number;
}

// Ordered list for the nav dropdown — alphabetical by display name. Invoice
// count is the dropdown's headline number because it's the day-to-day work
// volume; contract count is visible on the Contracts page itself.
export async function loadCustomers(): Promise<CustomerOption[]> {
  const rows = await db.customer.findMany({
    orderBy: { display_name: "asc" },
    include: { _count: { select: { contracts: true, invoices: true } } },
  });
  return rows.map((r) => ({
    id: r.id, code: r.code,
    display_name: r.display_name ?? r.name,
    contract_count: r._count.contracts,
    invoice_count: r._count.invoices,
  }));
}

// Resolve a customer slug from the URL param to its id (or null = "All customers").
export async function resolveCustomer(code: string | undefined | null): Promise<{ id: number; code: string; display_name: string } | null> {
  if (!code || code === "all") return null;
  const c = await db.customer.findUnique({ where: { code } });
  if (!c) return null;
  return { id: c.id, code: c.code, display_name: c.display_name ?? c.name };
}

// Build a Prisma `where` clause that scopes Contract queries to the selected
// customer. System contracts (customerId=null) are visible across all customer
// scopes per the design — they're shared baselines.
export function contractCustomerWhere(customerId: number | null) {
  if (customerId == null) return {}; // "All customers" — no filter
  return { OR: [{ customerId }, { customerId: null }] };
}

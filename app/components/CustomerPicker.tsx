"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { CustomerOption } from "../lib/customer-context";

export function CustomerPicker({ customers, selected }: { customers: CustomerOption[]; selected: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function go(code: string) {
    const next = new URLSearchParams(params.toString());
    if (code === "all") next.delete("customer");
    else next.set("customer", code);
    // Drop any per-page status filter when changing customer — it's likely meaningless across scopes.
    next.delete("filter");
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <select
      className="text-sm border rounded px-2 py-0.5 bg-white"
      value={selected ?? "all"}
      onChange={(e) => go(e.target.value)}
      title="Filter the whole app to one customer"
    >
      <option value="all">All customers</option>
      {customers.map((c) => (
        <option key={c.code} value={c.code}>
          {c.display_name} ({c.invoice_count} invoice{c.invoice_count === 1 ? "" : "s"})
        </option>
      ))}
    </select>
  );
}

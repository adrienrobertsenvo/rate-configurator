"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

// Global carrier filter — same idea as CustomerPicker. Lives in the Nav, so
// every page picks up the URL param and filters its data. URL value is the
// carrier "family" (lowercase): "dhl" matches any DHL-EXPRESS-* code, "ups"
// matches UPS-*. Absent / "all" → no filter.
export function CarrierPicker({ selected }: { selected: "all" | "dhl" | "ups" }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function go(c: "all" | "dhl" | "ups") {
    const next = new URLSearchParams(params.toString());
    if (c === "all") next.delete("carrier");
    else next.set("carrier", c);
    // Drop status / product / surcharge filters — they're carrier-specific
    // and would carry stale codes across (e.g. DHL surcharge "FF" makes no
    // sense in UPS scope, where the equivalent code is "FSC").
    next.delete("status");
    next.delete("product");
    next.delete("surcharge");
    next.delete("filter");
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  const items: ReadonlyArray<readonly ["all" | "dhl" | "ups", string, string]> = [
    ["all", "All",  "bg-gray-100 text-gray-800 hover:bg-gray-200"],
    ["dhl", "DHL",  "bg-amber-50 text-amber-900 hover:bg-amber-100"],
    ["ups", "UPS",  "bg-stone-100 text-stone-900 hover:bg-stone-200"],
  ];
  return (
    <div className="flex gap-1 text-xs" role="tablist" aria-label="Carrier filter">
      {items.map(([code, label, cls]) => (
        <button
          key={code}
          onClick={() => go(code)}
          className={`px-2.5 py-1 rounded font-medium ${cls} ${selected === code ? "ring-2 ring-blue-400 ring-offset-1" : ""}`}
          title={code === "all" ? "All carriers" : `Show only ${label} content`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

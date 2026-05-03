// Derive implied UPS fuel-surcharge rates from real billings — group lines
// by shipment date + service code, compute FSC / (WC + fuelable surcharges).
// The mode of the implied rates per (week, service-class) tells us what UPS
// actually applied, which we can then seed into fuel-rates.ts.
//
// Run: npx tsx scripts/derive_ups_fuel_rates.ts
import { db } from "../app/lib/db";

interface Sample {
  date: string;
  service_class: "GROUND" | "AIR" | "OTHER";
  base: number;
  fsc: number;
  rate: number;
  contractId: number | null;
}

const FUELABLE = new Set(["RES", "PFR", "PFC", "ESD", "PIF", "LTG"]);

function classOf(productCode: string): "GROUND" | "AIR" | "OTHER" {
  const c = productCode?.toUpperCase() ?? "";
  if (c === "003" || c === "011") return "GROUND";
  if (["069", "070", "066", "072", "021", "017", "001", "007", "013", "014", "054"].includes(c)) return "AIR";
  return "OTHER";
}

async function main() {
  const customerFilter = process.argv[2] ? Number(process.argv[2]) : null;  // contract id
  const where = customerFilter
    ? { invoice: { contractId: customerFilter }, weight_charge: { gt: 0 } }
    : { invoice: { contract: { carrier: { startsWith: "UPS" } } }, weight_charge: { gt: 0 } };
  console.log(`Filter: ${customerFilter ? `contract #${customerFilter}` : "all UPS contracts"}\n`);
  const lines = await db.invoiceLine.findMany({
    where,
    select: { shipment_date: true, product_code: true, weight_charge: true, surcharges_json: true,
              invoice: { select: { contractId: true } } },
  });

  const samples: Sample[] = [];
  for (const l of lines) {
    if (!l.surcharges_json || !l.shipment_date || l.weight_charge == null) continue;
    let arr: { code: string; charge: number }[];
    try { arr = JSON.parse(l.surcharges_json); } catch { continue; }
    const fsc = arr.find((s) => s.code === "FSC");
    if (!fsc || fsc.charge <= 0) continue;
    const fuelable = arr.filter((s) => FUELABLE.has(s.code)).reduce((acc, s) => acc + s.charge, 0);
    const base = l.weight_charge + fuelable;
    if (base <= 0) continue;
    samples.push({
      date: l.shipment_date.slice(0, 10),
      service_class: classOf(l.product_code ?? ""),
      base,
      fsc: fsc.charge,
      rate: fsc.charge / base,
      contractId: l.invoice?.contractId ?? null,
    });
  }

  // Bucket by contract + week + service class. Customers' fuel discounts vary
  // (everstox 20% off, Quivo/Thomann TBD), so we report per-contract medians
  // so each customer's effective multiplier can be calibrated.
  const buckets = new Map<string, number[]>();
  for (const s of samples) {
    const week = s.date.slice(0, 7); // month-grain is enough for noisy data
    const key = `c${s.contractId}|${week}|${s.service_class}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(s.rate);
  }

  console.log(`Implied UPS fuel rates from ${samples.length} sample lines:`);
  console.log(`(rate = FSC / (WC + RES/PFR/PFC/ESD/PIF/LTG))\n`);
  console.log(`contract  month     class   n      median %`);
  console.log(`-------------------------------------------------`);
  for (const [k, rates] of [...buckets.entries()].sort()) {
    const sorted = [...rates].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(`${k.padEnd(35)} ${String(rates.length).padStart(5)}   ${(median * 100).toFixed(2).padStart(7)}`);
  }

  // Compute implied discount per contract: median of (implied / published).
  // Published rates from fuel-rates.ts.
  const { UPS_FUEL_RATES } = await import("../app/lib/carriers/ups/fuel-rates");
  function publishedRateOn(klass: "AIR" | "GROUND", date: string): number | null {
    const tbl = klass === "GROUND" ? UPS_FUEL_RATES.GROUND : UPS_FUEL_RATES.AIR;
    let best: typeof tbl[number] | null = null;
    for (const e of tbl) if (e.effective_from <= date && (!best || e.effective_from > best.effective_from)) best = e;
    return best?.rate ?? null;
  }
  const ratiosByContract = new Map<number | null, number[]>();
  for (const s of samples) {
    if (s.service_class === "OTHER") continue;
    const pub = publishedRateOn(s.service_class, s.date);
    if (!pub) continue;
    const ratio = s.rate / pub;
    if (!ratiosByContract.has(s.contractId)) ratiosByContract.set(s.contractId, []);
    ratiosByContract.get(s.contractId)!.push(ratio);
  }
  console.log(`\nImplied fuel discount per contract (median of implied / published):`);
  for (const [c, ratios] of [...ratiosByContract.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const sorted = [...ratios].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const discount = 1 - median;
    console.log(`  contract #${c}  n=${ratios.length}  median multiplier=${median.toFixed(4)}  ⇒ discount ${(discount * 100).toFixed(1)}%`);
  }

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

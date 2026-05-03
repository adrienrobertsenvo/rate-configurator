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
}

const FUELABLE = new Set(["RES", "PFR", "PFC", "ESD", "PIF", "LTG"]);

function classOf(productCode: string): "GROUND" | "AIR" | "OTHER" {
  const c = productCode?.toUpperCase() ?? "";
  if (c === "003" || c === "011") return "GROUND";
  if (["069", "070", "066", "072", "021", "017", "001", "007", "013", "014", "054"].includes(c)) return "AIR";
  return "OTHER";
}

async function main() {
  const lines = await db.invoiceLine.findMany({
    where: { invoice: { contractId: 16 }, weight_charge: { gt: 0 } },
    select: { shipment_date: true, product_code: true, weight_charge: true, surcharges_json: true },
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
    });
  }

  // Bucket by month + service class, average the implied rate.
  const buckets = new Map<string, number[]>();
  for (const s of samples) {
    const month = s.date.slice(0, 7);
    const key = `${month} ${s.service_class}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(s.rate);
  }

  console.log(`Implied UPS fuel rates from ${samples.length} sample lines:`);
  console.log(`(rate = FSC / (WC + RES/PFR/PFC/ESD/PIF/LTG))\n`);
  console.log(`month   class   n     median %  mean %`);
  console.log(`----------------------------------------`);
  for (const [k, rates] of [...buckets.entries()].sort()) {
    const sorted = [...rates].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    console.log(`${k.padEnd(15)} ${String(rates.length).padStart(3)}   ${(median * 100).toFixed(2).padStart(7)}   ${(mean * 100).toFixed(2)}`);
  }

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

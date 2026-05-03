// Walk every contract's per-kg surcharges and (a) parse a minimum price from
// the rule's name when it's literally stated ("(min 24 EUR)", "(per kg, min 3.90 EUR)"),
// (b) apply known DHL standard defaults for Remote Area / Dedicated when the
// name matches but no minimum was captured, and (c) infer the scope from the
// name (Domestic/Inland → domestic, International/Ausland → international).
//
// Run: npx tsx scripts/apply_surcharge_minimums.ts
import { db } from "../app/lib/db";

interface Default { match: RegExp; min: number; scope: "any" | "domestic" | "international" }

// Standard DHL Express Germany minimums for per-kg surcharges. Used when the
// contract didn't ship a min in the rule's name.
const DEFAULTS: Default[] = [
  { match: /remote\s*area\s*delivery.*(domestic|inland)/i,             min: 3.90, scope: "domestic" },
  { match: /zustellung\s*au(ß|ss)engebiete.*(domestic|inland)/i,       min: 3.90, scope: "domestic" },
  { match: /remote\s*area\s*delivery.*(international|ausland|export)/i, min: 24,   scope: "international" },
  { match: /zustellung\s*au(ß|ss)engebiete.*(international|ausland)/i,  min: 24,   scope: "international" },
  { match: /remote\s*area\s*delivery/i,                                 min: 24,   scope: "international" }, // unscoped delivery default
  { match: /remote\s*area\s*pickup/i,                                   min: 24,   scope: "any" },
  { match: /abholung.*au(ß|ss)engebiete/i,                              min: 24,   scope: "any" },
  { match: /abholung\s*in\s*au(ß|ss)engebieten/i,                       min: 24,   scope: "any" },
  { match: /dedicated\s*pickup/i,                                       min: 30,   scope: "any" },
  { match: /sonderabholung/i,                                           min: 30,   scope: "any" },
  { match: /dedicated\s*delivery/i,                                     min: 40,   scope: "any" },
  { match: /sonderzustellung/i,                                         min: 40,   scope: "any" },
];

function parseExplicitMin(name: string): number | null {
  // matches "(min 24 EUR)", "min 3.90 EUR", "min 30 €", etc.
  const m = name.match(/min\s*([\d.,]+)\s*(?:EUR|€)/i);
  if (!m) return null;
  const v = Number(m[1].replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

function inferScope(name: string): "any" | "domestic" | "international" | null {
  if (/(domestic|inland|inlandsendung|innerdeutsch)/i.test(name)) return "domestic";
  if (/(international|ausland|export)/i.test(name)) return "international";
  return null;
}

async function main() {
  const surcharges = await db.surcharge.findMany({
    where: { kind: "per_kg" },
    include: { contract: { select: { id: true, name: true } } },
    orderBy: [{ contractId: "asc" }, { name: "asc" }],
  });

  let updated = 0;
  for (const s of surcharges) {
    const explicitMin = parseExplicitMin(s.name);
    let min: number | null = explicitMin;
    let scope: "any" | "domestic" | "international" = (s.applies_to as "any" | "domestic" | "international") ?? "any";

    // Use heuristic defaults when the rule name didn't carry a literal "min X EUR".
    if (min == null) {
      for (const d of DEFAULTS) {
        if (d.match.test(s.name)) {
          min = d.min;
          if (scope === "any") scope = d.scope; // don't override an explicit scope already set
          break;
        }
      }
    } else {
      // Explicit min present; still try to infer scope from the name.
      const inferred = inferScope(s.name);
      if (inferred && scope === "any") scope = inferred;
    }

    // Skip rules we don't know how to handle (Mautzuschlag, GoGreen, Bonded Storage, etc.).
    if (min == null && scope === ((s.applies_to as string) ?? "any")) continue;

    const patch: Record<string, unknown> = {};
    if (min != null && min !== s.min_amount) patch.min_amount = min;
    if (scope !== ((s.applies_to as string) ?? "any")) patch.applies_to = scope;
    if (Object.keys(patch).length === 0) continue;

    await db.surcharge.update({ where: { id: s.id }, data: patch });
    console.log(`UPDATE c#${s.contractId} '${s.name}' → ${JSON.stringify(patch)}`);
    updated++;
  }
  console.log(`\nupdated=${updated}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

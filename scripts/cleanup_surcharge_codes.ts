// One-off cleanup: for every contract Surcharge whose code looks like a placeholder
// (e.g. "UNK-…"), try to resolve the canonical billing code by name via
// CatalogSurcharge. If a match is found, update the code in place. Reports per-row.
//
// Run: npx tsx scripts/cleanup_surcharge_codes.ts
import { db } from "../app/lib/db";

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Strip parenthetical scope/note suffixes so "Remote Area Delivery (Domestic)"
// can match the canonical catalog name "Remote Area Delivery". Also drops
// trailing notes like "(per kg, min 24 EUR)".
function stripParens(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*/g, " ").trim();
}

function looksPlaceholder(code: string): boolean {
  return code.startsWith("UNK-") || code.startsWith("UNK_") || code.length > 4;
}

function inferScope(name: string): "any" | "domestic" | "international" {
  if (/(domestic|inland|inlandsendung|innerdeutsch)/i.test(name)) return "domestic";
  if (/(international|ausland|export|worldwide)/i.test(name)) return "international";
  return "any";
}

// German rule names → canonical DHL invoice billing code. Caught by the cleanup
// pass when the catalog (English-only) doesn't match.
const GERMAN_ALIASES: { pattern: RegExp; code: string }[] = [
  { pattern: /(zustellung|abholung)\s*(in\s+)?au(ß|ss)engebiete/i, code: "OO" }, // Remote Area Pickup/Delivery
  { pattern: /mautzuschlag/i,                                      code: "RD" }, // Toll
  { pattern: /sonderzuschlag.*bedarfsspitz/i,                      code: "NX" }, // Demand
  { pattern: /adresskorrektur/i,                                   code: "MA" }, // Address Correction
  { pattern: /treibstoffzuschlag/i,                                code: "FF" }, // Fuel
];

async function main() {
  const surcharges = await db.surcharge.findMany({
    include: { contract: { select: { id: true, name: true, carrier: true } } },
    orderBy: { id: "asc" },
  });

  const catalog = await db.catalogSurcharge.findMany();
  const indexByCarrier = new Map<string, Map<string, string>>();
  for (const c of catalog) {
    if (!indexByCarrier.has(c.carrier)) indexByCarrier.set(c.carrier, new Map());
    indexByCarrier.get(c.carrier)!.set(normalizeName(c.name), c.code);
  }

  let renamed = 0;
  let skipped = 0;
  let conflict = 0;
  // Pre-pass: for every surcharge whose scope is still "any" but whose name
  // includes Domestic / International / Export / Inland / Ausland, tag the
  // scope so two siblings don't both end up scope=any when they're renamed
  // to the same canonical code in the main pass.
  for (const s of surcharges) {
    const inferred = inferScope(s.name);
    if (inferred !== "any" && (s.applies_to === "any" || !s.applies_to)) {
      await db.surcharge.update({ where: { id: s.id }, data: { applies_to: inferred } });
      s.applies_to = inferred;
      console.log(`SCOPE id=${s.id} '${s.name}' → ${inferred}`);
    }
  }

  for (const s of surcharges) {
    if (!looksPlaceholder(s.code)) continue;
    const idx = indexByCarrier.get(s.contract.carrier);
    // Try the full normalized name first, then fall back to the parenthetical-stripped form
    // ("Remote Area Delivery (Domestic)" → "Remote Area Delivery" → catalog OO),
    // then try the German alias table.
    const germanAlias = GERMAN_ALIASES.find((a) => a.pattern.test(s.name))?.code;
    const canonical =
      idx?.get(normalizeName(s.name)) ??
      idx?.get(normalizeName(stripParens(s.name))) ??
      germanAlias;
    if (!canonical) { skipped++; continue; }
    if (canonical === s.code) continue;
    // Multiple contract rows can legitimately share a canonical code when each
    // has its own applies_to scope (e.g. domestic vs international Remote Area).
    // We DO want to apply the canonical here so the engine can scope-pick
    // between them; only skip if there's already an identical (code, scope) pair.
    const conflictRow = await db.surcharge.findFirst({
      where: {
        contractId: s.contractId,
        code: canonical,
        applies_to: s.applies_to,
        NOT: { id: s.id },
      },
      select: { id: true, name: true },
    });
    if (conflictRow) {
      console.log(`SKIP id=${s.id} ${s.contract.name} · '${s.name}' → ${canonical}/${s.applies_to} (would clash with row #${conflictRow.id} '${conflictRow.name}')`);
      conflict++;
      continue;
    }
    console.log(`UPDATE id=${s.id} ${s.contract.name} · '${s.name}' : ${s.code} → ${canonical} (scope=${s.applies_to})`);
    await db.surcharge.update({ where: { id: s.id }, data: { code: canonical } });
    renamed++;
  }
  console.log(`\nrenamed=${renamed}  skipped(no match)=${skipped}  conflicts=${conflict}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

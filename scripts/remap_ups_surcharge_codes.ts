// Patch contract #16 surcharge codes — the LLM extractor knew RES / EVS /
// LTG / FSC / PIF / CIS but bucketed others under UNK-* prefixes because it
// couldn't infer UPS's official 3-letter codes. Real billings reveal which
// codes appear most often, so we map by name.
//
// Run: npx tsx scripts/remap_ups_surcharge_codes.ts
import { db } from "../app/lib/db";

const CONTRACT_ID = 16;
const REMAPS: { fromCode: string; namePattern: RegExp; toCode: string }[] = [
  // Extended-area variants → UPS uses ESD (delivery) / ESP (pickup).
  { fromCode: "UNK-Extend", namePattern: /extended\s+area\s+delivery/i, toCode: "ESD" },
  { fromCode: "UNK-Extend", namePattern: /extended\s+area\s+pickup/i,   toCode: "ESP" },
  // Remote area → UPS uses OSR / OPR variants but everstox bills none of
  // these; keep as UNK so they don't shadow legitimate codes.
  // Daily / weekly service fee — invoice rows use DSC / GWN.
  { fromCode: "UNK-Daily",  namePattern: /daily\s+service\s+(charge|pauschale)/i,    toCode: "DSC" },
  { fromCode: "UNK-Weekly", namePattern: /weekly\s+service\s+(charge|pauschale)/i,   toCode: "GWN" },
  // Address correction — UPS bills "ADC" (domestic) / "ACI" (international).
  { fromCode: "UNK-Addres", namePattern: /address\s+correction\s*\(brokerage/i,      toCode: "ACI" },
  { fromCode: "UNK-Addres", namePattern: /^address\s+correction$/i,                    toCode: "ADC" },
  // Surge fees — residential / commercial. Some contracts call these
  // Peak / Demand surcharges. Invoice codes are PFR / PFC.
  { fromCode: "UNK-Surge",  namePattern: /surge.*residen/i,                            toCode: "PFR" },
  { fromCode: "UNK-Surge",  namePattern: /surge.*commer/i,                             toCode: "PFC" },
  { fromCode: "UNK-Peak",   namePattern: /peak.*residen/i,                             toCode: "PFR" },
  // Hazmat — UPS bills DGR/HZL/LTG variants. Lithium battery → LTG (already
  // mapped), other Class 9 → HZL, Class 1-8 → DGR.
  { fromCode: "UNK-HAZ Ma", namePattern: /class\s*9.*limited/i,                        toCode: "HZL" },
  { fromCode: "UNK-HAZ Ma", namePattern: /class\s*9.*cargo/i,                          toCode: "HZL" },
  { fromCode: "UNK-HAZ Ma", namePattern: /class\s*1-8/i,                               toCode: "DGR" },
];

async function main() {
  let updated = 0, kept = 0;
  for (const r of REMAPS) {
    const matching = await db.surcharge.findMany({
      where: { contractId: CONTRACT_ID, code: r.fromCode },
      select: { id: true, code: true, name: true },
    });
    for (const s of matching) {
      if (r.namePattern.test(s.name)) {
        await db.surcharge.update({ where: { id: s.id }, data: { code: r.toCode } });
        console.log(`  #${s.id}  "${s.name}"  ${s.code} → ${r.toCode}`);
        updated++;
      } else {
        kept++;
      }
    }
  }
  console.log(`\n${updated} remapped, ${kept} kept under UNK-`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

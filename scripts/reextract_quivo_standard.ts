// Focused re-extract for Quivo (contract #17) — the first LLM pass returned
// 0 bands for "Standard" EXPORT (Einzelpaket / Mehrpaket variants), which
// happens to be the product Quivo bills almost exclusively. This run targets
// JUST that product with a sharpened prompt + bigger output budget.
//
// Run: npx tsx scripts/reextract_quivo_standard.ts
//      (set -a && source .env && set +a && ...)
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { readFileSync } from "node:fs";
import { db } from "../app/lib/db";
import { ProductDetailSchema } from "../app/lib/carriers/extract-shared";

const CONTRACT_ID = 17;
const PDF_PATH = "/tmp/ups/quivo/Vertrag UPS signed.pdf";

const SYSTEM_PROMPT = `You are extracting UPS RATE TABLES from a German UPS contract PDF.

ASKED PRODUCT: "Standard" (UPS Standard, intra-Europe ground, 3-digit code 011)
The contract has THREE variants for Standard:
  1. "Einzelpaket"          (Single Package)
  2. "Mehrpaket Frei Haus"  (Multi-Package DDP — sender pays all)
  3. "Mehrpaket Rechnung Dritte" (Multi-Package — third-party billing)

Each variant has its own rate table — typically a multi-zone matrix with weight breaks down rows and zone columns. Find ALL THREE variants and return the rate bands for each.

Output rules:
- All weights in OUTPUT are GRAMS. Convert from kg: 0.5 → 500, 70 → 70000.
- Each band has either {weight_end_g, price} (fixed tier) OR {per_kg, step_kg} (extrapolation). Never both.
- Zone labels: keep them as the contract prints them ("Zone 1", "Zone 3", "Zone 31", "Zone 41" — UPS DE uses lane-specific zone numbers like 31, 41, 704).
- If a cell is illegible, OMIT it — don't invent.
- Confidence: 0.95+ for clear cells, 0.7 ambiguous.

Sub-product naming: use the EXACT German names the contract uses ("Einzelpaket", "Mehrpaket Frei Haus", "Mehrpaket Rechnung Dritte"). Don't translate.

Take your time. Return the complete rate matrix for ALL THREE Standard variants. Use up to your full token budget.`;

async function main() {
  const client = new Anthropic();
  const buf = readFileSync(PDF_PATH);
  const stream = client.messages.stream({
    model: "claude-opus-4-7",
    max_tokens: 96000,
    thinking: { type: "disabled" },
    system: SYSTEM_PROMPT,
    output_config: { format: zodOutputFormat(ProductDetailSchema), effort: "low" },
    messages: [{
      role: "user",
      content: [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") },
          title: "Vertrag UPS signed.pdf",
        },
        {
          type: "text",
          text: "Extract the Standard product rate tables (Einzelpaket, Mehrpaket Frei Haus, Mehrpaket Rechnung Dritte). Use product_name = \"Standard\" in the output. Return all three variants as separate sub_products with their full zone × weight matrices.",
        },
      ],
    }],
  });
  const final = await stream.finalMessage();
  if (final.stop_reason === "max_tokens") {
    console.warn(`(stop=max_tokens — output may be truncated)`);
  }
  const textBlock = final.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new Error(`no text block (stop_reason=${final.stop_reason})`);
  const detail = ProductDetailSchema.parse(JSON.parse(textBlock.text));

  console.log(`\nLLM produced ${detail.sub_products.length} sub-product(s) for "${detail.product_name}":`);
  for (const sp of detail.sub_products) {
    const totalBands = sp.zones.reduce((acc, z) => acc + z.bands.length, 0);
    console.log(`  · ${sp.name}  ${sp.zones.length} zones, ${totalBands} bands`);
  }
  if (detail.notes) console.log(`  notes: ${detail.notes.slice(0, 300)}`);

  // Find the existing Standard FreightProduct on contract #17 + replace its
  // children with what we just extracted.
  const product = await db.freightProduct.findFirst({
    where: { contractId: CONTRACT_ID, name: "Standard" },
    select: { id: true },
  });
  if (!product) throw new Error("No 'Standard' product on contract #17");
  await db.priceBand.deleteMany({ where: { subProduct: { productId: product.id } } });
  await db.subProduct.deleteMany({ where: { productId: product.id } });

  for (let i = 0; i < detail.sub_products.length; i++) {
    const sp = detail.sub_products[i];
    const sub = await db.subProduct.create({
      data: { productId: product.id, name: sp.name, codes: "011,003", order: i },
      select: { id: true },
    });
    for (const z of sp.zones) {
      let order = 0;
      for (const b of z.bands) {
        await db.priceBand.create({
          data: {
            subProductId: sub.id, zone: z.zone, order: order++,
            weight_start: b.weight_start_g, weight_end: b.weight_end_g,
            price: b.price, per_kg: b.per_kg, step: b.step_kg, confidence: b.confidence,
          },
        });
      }
    }
  }
  console.log(`\n✓ Replaced bands on contract #${CONTRACT_ID} → "Standard" product.`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

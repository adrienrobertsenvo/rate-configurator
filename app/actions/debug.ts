"use server";

import Anthropic from "@anthropic-ai/sdk";
import { db } from "../lib/db";

export type DebugMessage = { role: "user" | "assistant"; content: string };

const SYSTEM_PROMPT = `You help a logistics analyst debug discrepancies between carrier invoices and a rate-audit engine.

You receive the full context for ONE invoice line: the matched contract product & sub-product, its zone bands (fixed-price + per-kg extrapolation), the engine's matched band, the computed expected amount, the invoice's actual amount, tax rules, and contract surcharge rules. You also receive how the engine currently computes the weight charge for extrapolation.

When the user asks why a number is what it is, work through the math step-by-step with units (kg, €, %). Quote specific band values from the contract. If the engine's math diverges from what the contract implies, say so directly — the user needs to know whether the engine is wrong or the contract entry is wrong.

Be terse. No preamble. One or two short paragraphs, then the math. If you're confident of a root cause, state it plainly.`;

function toKg(g: number | null | undefined): string {
  if (g == null) return "?";
  return (g / 1000).toFixed(2);
}

export async function debugLine(lineId: number, messages: DebugMessage[]): Promise<{ reply: string }> {
  const line = await db.invoiceLine.findUnique({
    where: { id: lineId },
    include: {
      invoice: {
        select: {
          invoice_number: true,
          currency: true,
          contract: {
            select: {
              id: true,
              name: true,
              carrier: true,
              billing_country: true,
              currency_code: true,
              freight: {
                include: {
                  sub_products: { include: { bands: { orderBy: [{ zone: "asc" }, { order: "asc" }] } } },
                },
              },
              addons: true,
            },
          },
        },
      },
    },
  });

  if (!line) throw new Error("Invoice line not found");
  const contract = line.invoice?.contract;
  if (!contract) throw new Error("Contract not linked to this invoice");

  const matchedProduct = contract.freight.find((p) => p.name === line.matched_product) ?? null;
  const matchedSub = matchedProduct?.sub_products.find((s) => s.name === line.matched_sub_product) ?? null;

  let zoneMapInfo: string;
  if (matchedProduct) {
    const zm = await db.zoneMap.findFirst({
      where: {
        carrier: contract.carrier,
        billing_country: contract.billing_country,
        zone_group: matchedProduct.zone_group,
        OR: [{ contractId: null }, { contractId: contract.id }],
      },
      include: { countries: true },
      orderBy: { contractId: "desc" },
    });
    if (zm) {
      const entry = zm.countries.find((c) => c.country === (line.dest_country ?? "").toUpperCase());
      zoneMapInfo = `Zone map "${matchedProduct.zone_group}" (${zm.countries.length} countries) → ${line.dest_country ?? "?"} = Zone ${entry?.zone ?? "?"}`;
    } else {
      zoneMapInfo = `No zone map found for group "${matchedProduct.zone_group}" / ${contract.billing_country}`;
    }
  } else {
    zoneMapInfo = "No product match — zone lookup skipped";
  }

  const matchedBand = line.matched_band_json ? JSON.parse(line.matched_band_json) : null;
  const actualSurcharges = line.surcharges_json ? JSON.parse(line.surcharges_json) : [];
  const expectedSurcharges = line.expected_surcharges_json ? JSON.parse(line.expected_surcharges_json) : [];

  const bandsBlock = matchedSub
    ? matchedSub.bands
        .map((b) => {
          const prefix = `  [Zone ${b.zone} · order ${b.order}] ${toKg(b.weight_start)}`;
          if (b.weight_end != null && b.price != null) {
            return `${prefix}–${toKg(b.weight_end)} kg → €${b.price.toFixed(2)}`;
          }
          const step = b.step != null ? ` (step ${b.step} kg)` : "";
          return `${prefix} kg+ · €${b.per_kg?.toFixed(4) ?? "?"}/kg${step}   [extrapolation]`;
        })
        .join("\n")
    : "(no sub-product match — cannot list bands)";

  const addonsBlock = contract.addons
    .map((a) => `  ${a.code} (${a.kind}${a.amount != null ? ` · ${a.amount}` : " · no amount"}) — ${a.name}`)
    .join("\n");

  const engineExplanation = `The engine's priceFor algorithm:
  1. Walks fixed-price bands in order; if weight_g ∈ [weight_start, weight_end] returns that band's price.
  2. Otherwise, of all per-kg (extrapolation) bands whose weight_start ≤ weight_g, it picks the HIGHEST weight_start, and returns:
     - with step: chargeable_kg = ceil(weight_g / 1000 / step) * step, price = chargeable_kg × per_kg
     - without step: price = (weight_g / 1000) × per_kg
  IMPORTANT: this returns ONLY the extrapolation amount — it does NOT add the last fixed band's price. If the contract intends "price_at_cap + (weight − cap) × per_kg" (additive extrapolation, typical of DHL), the engine will be off by the last fixed-band price.`;

  const context = `CONTRACT: ${contract.name} (${contract.carrier} · billing ${contract.billing_country} · ${contract.currency_code})

INVOICE LINE
  shipment:        ${line.shipment_number ?? "—"}
  invoice number:  ${line.invoice?.invoice_number ?? "—"}
  product code:    ${line.product_code ?? "—"} (${line.product_name ?? "—"})
  route:           ${line.origin_country ?? "?"} → ${line.dest_country ?? "?"}
  weight:          ${line.weight_kg?.toFixed(2) ?? "?"} kg  (flag: ${line.weight_flag ?? "—"})
  invoiced total:  €${line.charged_amount?.toFixed(2) ?? "?"}
  invoiced weight charge: €${line.weight_charge?.toFixed(2) ?? "?"}
  tax code:        ${line.tax_code ?? "—"}
  total tax:       €${line.total_tax?.toFixed(2) ?? "?"}

CATALOG MATCH
  matched product:     ${line.matched_product ?? "—"}
  matched sub-product: ${line.matched_sub_product ?? "—"}
  matched zone:        ${line.matched_zone ?? "—"}
  ${zoneMapInfo}

CONTRACT BANDS for ${line.matched_product ?? "?"} / ${line.matched_sub_product ?? "?"}:
${bandsBlock}

ENGINE MATCHED BAND (the one actually used for this line):
${matchedBand ? JSON.stringify(matchedBand) : "null"}

ENGINE OUTPUTS
  expected weight charge: €${line.expected_weight_charge?.toFixed(2) ?? "—"}
  expected total:         €${line.expected_amount?.toFixed(2) ?? "—"}
  delta (inv − expected): €${line.delta?.toFixed(2) ?? "—"}   status: ${line.audit_status ?? "—"}
  expected tax:           €${line.expected_tax?.toFixed(2) ?? "—"}
  tax delta:              €${line.tax_delta?.toFixed(2) ?? "—"}  status: ${line.tax_status ?? "—"}
  surcharge delta:        €${line.surcharge_delta?.toFixed(2) ?? "—"}  status: ${line.surcharge_status ?? "—"}
  notes: ${line.audit_notes ?? "(none)"}

ACTUAL SURCHARGES ON INVOICE:
${actualSurcharges.length === 0 ? "  (none)" : JSON.stringify(actualSurcharges, null, 2)}

EXPECTED SURCHARGES (per-code verification):
${expectedSurcharges.length === 0 ? "  (none)" : JSON.stringify(expectedSurcharges, null, 2)}

CONTRACT SURCHARGE RULES:
${addonsBlock || "  (none)"}

${engineExplanation}`;

  const client = new Anthropic();

  const anthroMessages: Anthropic.MessageParam[] = [
    { role: "user", content: `Here is the full context for the line we're debugging:\n\n${context}` },
    { role: "assistant", content: "Context received. Ask your question." },
    ...messages.map<Anthropic.MessageParam>((m) => ({ role: m.role, content: m.content })),
  ];

  const stream = client.messages.stream({
    model: "claude-opus-4-7",
    max_tokens: 4000,
    thinking: { type: "adaptive", display: "omitted" },
    system: SYSTEM_PROMPT,
    messages: anthroMessages,
  });

  const final = await stream.finalMessage();
  const textBlock = final.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new Error(`Debug: no text block (stop_reason=${final.stop_reason})`);
  return { reply: textBlock.text };
}

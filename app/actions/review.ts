"use server";

import Anthropic from "@anthropic-ai/sdk";
import { revalidatePath } from "next/cache";
import { db } from "../lib/db";

export type ReviewStatus = "correct" | "valid_claim" | "dispute" | "other";

export async function setReviewStatus(lineId: number, status: ReviewStatus | null, reviewer?: string): Promise<void> {
  const data: { review_status: string | null; reviewed_at: Date | null; reviewer?: string | null } = {
    review_status: status,
    reviewed_at: status ? new Date() : null,
  };
  if (reviewer !== undefined) data.reviewer = reviewer || null;
  await db.invoiceLine.update({ where: { id: lineId }, data });
  const inv = await db.invoiceLine.findUnique({ where: { id: lineId }, select: { invoiceId: true } });
  if (inv) revalidatePath(`/invoices/${inv.invoiceId}`);
}

export async function setReviewNotes(lineId: number, notes: string): Promise<void> {
  await db.invoiceLine.update({ where: { id: lineId }, data: { review_notes: notes || null } });
  const inv = await db.invoiceLine.findUnique({ where: { id: lineId }, select: { invoiceId: true } });
  if (inv) revalidatePath(`/invoices/${inv.invoiceId}`);
}

export interface ChatMessageDTO {
  id: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export async function getChatHistory(lineId: number): Promise<ChatMessageDTO[]> {
  const rows = await db.lineMessage.findMany({
    where: { lineId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({ id: r.id, role: r.role as "user" | "assistant", content: r.content, createdAt: r.createdAt.toISOString() }));
}

// Builds the structured context Claude needs to reason about a single audit line:
// shipment params + the contract's rules for that product + audit verdict + history.
async function buildLineContext(lineId: number): Promise<string> {
  const line = await db.invoiceLine.findUnique({
    where: { id: lineId },
    include: {
      invoice: {
        select: {
          invoice_number: true, invoice_date: true, invoice_type: true, currency: true,
          contract: {
            select: {
              id: true, name: true, carrier: true, billing_country: true, currency_code: true,
              fuel_multiplier: true,
              addons: { select: { code: true, name: true, kind: true, amount: true, min_amount: true, applies_to: true } },
            },
          },
        },
      },
    },
  });
  if (!line) throw new Error("Line not found");

  const surchargesActual = line.surcharges_json ? JSON.parse(line.surcharges_json) : [];
  const expSurcharges = line.expected_surcharges_json ? JSON.parse(line.expected_surcharges_json) : [];
  const matchedBand = line.matched_band_json ? JSON.parse(line.matched_band_json) : null;
  const contract = line.invoice?.contract;

  const parts: string[] = [];
  parts.push(`# Shipment line under review\n`);
  parts.push(`Invoice: ${line.invoice?.invoice_number} (${line.invoice?.invoice_type}, ${line.invoice?.invoice_date}, ${line.invoice?.currency})`);
  parts.push(`Shipment: ${line.shipment_number ?? "?"} on ${line.shipment_date ?? "?"}`);
  parts.push(`Product: ${line.product_code ?? "?"} ${line.product_name ?? ""}`);
  parts.push(`Route: ${line.origin_country ?? "?"} → ${line.dest_country ?? "?"} · matched zone ${line.matched_zone ?? "—"}`);
  parts.push(`Weight: ${line.weight_kg ?? "?"} kg (flag ${line.weight_flag ?? "?"})${line.declared_value != null ? ` · declared value ${line.declared_value}` : ""}`);
  parts.push(`Matched product/sub-product: ${line.matched_product ?? "—"} / ${line.matched_sub_product ?? "—"}`);
  if (matchedBand) parts.push(`Matched band: ${JSON.stringify(matchedBand)}`);
  parts.push(``);
  parts.push(`## Audit verdict`);
  parts.push(`Status: **${line.audit_status ?? "unresolved"}** · weight charge billed €${line.weight_charge?.toFixed(2) ?? "?"} vs expected €${line.expected_weight_charge?.toFixed(2) ?? "?"}`);
  parts.push(`Total billed €${line.charged_amount?.toFixed(2) ?? "?"} vs expected €${line.expected_amount?.toFixed(2) ?? "?"} → delta €${line.delta?.toFixed(2) ?? "?"}`);
  if (line.audit_notes) parts.push(`Audit notes: ${line.audit_notes}`);
  parts.push(``);
  parts.push(`## Surcharges (actual vs expected)`);
  for (const s of expSurcharges as { code: string; name: string; expected: number; actual: number; delta: number; status: string }[]) {
    parts.push(`- ${s.code} ${s.name}: billed €${Number(s.actual).toFixed(2)} · expected €${Number(s.expected).toFixed(2)} · Δ €${Number(s.delta).toFixed(2)} · ${s.status}`);
  }
  for (const s of surchargesActual as { code: string; name: string; charge: number }[]) {
    if (!expSurcharges.some((e: { code: string }) => e.code === s.code)) {
      parts.push(`- ${s.code} ${s.name}: billed €${Number(s.charge).toFixed(2)} · NOT IN CONTRACT`);
    }
  }
  parts.push(``);
  if (contract) {
    parts.push(`## Contract: ${contract.name} (${contract.carrier}/${contract.billing_country}, currency ${contract.currency_code}, fuel multiplier ${contract.fuel_multiplier ?? 1})`);
    const relevant = contract.addons.filter((a) =>
      surchargesActual.some((s: { code: string }) => s.code === a.code) ||
      expSurcharges.some((e: { code: string }) => e.code === a.code) ||
      ["FF", "DD", "WC"].includes(a.code),
    );
    parts.push(`Relevant surcharge rules:`);
    for (const a of relevant) {
      parts.push(`  - ${a.code} ${a.name}: kind=${a.kind} amount=${a.amount ?? "—"} min=${a.min_amount ?? "—"} scope=${a.applies_to}`);
    }
  }
  return parts.join("\n");
}

const SYSTEM_PROMPT = `You are the audit copilot for a freight-cost auditor at Senvo. The user is a colleague reviewing a single shipment line where the audit engine flagged a discrepancy. Your job: explain what likely happened, what to check next, and recommend a verdict (correct billing / valid claim against the carrier / dispute / other / needs more data).

Style: terse, direct, expert. Use Markdown lightly. Cite specific euro amounts and codes from the context. Don't speculate beyond the data — if you don't know, say so. If the gap is fully explained by an upstream cascade or wrong-rate-card, say which.

When the colleague asks a question, ground your answer in the line's audit context (the system prompt is appended below). If they ask about general DHL rules, draw on what the rate engine encodes (canonical surcharge codes, fuel multipliers, per-kg-with-min, percent_of_taxes, etc.).`;

export async function sendChatMessage(lineId: number, content: string): Promise<{ reply: string }> {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Message cannot be empty");
  await db.lineMessage.create({ data: { lineId, role: "user", content: trimmed } });

  const history = await getChatHistory(lineId);
  const context = await buildLineContext(lineId);
  const client = new Anthropic();

  // Build the messages list. The first turn after our context block is the
  // colleague's first question; subsequent turns alternate.
  const messages: Anthropic.MessageParam[] = [];
  // Prepend the context as the first user message so Claude has it before any chat.
  if (history.length === 1) {
    // First message in this conversation — include the full context.
    messages.push({ role: "user", content: `${context}\n\n---\n\nReviewer says: ${trimmed}` });
  } else {
    // Continuing a conversation — context is implicit from prior turns.
    for (const m of history) {
      messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
    }
  }

  const stream = client.messages.stream({
    model: "claude-opus-4-7",
    max_tokens: 4000,
    thinking: { type: "disabled" },
    system: SYSTEM_PROMPT,
    messages,
  });
  const final = await stream.finalMessage();
  const textBlock = final.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  const reply = textBlock?.text ?? "(no response)";

  await db.lineMessage.create({ data: { lineId, role: "assistant", content: reply } });
  const inv = await db.invoiceLine.findUnique({ where: { id: lineId }, select: { invoiceId: true } });
  if (inv) revalidatePath(`/invoices/${inv.invoiceId}`);
  return { reply };
}

// Generate an initial AI suggestion for the reviewer when they first open the
// chat for a line. Persists as the first assistant message.
export async function getInitialSuggestion(lineId: number): Promise<string> {
  const existing = await db.lineMessage.findFirst({ where: { lineId } });
  if (existing) {
    const history = await getChatHistory(lineId);
    return history[0].content;
  }
  const context = await buildLineContext(lineId);
  const client = new Anthropic();
  const stream = client.messages.stream({
    model: "claude-opus-4-7",
    max_tokens: 2000,
    thinking: { type: "disabled" },
    system: SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `${context}\n\n---\n\nGive me a brief opening assessment of this shipment: (1) what likely happened, (2) what to check next, (3) recommended verdict (correct / valid_claim / dispute / other / needs more data). Keep it under 200 words.`,
    }],
  });
  const final = await stream.finalMessage();
  const textBlock = final.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  const reply = textBlock?.text ?? "(no response)";
  await db.lineMessage.create({ data: { lineId, role: "assistant", content: reply } });
  const inv = await db.invoiceLine.findUnique({ where: { id: lineId }, select: { invoiceId: true } });
  if (inv) revalidatePath(`/invoices/${inv.invoiceId}`);
  return reply;
}

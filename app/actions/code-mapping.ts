"use server";

import { revalidatePath } from "next/cache";
import { db } from "../lib/db";

// Re-attach an existing contract Surcharge to a different billing code
// (typically invoice-driven, e.g. "OO" or "CA"). The audit re-resolves on its
// next run.
export async function setSurchargeCode(contractId: number, surchargeId: number, newCode: string): Promise<void> {
  const code = newCode.trim();
  if (!code) throw new Error("New code cannot be empty.");
  const sibling = await db.surcharge.findFirst({
    where: { contractId, code, NOT: { id: surchargeId } },
    select: { id: true, name: true, applies_to: true },
  });
  const target = await db.surcharge.findUnique({ where: { id: surchargeId }, select: { applies_to: true } });
  if (sibling && sibling.applies_to === target?.applies_to) {
    throw new Error(`Contract already has another rule with code '${code}' and the same scope (${sibling.name}). Differentiate scopes first.`);
  }
  await db.surcharge.update({ where: { id: surchargeId }, data: { code } });
  revalidatePath(`/contracts/${contractId}`);
  revalidatePath(`/code-mapping`);
}

// Create a new contract Surcharge directly from an unresolved invoice code.
// Useful when the contract genuinely has no rule for what was billed.
export async function createSurchargeFromCode(
  contractId: number,
  data: { code: string; name: string; kind: "flat" | "per_kg" | "per_shipment" | "percent"; amount: number | null; min_amount?: number | null; applies_to?: "any" | "domestic" | "international" },
): Promise<void> {
  await db.surcharge.create({
    data: {
      contractId,
      code: data.code.trim(),
      name: data.name.trim(),
      kind: data.kind,
      amount: data.amount,
      min_amount: data.min_amount ?? null,
      applies_to: data.applies_to ?? "any",
    },
  });
  revalidatePath(`/contracts/${contractId}`);
  revalidatePath(`/code-mapping`);
}

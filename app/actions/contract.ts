"use server";

import { db } from "../lib/db";
import { revalidatePath } from "next/cache";
import type { PriceBandDTO } from "../lib/types";

export async function updateContract(id: number, patch: Partial<{
  name: string;
  carrier: string;
  billing_country: string;
  currency_code: string;
  volumetric_divisor: number;
  fuel_multiplier: number;
  valid_from: string;
  valid_until: string;
}>) {
  await db.contract.update({ where: { id }, data: patch });
  revalidatePath("/");
  revalidatePath(`/contracts/${id}`);
}

export async function addProduct(contractId: number, name: string) {
  const count = await db.freightProduct.count({ where: { contractId } });
  await db.freightProduct.create({
    data: { contractId, name, order: count },
  });
  revalidatePath(`/contracts/${contractId}`);
}

export async function updateProduct(
  contractId: number,
  productId: number,
  patch: Partial<{ name: string; zone_group: string }>,
) {
  await db.freightProduct.update({ where: { id: productId }, data: patch });
  revalidatePath(`/contracts/${contractId}`);
}

export async function removeProduct(contractId: number, productId: number) {
  await db.freightProduct.delete({ where: { id: productId } });
  revalidatePath(`/contracts/${contractId}`);
}

export async function addSubProduct(contractId: number, productId: number, name: string) {
  const existing = await db.subProduct.findMany({ where: { productId }, include: { bands: true } });
  const zones = new Set<string>();
  for (const sp of existing) for (const b of sp.bands) zones.add(b.zone);
  const order = existing.length;
  await db.subProduct.create({
    data: {
      productId,
      name,
      order,
    },
  });
  revalidatePath(`/contracts/${contractId}`);
  void zones;
}

export async function updateSubProduct(
  contractId: number,
  subId: number,
  patch: Partial<{ name: string; description: string | null; codes: string | null }>,
) {
  await db.subProduct.update({ where: { id: subId }, data: patch });
  revalidatePath(`/contracts/${contractId}`);
}

export async function removeSubProduct(contractId: number, subId: number) {
  await db.subProduct.delete({ where: { id: subId } });
  revalidatePath(`/contracts/${contractId}`);
}

export async function setZoneBands(
  contractId: number,
  subId: number,
  zone: string,
  bands: PriceBandDTO[],
) {
  await db.$transaction(async (tx) => {
    await tx.priceBand.deleteMany({ where: { subProductId: subId, zone } });
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      await tx.priceBand.create({
        data: {
          subProductId: subId,
          zone,
          order: i,
          weight_start: b.weight_start,
          weight_end: "weight_end" in b ? b.weight_end : null,
          price: "price" in b ? b.price : null,
          per_kg: "per_kg" in b ? b.per_kg : null,
          step: "step" in b ? b.step ?? null : null,
          confidence: b.confidence ?? null,
        },
      });
    }
  });
  revalidatePath(`/contracts/${contractId}`);
}

export async function setBulkBands(
  contractId: number,
  subId: number,
  byZone: Record<string, PriceBandDTO[]>,
) {
  await db.$transaction(async (tx) => {
    await tx.priceBand.deleteMany({ where: { subProductId: subId } });
    for (const [zone, bands] of Object.entries(byZone)) {
      for (let i = 0; i < bands.length; i++) {
        const b = bands[i];
        await tx.priceBand.create({
          data: {
            subProductId: subId,
            zone,
            order: i,
            weight_start: b.weight_start,
            weight_end: "weight_end" in b ? b.weight_end : null,
            price: "price" in b ? b.price : null,
            per_kg: "per_kg" in b ? b.per_kg : null,
            step: "step" in b ? b.step ?? null : null,
            confidence: b.confidence ?? null,
          },
        });
      }
    }
  });
  revalidatePath(`/contracts/${contractId}`);
}

export async function addAddon(contractId: number, entry: { code: string; name: string; kind: string; amount?: number | null; min_amount?: number | null; applies_to?: string }) {
  await db.surcharge.create({ data: { contractId, ...entry } });
  revalidatePath(`/contracts/${contractId}`);
}

export async function updateAddon(contractId: number, id: number, patch: Partial<{ code: string; name: string; kind: string; amount: number | null; min_amount: number | null; applies_to: string }>) {
  await db.surcharge.update({ where: { id }, data: patch });
  revalidatePath(`/contracts/${contractId}`);
}

export async function removeAddon(contractId: number, id: number) {
  await db.surcharge.delete({ where: { id } });
  revalidatePath(`/contracts/${contractId}`);
}

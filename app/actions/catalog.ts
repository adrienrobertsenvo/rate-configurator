"use server";

import { db } from "../lib/db";
import { revalidatePath } from "next/cache";

export async function addCatalogProduct(entry: {
  carrier: string;
  code: string;
  product_name: string;
  sub_product_name: string;
  direction?: string;
}) {
  const direction = entry.direction ?? "any";
  await db.catalogProduct.upsert({
    where: { carrier_code_direction: { carrier: entry.carrier, code: entry.code, direction } },
    update: { product_name: entry.product_name, sub_product_name: entry.sub_product_name },
    create: { ...entry, direction },
  });
  revalidatePath("/catalog");
}

export async function removeCatalogProduct(carrier: string, code: string, direction: string) {
  await db.catalogProduct.delete({
    where: { carrier_code_direction: { carrier, code, direction } },
  });
  revalidatePath("/catalog");
}

export async function setTaxRate(entry: {
  carrier: string;
  code: string;
  rate: number;
  description: string | null;
}) {
  await db.taxRate.upsert({
    where: { carrier_code: { carrier: entry.carrier, code: entry.code } },
    update: { rate: entry.rate, description: entry.description },
    create: entry,
  });
  revalidatePath("/catalog");
}

export async function removeTaxRate(carrier: string, code: string) {
  await db.taxRate.delete({ where: { carrier_code: { carrier, code } } });
  revalidatePath("/catalog");
}

export async function addCatalogSurcharge(entry: { carrier: string; code: string; name: string; kind: string }) {
  await db.catalogSurcharge.upsert({
    where: { carrier_code: { carrier: entry.carrier, code: entry.code } },
    update: { name: entry.name, kind: entry.kind },
    create: entry,
  });
  revalidatePath("/catalog");
}

export async function removeCatalogSurcharge(carrier: string, code: string) {
  await db.catalogSurcharge.delete({ where: { carrier_code: { carrier, code } } });
  revalidatePath("/catalog");
}

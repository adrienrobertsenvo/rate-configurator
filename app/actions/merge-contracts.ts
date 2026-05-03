"use server";

import { revalidatePath } from "next/cache";
import { db } from "../lib/db";

// Merge `secondaryId` into `primaryId`:
//   - For each freight product on the secondary: if the primary already has a
//     product with the same name, append any sub-products that aren't already
//     present (with all their bands). If the sub-product name already exists,
//     skip it (we don't merge bands — that's an editorial decision the user
//     should make manually).
//   - Surcharges: append any whose code isn't already in the primary's addons.
//   - Source documents and invoices are reattached to the primary.
//   - The secondary contract is then deleted.
export async function mergeContracts(primaryId: number, secondaryId: number): Promise<{ added_products: number; added_subs: number; skipped_subs: number; added_surcharges: number; moved_sources: number; moved_invoices: number }> {
  if (primaryId === secondaryId) throw new Error("Cannot merge a contract into itself.");
  const [primary, secondary] = await Promise.all([
    db.contract.findUnique({
      where: { id: primaryId },
      include: { freight: { include: { sub_products: { include: { bands: true } } } }, addons: true },
    }),
    db.contract.findUnique({
      where: { id: secondaryId },
      include: { freight: { include: { sub_products: { include: { bands: true } } } }, addons: true },
    }),
  ]);
  if (!primary) throw new Error(`Primary contract ${primaryId} not found`);
  if (!secondary) throw new Error(`Secondary contract ${secondaryId} not found`);
  if (primary.carrier !== secondary.carrier) {
    throw new Error(`Carrier mismatch — refusing to merge ${primary.carrier} with ${secondary.carrier}`);
  }
  if (primary.billing_country !== secondary.billing_country) {
    throw new Error(
      `Billing country mismatch — refusing to merge a ${primary.billing_country} contract with a ${secondary.billing_country} one. Country-specific contracts stay separate even when they share a customer.`,
    );
  }
  // Customer-key guard: refuse to merge contracts that look like they belong
  // to different customers, or that involve a carrier base-rate contract.
  const keyOf = (n: string) =>
    n.replace(/^DHL Express Germany\s*[—–-]\s*/i, "")
     .replace(/\s*(Worldwide & Economy\s+)?(Ratecard|Rates)\b.*$/i, "")
     .replace(/\s+\d{4}\s*$/i, "")
     .trim()
     .toLowerCase();
  const isBase = (n: string) => {
    const k = keyOf(n);
    return k === "" || k === "standard" || /\bbase\s*rate(s)?\b/i.test(n);
  };
  if (isBase(primary.name) || isBase(secondary.name)) {
    throw new Error("Refusing to merge: one of the contracts is a carrier base-rate contract.");
  }
  if (keyOf(primary.name) !== keyOf(secondary.name)) {
    throw new Error(`Refusing to merge: contracts appear to be for different customers ('${keyOf(primary.name)}' vs '${keyOf(secondary.name)}').`);
  }

  const primaryProductByName = new Map(primary.freight.map((p) => [p.name, p]));
  let addedProducts = 0;
  let addedSubs = 0;
  let skippedSubs = 0;

  for (const sp of secondary.freight) {
    const target = primaryProductByName.get(sp.name);
    if (!target) {
      // Whole product is new — create on primary, copying sub-products and bands.
      const created = await db.freightProduct.create({
        data: {
          contractId: primary.id,
          name: sp.name,
          price_structure: sp.price_structure,
          zone_group: sp.zone_group,
          order: primary.freight.length + addedProducts,
        },
        select: { id: true },
      });
      addedProducts++;
      for (const sub of sp.sub_products) {
        const newSub = await db.subProduct.create({
          data: {
            productId: created.id,
            name: sub.name,
            description: sub.description,
            codes: sub.codes,
            order: sub.order,
          },
          select: { id: true },
        });
        for (const b of sub.bands) {
          await db.priceBand.create({
            data: {
              subProductId: newSub.id,
              zone: b.zone,
              order: b.order,
              weight_start: b.weight_start,
              weight_end: b.weight_end,
              price: b.price,
              per_kg: b.per_kg,
              step: b.step,
              confidence: b.confidence,
            },
          });
        }
      }
      continue;
    }
    // Product name exists on primary — copy missing sub-products, skip duplicates.
    const existingSubNames = new Set(target.sub_products.map((s) => s.name));
    for (const sub of sp.sub_products) {
      if (existingSubNames.has(sub.name)) {
        skippedSubs++;
        continue;
      }
      const newSub = await db.subProduct.create({
        data: {
          productId: target.id,
          name: sub.name,
          description: sub.description,
          codes: sub.codes,
          order: target.sub_products.length + addedSubs,
        },
        select: { id: true },
      });
      addedSubs++;
      for (const b of sub.bands) {
        await db.priceBand.create({
          data: {
            subProductId: newSub.id,
            zone: b.zone,
            order: b.order,
            weight_start: b.weight_start,
            weight_end: b.weight_end,
            price: b.price,
            per_kg: b.per_kg,
            step: b.step,
            confidence: b.confidence,
          },
        });
      }
    }
  }

  // Surcharges
  const primaryCodes = new Set(primary.addons.map((a) => a.code));
  let addedSurcharges = 0;
  for (const a of secondary.addons) {
    if (primaryCodes.has(a.code)) continue;
    await db.surcharge.create({
      data: {
        contractId: primary.id,
        code: a.code,
        name: a.name,
        kind: a.kind,
        amount: a.amount,
        description: a.description,
      },
    });
    addedSurcharges++;
  }

  // Move source documents
  const movedSources = await db.contractSource.updateMany({
    where: { contractId: secondary.id },
    data: { contractId: primary.id },
  });

  // Move invoices (so any audit history follows)
  const movedInvoices = await db.invoice.updateMany({
    where: { contractId: secondary.id },
    data: { contractId: primary.id },
  });

  // Move zone-map overrides keyed to the secondary
  await db.zoneMap.updateMany({
    where: { contractId: secondary.id },
    data: { contractId: primary.id },
  });

  // Delete the now-empty secondary
  await db.contract.delete({ where: { id: secondary.id } });

  revalidatePath("/");
  revalidatePath(`/contracts/${primary.id}`);

  return {
    added_products: addedProducts,
    added_subs: addedSubs,
    skipped_subs: skippedSubs,
    added_surcharges: addedSurcharges,
    moved_sources: movedSources.count,
    moved_invoices: movedInvoices.count,
  };
}

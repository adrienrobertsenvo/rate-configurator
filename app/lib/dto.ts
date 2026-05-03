import type {
  ContractModel,
  FreightProductModel,
  SubProductModel,
  PriceBandModel,
  SurchargeModel,
} from "../generated/prisma/models";
import type {
  ContractDTO,
  FreightProductDTO,
  SubProductDTO,
  ZonePrices,
  SurchargeDTO,
  PriceBandDTO,
  SurchargeKind,
} from "./types";

type Loaded = ContractModel & {
  freight: (FreightProductModel & {
    sub_products: (SubProductModel & { bands: PriceBandModel[] })[];
  })[];
  addons: SurchargeModel[];
};

export function contractToDto(c: Loaded): ContractDTO {
  return {
    id: c.id,
    name: c.name,
    carrier: c.carrier,
    billing_country: c.billing_country,
    currency_code: c.currency_code,
    fuel_multiplier: c.fuel_multiplier ?? 1,
    weight_unit: "kg",
    volumetric_divisor: c.volumetric_divisor,
    valid_from: c.valid_from,
    valid_until: c.valid_until,
    freight: [...c.freight]
      .sort((a, b) => a.order - b.order)
      .map<FreightProductDTO>((p) => ({
        id: p.id,
        name: p.name,
        zone_group: p.zone_group,
        price_structure: (p.price_structure.split(",") as ["zone", "weight"]) ?? ["zone", "weight"],
        sub_products: [...p.sub_products]
          .sort((a, b) => a.order - b.order)
          .map<SubProductDTO>((sp) => ({
            id: sp.id,
            name: sp.name,
            description: sp.description,
            codes: sp.codes,
            prices: bandsToZonePrices(sp.bands),
          })),
      })),
    addons: c.addons.map<SurchargeDTO>((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      kind: s.kind as SurchargeKind,
      amount: s.amount,
      min_amount: s.min_amount,
      applies_to: (s.applies_to as "any" | "domestic" | "international") ?? "any",
      description: s.description,
    })),
  };
}

function bandsToZonePrices(bands: PriceBandModel[]): ZonePrices {
  const byZone: ZonePrices = {};
  for (const b of bands) {
    if (!byZone[b.zone]) byZone[b.zone] = [];
  }
  const sorted = [...bands].sort((a, b) => a.order - b.order || a.weight_start - b.weight_start);
  for (const b of sorted) {
    const band: PriceBandDTO =
      b.weight_end != null && b.price != null
        ? { weight_start: b.weight_start, weight_end: b.weight_end, price: b.price, confidence: b.confidence }
        : { weight_start: b.weight_start, per_kg: b.per_kg ?? 0, step: b.step, confidence: b.confidence };
    byZone[b.zone].push(band);
  }
  return byZone;
}

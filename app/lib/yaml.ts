import yaml from "js-yaml";
import type { ContractDTO, PriceBandDTO } from "./types";

function pruneBand(b: PriceBandDTO) {
  const { confidence: _c, ...rest } = b as PriceBandDTO & { confidence?: number | null };
  void _c;
  if ("step" in rest && rest.step == null) {
    const { step: _s, ...r } = rest;
    void _s;
    return r;
  }
  return rest;
}

export function contractToYaml(c: ContractDTO): string {
  const doc = {
    carrier: c.carrier,
    billing_country: c.billing_country,
    currency_code: c.currency_code,
    weight_unit: c.weight_unit,
    volumetric_divisor: c.volumetric_divisor,
    valid_from: c.valid_from,
    valid_until: c.valid_until,
    freight: c.freight.map((p) => ({
      name: p.name,
      "price-structure": p.price_structure,
      sub_products: p.sub_products.map((sp) => {
        const codes = sp.codes ? sp.codes.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
        const out: Record<string, unknown> = {
          name: sp.name,
        };
        if (sp.description) out.description = sp.description;
        if (codes && codes.length === 1) out.code = codes[0];
        else if (codes && codes.length > 1) out.code = codes;
        const prices: Record<string, unknown[]> = {};
        for (const [zone, bands] of Object.entries(sp.prices)) {
          prices[zone] = bands.map(pruneBand);
        }
        out.prices = prices;
        return out;
      }),
    })),
    addons: c.addons.map((a) => {
      const out: Record<string, unknown> = { code: a.code, name: a.name, kind: a.kind };
      if (a.amount != null) out.amount = a.amount;
      if (a.description) out.description = a.description;
      return out;
    }),
  };
  return yaml.dump(doc, { lineWidth: 120, noRefs: true });
}

export function zoneMapToYaml(z: {
  carrier: string;
  valid_from: string;
  spec_name: string;
  currency_code: string;
  billing_country: string;
  zone_group: string;
  countries: { country: string; zone: number }[];
}): string {
  const countries: Record<string, { zones: number[] }> = {};
  for (const c of z.countries) countries[c.country] = { zones: [c.zone] };
  return yaml.dump(
    {
      carrier: z.carrier,
      billing_country: z.billing_country,
      zone_group: z.zone_group,
      valid_from: z.valid_from,
      spec_name: z.spec_name,
      currency_code: z.currency_code,
      countries,
    },
    { lineWidth: 120, noRefs: true },
  );
}

export function catalogToYaml(c: {
  carrier: string;
  products: { code: string; product_name: string; sub_product_name: string }[];
  surcharges: { code: string; name: string; kind: string }[];
}): string {
  return yaml.dump(c, { lineWidth: 120, noRefs: true });
}

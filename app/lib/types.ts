export type PriceBandDTO =
  | { weight_start: number; weight_end: number; price: number; confidence?: number | null }
  | { weight_start: number; per_kg: number; step?: number | null; confidence?: number | null };

export type ZonePrices = Record<string, PriceBandDTO[]>;

export interface SubProductDTO {
  id: number;
  name: string;
  description?: string | null;
  codes?: string | null;
  prices: ZonePrices;
}

export interface FreightProductDTO {
  id: number;
  name: string;
  zone_group: string;
  price_structure: ["zone", "weight"] | ["weight", "zone"];
  sub_products: SubProductDTO[];
}

export type SurchargeKind = "flat" | "per_kg" | "per_shipment" | "percent" | "percent_of_value" | "percent_of_taxes";

export interface SurchargeDTO {
  id: number;
  code: string;
  name: string;
  kind: SurchargeKind;
  amount?: number | null;
  min_amount?: number | null;
  applies_to?: "any" | "domestic" | "international";
  description?: string | null;
}

export interface ContractDTO {
  id: number;
  name: string;
  carrier: string;
  billing_country: string;
  currency_code: string;
  weight_unit: "kg";
  volumetric_divisor: number;
  fuel_multiplier?: number;
  valid_from: string;
  valid_until: string;
  freight: FreightProductDTO[];
  addons: SurchargeDTO[];
}

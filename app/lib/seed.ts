import { db } from "./db";

export async function ensureSeed() {
  const existing = await db.contract.count();
  if (existing > 0) return;
  await seedDhlExpressDe();
}

export async function seedDhlExpressDe() {
  const contract = await db.contract.create({
    data: {
      name: "DHL Express Germany — Standard",
      carrier: "DHL-EXPRESS-DE",
      billing_country: "DE",
      currency_code: "EUR",
      volumetric_divisor: 5000,
      valid_from: "2025-01-01",
      valid_until: "2025-12-31",
      freight: {
        create: [
          {
            name: "Express Worldwide Export",
            zone_group: "worldwide",
            order: 0,
            sub_products: {
              create: [
                { name: "Envelope", description: "bis 300g", order: 0 },
                { name: "Document", description: "Zollfrei Dokument bis 2.0 KG", order: 1 },
                { name: "Package", description: "Warensendung / Dokument ab 2.5 KG", codes: "S,U", order: 2 },
              ],
            },
          },
          {
            name: "Express Worldwide Import",
            zone_group: "worldwide",
            order: 1,
            sub_products: {
              create: [
                { name: "Envelope", description: "bis 300g", order: 0 },
                { name: "Document", description: "Zollfrei Dokument bis 2.0 KG", order: 1 },
                { name: "Package", description: "Warensendung / Dokument ab 2.5 KG", order: 2 },
              ],
            },
          },
          {
            name: "Economy Select Export",
            zone_group: "economy",
            order: 2,
            sub_products: { create: [{ name: "Package", description: "Economy Select", order: 0 }] },
          },
          {
            name: "Economy Select Import",
            zone_group: "economy",
            order: 3,
            sub_products: { create: [{ name: "Package", description: "Economy Select", order: 0 }] },
          },
          {
            name: "Express Domestic",
            zone_group: "domestic",
            order: 4,
            sub_products: { create: [{ name: "Package", description: "0.5 KG Express 18:00", codes: "E", order: 0 }] },
          },
          {
            name: "Express 12:00 (Document)",
            zone_group: "worldwide",
            order: 5,
            sub_products: { create: [{ name: "Document", description: "12:00 timed delivery (doc)", codes: "T", order: 0 }] },
          },
        ],
      },
      addons: {
        create: [
          { code: "FF", name: "Fuel Surcharge", kind: "percent" },
          { code: "MA", name: "Address Correction", kind: "flat", amount: 11 },
          { code: "CA", name: "Elevated Risk", kind: "flat", amount: 30 },
          { code: "YB", name: "Oversize Piece", kind: "flat", amount: 20 },
          { code: "NX", name: "Demand Surcharge", kind: "per_kg" },
          { code: "OO", name: "Remote Area Delivery", kind: "flat" },
          { code: "RD", name: "Toll Surcharge", kind: "per_shipment" },
          { code: "YK", name: "Premium 12:00", kind: "flat" },
          { code: "PREMIUM_9", name: "Premium 9:00", kind: "flat", amount: 35 },
          { code: "PREMIUM_1030", name: "Premium 10:30", kind: "flat", amount: 15 },
        ],
      },
    },
  });

  await db.zoneMap.createMany({
    data: [
      {
        carrier: "DHL-EXPRESS-DE",
        billing_country: "DE",
        zone_group: "worldwide",
        spec_name: "DHL Express Worldwide (DE baseline)",
        valid_from: "2025-01-01",
        currency_code: "EUR",
      },
      {
        carrier: "DHL-EXPRESS-DE",
        billing_country: "DE",
        zone_group: "economy",
        spec_name: "DHL Economy Select (DE baseline)",
        valid_from: "2025-01-01",
        currency_code: "EUR",
      },
      {
        carrier: "DHL-EXPRESS-DE",
        billing_country: "DE",
        zone_group: "domestic",
        spec_name: "DHL Express Domestic (DE)",
        valid_from: "2025-01-01",
        currency_code: "EUR",
      },
    ],
  });

  await db.catalogProduct.createMany({
    data: [
      { carrier: "DHL-EXPRESS-DE", code: "S", product_name: "Express Worldwide Export", sub_product_name: "Package" },
      { carrier: "DHL-EXPRESS-DE", code: "U", product_name: "Express Worldwide Export", sub_product_name: "Package" },
      { carrier: "DHL-EXPRESS-DE", code: "E", product_name: "Express Domestic", sub_product_name: "Package" },
      { carrier: "DHL-EXPRESS-DE", code: "P", product_name: "Express Worldwide Export", sub_product_name: "Package" },
      { carrier: "DHL-EXPRESS-DE", code: "T", product_name: "Express Worldwide Export", sub_product_name: "Document" },
      { carrier: "DHL-EXPRESS-DE", code: "V", product_name: "Economy Select Export", sub_product_name: "Package" },
      { carrier: "DHL-EXPRESS-DE", code: "N", product_name: "Economy Select Export", sub_product_name: "Package" },
      { carrier: "DHL-EXPRESS-DE", code: "Y", product_name: "Express Worldwide Export", sub_product_name: "Package" },
      { carrier: "DHL-EXPRESS-DE", code: "Z", product_name: "Duties & Taxes (pass-through)", sub_product_name: "—" },
    ],
  });

  await db.catalogSurcharge.createMany({
    data: [
      { carrier: "DHL-EXPRESS-DE", code: "FF", name: "Fuel Surcharge", kind: "percent" },
      { carrier: "DHL-EXPRESS-DE", code: "MA", name: "Address Correction", kind: "flat" },
      { carrier: "DHL-EXPRESS-DE", code: "CA", name: "Elevated Risk", kind: "flat" },
      { carrier: "DHL-EXPRESS-DE", code: "YB", name: "Oversize Piece", kind: "flat" },
      { carrier: "DHL-EXPRESS-DE", code: "NX", name: "Demand Surcharge", kind: "per_kg" },
      { carrier: "DHL-EXPRESS-DE", code: "OO", name: "Remote Area Delivery", kind: "flat" },
      { carrier: "DHL-EXPRESS-DE", code: "RD", name: "Toll Surcharge", kind: "per_shipment" },
      { carrier: "DHL-EXPRESS-DE", code: "YK", name: "Premium 12:00", kind: "flat" },
      { carrier: "DHL-EXPRESS-DE", code: "DD", name: "Duty Tax Paid", kind: "flat" },
      { carrier: "DHL-EXPRESS-DE", code: "XB", name: "Import Export Taxes", kind: "flat" },
      { carrier: "DHL-EXPRESS-DE", code: "XE", name: "Merchandise Process", kind: "flat" },
      { carrier: "DHL-EXPRESS-DE", code: "XK", name: "Regulatory Charges", kind: "flat" },
      { carrier: "DHL-EXPRESS-DE", code: "XX", name: "Import Export Duties", kind: "flat" },
      { carrier: "DHL-EXPRESS-DE", code: "YL", name: "Non-Conveyable Piece / Irregular", kind: "flat" },
      { carrier: "DHL-EXPRESS-DE", code: "YO", name: "Non-Conveyable Piece — Weight", kind: "flat" },
      { carrier: "DHL-EXPRESS-DE", code: "XS", name: "Excise Tax", kind: "flat" },
    ],
  });

  return contract;
}

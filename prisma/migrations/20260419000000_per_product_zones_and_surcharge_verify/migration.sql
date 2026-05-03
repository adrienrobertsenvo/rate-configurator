-- Per-product zoning + surcharge verification

PRAGMA foreign_keys=OFF;

-- Rebuild ZoneMap: rename product_name → zone_group, add billing_country + contractId
CREATE TABLE "new_ZoneMap" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "carrier" TEXT NOT NULL,
    "billing_country" TEXT NOT NULL DEFAULT 'DE',
    "zone_group" TEXT NOT NULL DEFAULT 'default',
    "contractId" INTEGER,
    "spec_name" TEXT NOT NULL,
    "valid_from" TEXT NOT NULL,
    "currency_code" TEXT NOT NULL DEFAULT 'EUR',
    CONSTRAINT "ZoneMap_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_ZoneMap" ("id", "carrier", "billing_country", "zone_group", "contractId", "spec_name", "valid_from", "currency_code")
SELECT "id", "carrier", 'DE', 'worldwide', NULL, "spec_name", "valid_from", "currency_code"
FROM "ZoneMap";

DROP TABLE "ZoneMap";
ALTER TABLE "new_ZoneMap" RENAME TO "ZoneMap";

CREATE UNIQUE INDEX "ZoneMap_carrier_billing_country_zone_group_contractId_key"
    ON "ZoneMap"("carrier", "billing_country", "zone_group", "contractId");
CREATE INDEX "ZoneMap_carrier_billing_country_idx" ON "ZoneMap"("carrier", "billing_country");
CREATE INDEX "ZoneMap_contractId_idx" ON "ZoneMap"("contractId");

-- FreightProduct: zone_group
ALTER TABLE "FreightProduct" ADD COLUMN "zone_group" TEXT NOT NULL DEFAULT 'default';

-- InvoiceLine: surcharge verification fields
ALTER TABLE "InvoiceLine" ADD COLUMN "surcharge_delta" REAL;
ALTER TABLE "InvoiceLine" ADD COLUMN "surcharge_status" TEXT;
CREATE INDEX "InvoiceLine_surcharge_status_idx" ON "InvoiceLine"("surcharge_status");

PRAGMA foreign_keys=ON;

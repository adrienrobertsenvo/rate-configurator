-- CreateTable
CREATE TABLE "Contract" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,
    "billing_country" TEXT NOT NULL,
    "currency_code" TEXT NOT NULL DEFAULT 'EUR',
    "weight_unit" TEXT NOT NULL DEFAULT 'kg',
    "volumetric_divisor" INTEGER NOT NULL DEFAULT 5000,
    "valid_from" TEXT NOT NULL,
    "valid_until" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FreightProduct" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "contractId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "price_structure" TEXT NOT NULL DEFAULT 'zone,weight',
    "order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "FreightProduct_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SubProduct" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "productId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "codes" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "SubProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "FreightProduct" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PriceBand" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "subProductId" INTEGER NOT NULL,
    "zone" TEXT NOT NULL,
    "weight_start" INTEGER NOT NULL,
    "weight_end" INTEGER,
    "price" REAL,
    "per_kg" REAL,
    "step" INTEGER,
    "order" INTEGER NOT NULL DEFAULT 0,
    "confidence" REAL,
    CONSTRAINT "PriceBand_subProductId_fkey" FOREIGN KEY ("subProductId") REFERENCES "SubProduct" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Surcharge" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "contractId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" REAL,
    "description" TEXT,
    CONSTRAINT "Surcharge_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ZoneMap" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "carrier" TEXT NOT NULL,
    "spec_name" TEXT NOT NULL,
    "product_name" TEXT NOT NULL DEFAULT 'country-zones',
    "valid_from" TEXT NOT NULL,
    "currency_code" TEXT NOT NULL DEFAULT 'EUR'
);

-- CreateTable
CREATE TABLE "CountryZone" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "zoneMapId" INTEGER NOT NULL,
    "country" TEXT NOT NULL,
    "zone" INTEGER NOT NULL,
    CONSTRAINT "CountryZone_zoneMapId_fkey" FOREIGN KEY ("zoneMapId") REFERENCES "ZoneMap" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CatalogProduct" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "carrier" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "sub_product_name" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "CatalogSurcharge" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "carrier" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "invoice_number" TEXT NOT NULL,
    "invoice_date" TEXT NOT NULL,
    "contractId" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "total_excl_vat" REAL,
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Invoice_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "invoiceId" INTEGER NOT NULL,
    "shipment_number" TEXT,
    "shipment_date" TEXT,
    "product_code" TEXT,
    "product_name" TEXT,
    "origin_country" TEXT,
    "dest_country" TEXT,
    "weight_kg" REAL,
    "weight_flag" TEXT,
    "charged_amount" REAL,
    "weight_charge" REAL,
    "surcharges_json" TEXT,
    "expected_amount" REAL,
    "expected_weight_charge" REAL,
    "expected_surcharges_json" TEXT,
    "delta" REAL,
    "audit_status" TEXT,
    "audit_notes" TEXT,
    CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Contract_carrier_billing_country_idx" ON "Contract"("carrier", "billing_country");

-- CreateIndex
CREATE INDEX "FreightProduct_contractId_idx" ON "FreightProduct"("contractId");

-- CreateIndex
CREATE INDEX "SubProduct_productId_idx" ON "SubProduct"("productId");

-- CreateIndex
CREATE INDEX "PriceBand_subProductId_zone_order_idx" ON "PriceBand"("subProductId", "zone", "order");

-- CreateIndex
CREATE INDEX "Surcharge_contractId_idx" ON "Surcharge"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "ZoneMap_carrier_key" ON "ZoneMap"("carrier");

-- CreateIndex
CREATE INDEX "CountryZone_zoneMapId_idx" ON "CountryZone"("zoneMapId");

-- CreateIndex
CREATE UNIQUE INDEX "CountryZone_zoneMapId_country_key" ON "CountryZone"("zoneMapId", "country");

-- CreateIndex
CREATE INDEX "CatalogProduct_carrier_idx" ON "CatalogProduct"("carrier");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogProduct_carrier_code_key" ON "CatalogProduct"("carrier", "code");

-- CreateIndex
CREATE INDEX "CatalogSurcharge_carrier_idx" ON "CatalogSurcharge"("carrier");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogSurcharge_carrier_code_key" ON "CatalogSurcharge"("carrier", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_invoice_number_key" ON "Invoice"("invoice_number");

-- CreateIndex
CREATE INDEX "Invoice_contractId_idx" ON "Invoice"("contractId");

-- CreateIndex
CREATE INDEX "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");

-- CreateIndex
CREATE INDEX "InvoiceLine_audit_status_idx" ON "InvoiceLine"("audit_status");

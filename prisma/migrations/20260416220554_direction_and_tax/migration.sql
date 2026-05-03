-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN "expected_tax" REAL;
ALTER TABLE "InvoiceLine" ADD COLUMN "tax_code" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "tax_delta" REAL;
ALTER TABLE "InvoiceLine" ADD COLUMN "tax_status" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "total_tax" REAL;

-- CreateTable
CREATE TABLE "TaxRate" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "carrier" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "rate" REAL NOT NULL,
    "description" TEXT
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CatalogProduct" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "carrier" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "sub_product_name" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'any'
);
INSERT INTO "new_CatalogProduct" ("carrier", "code", "id", "product_name", "sub_product_name") SELECT "carrier", "code", "id", "product_name", "sub_product_name" FROM "CatalogProduct";
DROP TABLE "CatalogProduct";
ALTER TABLE "new_CatalogProduct" RENAME TO "CatalogProduct";
CREATE INDEX "CatalogProduct_carrier_idx" ON "CatalogProduct"("carrier");
CREATE UNIQUE INDEX "CatalogProduct_carrier_code_direction_key" ON "CatalogProduct"("carrier", "code", "direction");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "TaxRate_carrier_idx" ON "TaxRate"("carrier");

-- CreateIndex
CREATE UNIQUE INDEX "TaxRate_carrier_code_key" ON "TaxRate"("carrier", "code");

-- CreateIndex
CREATE INDEX "InvoiceLine_tax_status_idx" ON "InvoiceLine"("tax_status");

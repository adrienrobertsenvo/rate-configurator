-- CreateTable
CREATE TABLE "Customer" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "display_name" TEXT,
    "brand_aliases" TEXT
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Contract" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "customerId" INTEGER,
    "name" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,
    "billing_country" TEXT NOT NULL,
    "currency_code" TEXT NOT NULL DEFAULT 'EUR',
    "weight_unit" TEXT NOT NULL DEFAULT 'kg',
    "volumetric_divisor" INTEGER NOT NULL DEFAULT 5000,
    "fuel_multiplier" REAL NOT NULL DEFAULT 1.0,
    "valid_from" TEXT NOT NULL,
    "valid_until" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Contract_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Contract" ("billing_country", "carrier", "createdAt", "currency_code", "fuel_multiplier", "id", "name", "updatedAt", "valid_from", "valid_until", "volumetric_divisor", "weight_unit") SELECT "billing_country", "carrier", "createdAt", "currency_code", "fuel_multiplier", "id", "name", "updatedAt", "valid_from", "valid_until", "volumetric_divisor", "weight_unit" FROM "Contract";
DROP TABLE "Contract";
ALTER TABLE "new_Contract" RENAME TO "Contract";
CREATE INDEX "Contract_carrier_billing_country_idx" ON "Contract"("carrier", "billing_country");
CREATE INDEX "Contract_customerId_idx" ON "Contract"("customerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Customer_name_key" ON "Customer"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_code_key" ON "Customer"("code");

-- CreateIndex
CREATE INDEX "Customer_code_idx" ON "Customer"("code");

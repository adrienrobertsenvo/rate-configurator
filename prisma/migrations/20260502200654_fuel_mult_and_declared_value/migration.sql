-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN "declared_value" REAL;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Contract" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
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
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Contract" ("billing_country", "carrier", "createdAt", "currency_code", "id", "name", "updatedAt", "valid_from", "valid_until", "volumetric_divisor", "weight_unit") SELECT "billing_country", "carrier", "createdAt", "currency_code", "id", "name", "updatedAt", "valid_from", "valid_until", "volumetric_divisor", "weight_unit" FROM "Contract";
DROP TABLE "Contract";
ALTER TABLE "new_Contract" RENAME TO "Contract";
CREATE INDEX "Contract_carrier_billing_country_idx" ON "Contract"("carrier", "billing_country");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

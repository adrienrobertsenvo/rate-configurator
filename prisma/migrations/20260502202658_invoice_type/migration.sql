-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Invoice" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "invoice_number" TEXT NOT NULL,
    "invoice_date" TEXT NOT NULL,
    "contractId" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "total_excl_vat" REAL,
    "invoice_type" TEXT NOT NULL DEFAULT 'freight',
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Invoice_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Invoice" ("contractId", "currency", "id", "invoice_date", "invoice_number", "total_excl_vat", "uploadedAt") SELECT "contractId", "currency", "id", "invoice_date", "invoice_number", "total_excl_vat", "uploadedAt" FROM "Invoice";
DROP TABLE "Invoice";
ALTER TABLE "new_Invoice" RENAME TO "Invoice";
CREATE UNIQUE INDEX "Invoice_invoice_number_key" ON "Invoice"("invoice_number");
CREATE INDEX "Invoice_contractId_idx" ON "Invoice"("contractId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

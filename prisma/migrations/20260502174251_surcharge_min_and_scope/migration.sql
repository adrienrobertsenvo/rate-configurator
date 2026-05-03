-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Surcharge" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "contractId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" REAL,
    "min_amount" REAL,
    "applies_to" TEXT NOT NULL DEFAULT 'any',
    "description" TEXT,
    CONSTRAINT "Surcharge_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Surcharge" ("amount", "code", "contractId", "description", "id", "kind", "name") SELECT "amount", "code", "contractId", "description", "id", "kind", "name" FROM "Surcharge";
DROP TABLE "Surcharge";
ALTER TABLE "new_Surcharge" RENAME TO "Surcharge";
CREATE INDEX "Surcharge_contractId_idx" ON "Surcharge"("contractId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

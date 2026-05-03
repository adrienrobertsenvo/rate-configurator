-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN "review_notes" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "review_status" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "reviewed_at" DATETIME;
ALTER TABLE "InvoiceLine" ADD COLUMN "reviewer" TEXT;

-- CreateTable
CREATE TABLE "LineMessage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "lineId" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LineMessage_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "InvoiceLine" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "LineMessage_lineId_idx" ON "LineMessage"("lineId");

-- CreateIndex
CREATE INDEX "InvoiceLine_review_status_idx" ON "InvoiceLine"("review_status");

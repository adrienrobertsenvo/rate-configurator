-- Drill-down: persist matched contract section on each invoice line
ALTER TABLE "InvoiceLine" ADD COLUMN "matched_product" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "matched_sub_product" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "matched_zone" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "matched_band_json" TEXT;

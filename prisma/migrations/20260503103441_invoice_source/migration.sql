-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "source_bytes" BLOB;
ALTER TABLE "Invoice" ADD COLUMN "source_filename" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "source_sha256" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "source_size_bytes" INTEGER;

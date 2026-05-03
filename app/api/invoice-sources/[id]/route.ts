import { NextResponse } from "next/server";
import { db } from "../../../lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invoiceId = Number(id);
  if (!Number.isFinite(invoiceId)) return new NextResponse("Bad id", { status: 400 });
  const inv = await db.invoice.findUnique({
    where: { id: invoiceId },
    select: { source_filename: true, source_bytes: true, source_size_bytes: true, invoice_number: true },
  });
  if (!inv || !inv.source_bytes) return new NextResponse("Original CSV not stored for this invoice", { status: 404 });
  const filename = inv.source_filename ?? `${inv.invoice_number}.csv`;
  const bytes = inv.source_bytes as Uint8Array;
  return new NextResponse(bytes, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
      "Content-Length": String(inv.source_size_bytes ?? bytes.byteLength),
    },
  });
}

import { NextResponse } from "next/server";
import { db } from "../../../lib/db";

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
};

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sourceId = Number(id);
  if (!Number.isFinite(sourceId)) return new NextResponse("Bad id", { status: 400 });
  const src = await db.contractSource.findUnique({ where: { id: sourceId } });
  if (!src || !src.bytes) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(src.bytes), {
    headers: {
      "Content-Type": MIME[src.kind] ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${src.filename.replace(/"/g, "")}"`,
      "Content-Length": String(src.size_bytes),
    },
  });
}

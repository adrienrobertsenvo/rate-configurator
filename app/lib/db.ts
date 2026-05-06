import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

function makeClient() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is not set");
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.on("error", (err) => console.error("[db] pool error:", err));
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

export const db = globalThis.__prisma ?? makeClient();
if (process.env.NODE_ENV !== "production") globalThis.__prisma = db;

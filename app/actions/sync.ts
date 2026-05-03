"use server";

import { syncDemandSurcharge, type SyncReport } from "../lib/sync-demand-surcharge";

// Server-action entry point for the on-demand "Sync external surcharges"
// button on the Rules page. Returns a structured report; the client renders
// the diff. No DB writes — schedule changes still require a human eyeball
// on the proposed TS snippet.
export async function syncExternalSurcharges(): Promise<SyncReport> {
  return syncDemandSurcharge();
}

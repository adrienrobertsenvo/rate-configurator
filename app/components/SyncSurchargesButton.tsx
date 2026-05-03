"use client";

import { useState, useTransition } from "react";
import { syncExternalSurcharges } from "../actions/sync";
import type { SyncReport } from "../lib/carriers/dhl-express/sync-demand-surcharge";

// Click-to-fetch button for the DHL Demand Surcharge sync. Lives on the Rules
// page next to the demand-surcharge documentation. No auto-apply — surfaces
// drift / new-window so a human can update `app/lib/demand-surcharge.ts`.
export function SyncSurchargesButton() {
  const [pending, start] = useTransition();
  const [report, setReport] = useState<SyncReport | null>(null);

  function run() {
    setReport(null);
    start(async () => {
      const r = await syncExternalSurcharges();
      setReport(r);
    });
  }

  const statusCls = !report ? "" :
    report.status === "in_sync" ? "bg-emerald-50 border-emerald-200 text-emerald-900" :
    report.status === "drift" ? "bg-amber-50 border-amber-200 text-amber-900" :
    report.status === "new_window" ? "bg-blue-50 border-blue-200 text-blue-900" :
    "bg-rose-50 border-rose-200 text-rose-900";

  return (
    <div className="border rounded bg-white p-3 not-prose">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div>
          <div className="text-sm font-medium">DHL Demand Surcharge — on-demand sync</div>
          <div className="text-xs text-gray-500">
            Fetches the published matrix and diffs it against{" "}
            <code className="text-[11px] bg-gray-100 px-1 py-0.5 rounded">app/lib/demand-surcharge.ts</code>.
            No auto-apply — propose-only.
          </div>
        </div>
        <button
          onClick={run}
          disabled={pending}
          className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60 whitespace-nowrap"
        >
          {pending ? "Fetching…" : "Sync now"}
        </button>
      </div>

      {report && (
        <div className={`text-xs border rounded p-2 ${statusCls}`}>
          <div className="font-medium mb-1">
            {report.status === "in_sync" && "✓ In sync"}
            {report.status === "drift" && "⚠ Drift detected"}
            {report.status === "new_window" && "⚠ New schedule window"}
            {report.status === "error" && "✗ Sync failed"}
          </div>
          <div className="mb-2">{report.message}</div>
          {report.diffs.length > 0 && (
            <table className="w-full text-[11px] font-mono mb-2">
              <thead className="text-gray-600">
                <tr><th className="text-left">Cell</th><th className="text-right">Have</th><th className="text-right">Published</th></tr>
              </thead>
              <tbody>
                {report.diffs.map((d) => (
                  <tr key={d.cell} className="border-t border-current/20">
                    <td className="py-0.5">{d.cell}</td>
                    <td className="text-right">{d.have ?? "—"}</td>
                    <td className="text-right">{d.published}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {report.proposed_schedule && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs">View proposed TS snippet (paste into SCHEDULES)</summary>
              <pre className="text-[10px] bg-white border rounded p-2 mt-1 overflow-auto whitespace-pre">{report.proposed_schedule}</pre>
            </details>
          )}
          <div className="text-[10px] opacity-60 mt-1">
            Fetched {new Date(report.fetched_at).toLocaleString()} ·{" "}
            <a href={report.source_url} target="_blank" rel="noopener" className="underline">source</a>
          </div>
        </div>
      )}
    </div>
  );
}

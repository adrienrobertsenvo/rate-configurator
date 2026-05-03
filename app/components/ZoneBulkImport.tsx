"use client";

import { useRef, useState, useTransition } from "react";
import { bulkImportZones, extractZonesFromFiles } from "../actions/zones";

export function ZoneBulkImport({ zoneMapId }: { zoneMapId: number }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [result, setResult] = useState<{ imported: number; skipped: string[] } | null>(null);
  const [extractNotes, setExtractNotes] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, startImport] = useTransition();
  const [extracting, startExtract] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const extractRef = useRef<HTMLInputElement>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const content = await f.text();
    setText(content);
  };

  const onExtract = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setError(null);
    setResult(null);
    setExtractNotes(null);
    startExtract(async () => {
      try {
        const fd = new FormData();
        for (const f of files) fd.append("files", f);
        const r = await extractZonesFromFiles(fd);
        const csv = r.entries.map((e) => `${e.country},${e.zone}`).join("\n");
        setText(csv);
        const header: string[] = [];
        if (r.carrier) header.push(`carrier: ${r.carrier}`);
        if (r.billing_country) header.push(`billing: ${r.billing_country}`);
        if (r.zone_group) header.push(`group: ${r.zone_group}`);
        setExtractNotes(
          `Claude found ${r.entries.length} countr${r.entries.length === 1 ? "y" : "ies"}` +
            (header.length ? ` · ${header.join(" · ")}` : "") +
            (r.notes ? ` · notes: ${r.notes}` : "") +
            ". Review below and click Import.",
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (extractRef.current) extractRef.current.value = "";
      }
    });
  };

  const run = () => {
    setError(null);
    setResult(null);
    startImport(async () => {
      try {
        const r = await bulkImportZones(zoneMapId, text, mode);
        setResult(r);
        if (r.skipped.length === 0) setText("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  if (!open) {
    return (
      <button
        className="text-xs rounded bg-gray-200 hover:bg-gray-300 px-2 py-1"
        onClick={() => setOpen(true)}
      >
        bulk import…
      </button>
    );
  }

  const busy = importing || extracting;

  return (
    <div className="rounded border border-gray-200 bg-white p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Bulk import zones</div>
        <button className="text-xs text-gray-500 hover:text-gray-700" onClick={() => setOpen(false)}>
          close
        </button>
      </div>
      <div className="text-xs text-gray-600">
        Paste CSV (<code className="bg-gray-100 px-1 rounded">DE,1</code> per line), a DHL-style YAML
        (<code className="bg-gray-100 px-1 rounded">countries:</code> → <code className="bg-gray-100 px-1 rounded">DE:</code> → <code className="bg-gray-100 px-1 rounded">zones: [1]</code>), or upload a
        screenshot/PDF/XLSX of the zones table — Claude will extract it for you.
      </div>
      <div className="flex flex-wrap gap-2 items-center text-xs">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.yaml,.yml,.txt,text/csv,text/yaml"
          className="hidden"
          onChange={onFile}
        />
        <input
          ref={extractRef}
          type="file"
          accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.xlsx,.xls,image/*,application/pdf"
          multiple
          className="hidden"
          onChange={onExtract}
        />
        <button
          className="rounded bg-gray-100 hover:bg-gray-200 px-2 py-1"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          load CSV/YAML file
        </button>
        <button
          className="rounded bg-indigo-600 text-white hover:bg-indigo-700 px-2 py-1 disabled:opacity-60"
          onClick={() => extractRef.current?.click()}
          disabled={busy}
        >
          {extracting ? "Extracting…" : "extract from image / PDF / XLSX"}
        </button>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="mode"
            checked={mode === "merge"}
            onChange={() => setMode("merge")}
          />
          merge
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="mode"
            checked={mode === "replace"}
            onChange={() => setMode("replace")}
          />
          replace
        </label>
      </div>
      {extractNotes && <div className="text-xs text-indigo-700 bg-indigo-50 rounded px-2 py-1">{extractNotes}</div>}
      <textarea
        className="w-full h-48 rounded border border-gray-300 px-2 py-1 text-xs font-mono"
        placeholder={"DE,1\nBE,1\nFR,2\n...\n\n— or —\n\ncountries:\n  DE:\n    zones: [1]"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
      />
      <div className="flex items-center gap-3">
        <button
          className="text-sm rounded bg-blue-600 text-white hover:bg-blue-700 px-3 py-1 disabled:opacity-60"
          onClick={run}
          disabled={busy || !text.trim()}
        >
          {importing ? "Importing…" : "Import"}
        </button>
        {result && (
          <span className="text-xs text-green-700">
            Imported {result.imported} countr{result.imported === 1 ? "y" : "ies"}
            {result.skipped.length > 0 && ` · skipped: ${result.skipped.join(", ")}`}
          </span>
        )}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  );
}

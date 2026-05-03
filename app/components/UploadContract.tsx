"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { uploadAndExtractContract } from "../actions/extract";

export function UploadContract() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const onFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const arr = Array.from(files);
    setFileNames(arr.map((f) => f.name));
    setError(null);
    const fd = new FormData();
    for (const f of arr) fd.append("pdf", f);
    start(async () => {
      try {
        const { contractId } = await uploadAndExtractContract(fd);
        router.push(`/contracts/${contractId}?extracted=1`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <div className="flex items-center gap-3">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="application/pdf,.pdf,.xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
        onChange={onFiles}
        className="hidden"
        disabled={pending}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={pending}
        className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {pending ? "Extracting…" : "Upload contract (PDF / XLSX / CSV)"}
      </button>
      {pending && fileNames.length > 0 && (
        <span className="text-xs text-gray-500">
          {fileNames.length === 1
            ? fileNames[0]
            : `${fileNames.length} files (${fileNames.join(", ")})`}
          {" — Claude is reading; XLSX/CSV usually 15–60s, PDF 1–3 min"}
        </span>
      )}
      {error && <span className="text-xs text-red-600 max-w-md">{error}</span>}
    </div>
  );
}

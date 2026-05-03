"use client";

interface Props {
  baseName: string;
  ratesYaml: string;
  zonesYaml: string;
  catalogYaml: string;
}

function download(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/yaml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ExportPanel({ baseName, ratesYaml, zonesYaml, catalogYaml }: Props) {
  const panels = [
    { label: "Rates", body: ratesYaml, file: `${baseName}-rates.yaml` },
    { label: "Zones", body: zonesYaml, file: `${baseName}-zones.yaml` },
    { label: "Catalog", body: catalogYaml, file: `${baseName}-catalog.yaml` },
  ];

  return (
    <div className="p-4 grid grid-cols-1 lg:grid-cols-3 gap-4 h-full">
      {panels.map(({ label, body, file }) => (
        <div key={label} className="flex flex-col border rounded bg-white overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b bg-gray-50">
            <div className="text-sm font-medium">{label}</div>
            <div className="flex gap-2">
              <button
                className="text-xs rounded bg-gray-200 px-2 py-1 hover:bg-gray-300"
                onClick={() => navigator.clipboard.writeText(body)}
              >
                copy
              </button>
              <button
                className="text-xs rounded bg-blue-600 text-white px-2 py-1 hover:bg-blue-700"
                onClick={() => download(file, body)}
              >
                download
              </button>
            </div>
          </div>
          <pre className="text-xs flex-1 overflow-auto p-3 font-mono leading-4">{body}</pre>
        </div>
      ))}
    </div>
  );
}

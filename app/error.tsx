"use client";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html>
      <body style={{ fontFamily: "monospace", padding: "2rem", maxWidth: "800px", margin: "0 auto" }}>
        <h1 style={{ color: "#dc2626", fontSize: "1.25rem", marginBottom: "1rem" }}>Server error</h1>
        <pre style={{ background: "#f9fafb", border: "1px solid #e5e7eb", padding: "1rem", borderRadius: "6px", whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "0.8rem" }}>
          {error.message}
          {error.digest ? `\n\nDigest: ${error.digest}` : ""}
        </pre>
        <p style={{ marginTop: "1rem", fontSize: "0.875rem", color: "#6b7280" }}>
          Check Vercel → Functions → Logs for the full stack trace.
        </p>
      </body>
    </html>
  );
}

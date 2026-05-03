"use client";

import { useRef, useState, useTransition } from "react";
import { debugLine, type DebugMessage } from "../actions/debug";

export function DebugChat({ lineId }: { lineId: number }) {
  const [messages, setMessages] = useState<DebugMessage[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const scrollRef = useRef<HTMLDivElement>(null);

  const send = () => {
    const content = input.trim();
    if (!content) return;
    const next: DebugMessage[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setError(null);
    start(async () => {
      try {
        const { reply } = await debugLine(lineId, next);
        setMessages([...next, { role: "assistant", content: reply }]);
        queueMicrotask(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <div className="bg-white rounded border flex flex-col">
      <div className="text-[10px] uppercase tracking-wide text-gray-500 px-3 py-1.5 border-b bg-gray-50">
        Debug chat · Claude Opus 4.7
      </div>
      <div ref={scrollRef} className="max-h-72 overflow-auto px-3 py-2 space-y-2 text-xs">
        {messages.length === 0 && (
          <div className="text-gray-500">
            Ask about this line — e.g.{" "}
            <span className="text-gray-700">
              &ldquo;why is expected €25.74 instead of €22.30?&rdquo;
            </span>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : ""}>
            <div
              className={`inline-block px-2 py-1.5 rounded max-w-[90%] text-left whitespace-pre-wrap ${
                m.role === "user" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-900"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {pending && (
          <div>
            <div className="inline-block px-2 py-1.5 rounded bg-gray-100 text-gray-500 italic">thinking…</div>
          </div>
        )}
        {error && <div className="text-red-600">{error}</div>}
      </div>
      <div className="border-t p-2 flex gap-2">
        <textarea
          className="flex-1 border rounded px-2 py-1 text-xs resize-none"
          rows={2}
          placeholder="Ask a question about this line…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          disabled={pending}
        />
        <button
          className="text-xs bg-blue-600 text-white px-3 py-1 rounded self-end disabled:opacity-60"
          onClick={send}
          disabled={pending || !input.trim()}
        >
          Send
        </button>
      </div>
      <div className="px-3 pb-2 text-[10px] text-gray-400">⌘↵ to send · Claude gets the full contract band table + line context</div>
    </div>
  );
}

"use client";

import { useState, useTransition, useEffect } from "react";
import { setReviewStatus, setReviewNotes, sendChatMessage, getChatHistory, getInitialSuggestion, type ReviewStatus, type ChatMessageDTO } from "../actions/review";

interface Props {
  lineId: number;
  initialStatus: ReviewStatus | null;
  initialNotes: string | null;
  initialReviewer: string | null;
  reviewedAt: string | null;
}

// Minimal inline-Markdown rendering: **bold**, `code`, and unordered list "-".
// Block structure (line breaks, indents) preserved by whitespace-pre-wrap on the
// container. Avoids pulling in a full Markdown parser dep for what we need.
function renderMarkdown(s: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // Tokenizer: walk the string and emit text / strong / code spans.
  // Order of patterns matters — try the longer markers first.
  const re = /(\*\*([^*\n][^*]*?)\*\*|`([^`\n]+)`)/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[1].startsWith("**")) {
      out.push(<strong key={key++}>{m[2]}</strong>);
    } else {
      out.push(<code key={key++} className="font-mono bg-gray-100 px-1 rounded text-[11px]">{m[3]}</code>);
    }
    last = m.index + m[1].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

const STATUSES: { value: ReviewStatus; label: string; cls: string }[] = [
  { value: "correct",     label: "Correctly billed", cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  { value: "valid_claim", label: "Valid claim",      cls: "bg-rose-100 text-rose-800 border-rose-300" },
  { value: "dispute",     label: "Dispute / open",   cls: "bg-amber-100 text-amber-800 border-amber-300" },
  { value: "other",       label: "Other",            cls: "bg-gray-100 text-gray-800 border-gray-300" },
];

export function ReviewPanel({ lineId, initialStatus, initialNotes, initialReviewer, reviewedAt }: Props) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ReviewStatus | null>(initialStatus);
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [reviewer, setReviewer] = useState(initialReviewer ?? "");
  const [pending, start] = useTransition();

  // Chat state — loaded lazily when the panel opens.
  const [chat, setChat] = useState<ChatMessageDTO[] | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!open || chat !== null) return;
    setChatLoading(true);
    (async () => {
      try {
        const existing = await getChatHistory(lineId);
        if (existing.length === 0) {
          // No history yet — auto-generate the opening assessment so the
          // reviewer immediately sees what the AI thinks.
          await getInitialSuggestion(lineId);
        }
        const fresh = await getChatHistory(lineId);
        setChat(fresh);
      } finally {
        setChatLoading(false);
      }
    })();
  }, [open, lineId, chat]);

  function applyStatus(next: ReviewStatus | null) {
    setStatus(next);
    start(async () => {
      await setReviewStatus(lineId, next, reviewer);
    });
  }

  function commitNotes() {
    start(async () => {
      await setReviewNotes(lineId, notes);
    });
  }

  function sendMessage() {
    const msg = draft.trim();
    if (!msg) return;
    setDraft("");
    // Optimistically append the user message.
    setChat((prev) => [
      ...(prev ?? []),
      { id: -Date.now(), role: "user", content: msg, createdAt: new Date().toISOString() },
    ]);
    setChatLoading(true);
    start(async () => {
      try {
        await sendChatMessage(lineId, msg);
        const fresh = await getChatHistory(lineId);
        setChat(fresh);
      } finally {
        setChatLoading(false);
      }
    });
  }

  const statusMeta = STATUSES.find((s) => s.value === status);

  return (
    <>
      <tr className="bg-white">
        <td colSpan={6} className="px-3 py-1.5 text-xs">
          <button
            onClick={() => setOpen((o) => !o)}
            className="text-blue-700 hover:underline mr-3"
          >
            {open ? "▼" : "▶"} Review
          </button>
          {statusMeta && (
            <span className={`inline-block border rounded px-2 py-0.5 mr-2 ${statusMeta.cls}`}>{statusMeta.label}</span>
          )}
          {reviewer && <span className="text-gray-500 mr-2">by {reviewer}</span>}
          {reviewedAt && <span className="text-gray-400">{reviewedAt.slice(0, 10)}</span>}
          {!status && <span className="text-gray-400">unreviewed</span>}
        </td>
      </tr>
      {open && (
        <tr className="bg-blue-50/30">
          <td colSpan={6} className="px-3 py-3">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Left: status + notes */}
              <div>
                <div className="text-xs font-medium text-gray-700 mb-1">Verdict</div>
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {STATUSES.map((s) => (
                    <button
                      key={s.value}
                      onClick={() => applyStatus(status === s.value ? null : s.value)}
                      className={`text-xs border rounded px-2 py-1 ${status === s.value ? s.cls : "bg-white border-gray-300 text-gray-600 hover:bg-gray-50"}`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                <div className="text-xs font-medium text-gray-700 mb-1">Reviewer</div>
                <input
                  className="w-full border rounded px-2 py-1 text-xs mb-3"
                  placeholder="your name or email"
                  value={reviewer}
                  onChange={(e) => setReviewer(e.target.value)}
                  onBlur={() => status && applyStatus(status)}
                />
                <div className="text-xs font-medium text-gray-700 mb-1">Notes</div>
                <textarea
                  className="w-full border rounded px-2 py-1 text-xs h-24"
                  placeholder="add a comment for the team…"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  onBlur={commitNotes}
                />
              </div>

              {/* Right: chat */}
              <div className="border rounded bg-white flex flex-col" style={{ minHeight: 280 }}>
                <div className="px-3 py-2 border-b text-xs font-medium text-gray-700 flex items-center justify-between">
                  <span>Ask the AI about this shipment</span>
                  {chatLoading && <span className="text-xs text-blue-600">…</span>}
                </div>
                <div className="flex-1 overflow-auto px-3 py-2 space-y-2 text-xs" style={{ maxHeight: 320 }}>
                  {chat == null && !chatLoading && <div className="text-gray-500">Loading suggestion…</div>}
                  {chat?.map((m) => (
                    <div key={m.id} className={`rounded px-2 py-1.5 ${m.role === "assistant" ? "bg-gray-50 border border-gray-200" : "bg-blue-50 border border-blue-200 ml-6"}`}>
                      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">{m.role}</div>
                      <div className="whitespace-pre-wrap">{renderMarkdown(m.content)}</div>
                    </div>
                  ))}
                  {chat?.length === 0 && !chatLoading && <div className="text-gray-500">No messages yet.</div>}
                </div>
                <form
                  className="border-t px-3 py-2 flex gap-2"
                  onSubmit={(e) => { e.preventDefault(); sendMessage(); }}
                >
                  <input
                    className="flex-1 border rounded px-2 py-1 text-xs"
                    placeholder="ask a question…"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    disabled={chatLoading}
                  />
                  <button
                    type="submit"
                    className="text-xs bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white rounded px-3 py-1"
                    disabled={chatLoading || !draft.trim()}
                  >
                    Send
                  </button>
                </form>
              </div>
            </div>
            {pending && <div className="text-xs text-blue-600 mt-2">saving…</div>}
          </td>
        </tr>
      )}
    </>
  );
}

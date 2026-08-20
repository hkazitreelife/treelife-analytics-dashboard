"use client";

import { useEffect, useRef, useState } from "react";

import type { ActiveSource } from "@/components/shell/types";
import { formatNumber } from "@/lib/aggregate";
import { fetchJsonCached, invalidateClientCache } from "@/lib/clientCache";

/**
 * Prompt 12.0's right panel, universal as of Prompt 15.0: every session,
 * single-source or multi-source, gets this same Chat/Edit surface, posting
 * to the one universal POST /api/sessions/:id/chat and
 * POST /api/sessions/:id/edit endpoints -- which source(s) actually get
 * touched is decided server-side (lib/sessionChat.ts / lib/sessionEdit.ts),
 * never here. An edit request against a multi-source session may come back
 * as `needs_clarification` instead of applying anything; that's rendered
 * as its own turn, not an error.
 *
 * History is no longer component-local only: it loads the session's full
 * persisted history (GET /api/sessions/:id/turns) on mount, so reopening a
 * session restores it exactly, and every new turn here is already
 * persisted server-side by the endpoint that answered it.
 */

type Mode = "chat" | "edit";

type ChatAnswer = {
  directAnswer: string;
  metrics: { label: string; value: number; sourceTable?: string; datasetName?: string }[];
  citations: { sectionId: string; quote: string; documentName?: string }[];
  caveats?: string;
};

type Turn = {
  id: string;
  mode: Mode;
  userMessage: string;
  result:
    | { kind: "pending" }
    | { kind: "chat-answered"; answer: ChatAnswer }
    | { kind: "edit-applied"; version: number; targetKind: string }
    | { kind: "needs-clarification"; question: string }
    | { kind: "error"; message: string };
};

const MIN_TEXTAREA_HEIGHT_PX = 52;
const MAX_TEXTAREA_HEIGHT_PX = 200;

let nextTurnId = 0;

export const ContextChatEditPanel = ({
  source,
  onEditApplied,
}: {
  source: ActiveSource;
  /** Called after a successful edit -- lets the parent bump a refreshToken for a source with no SSE (documents). */
  onEditApplied?: () => void;
}) => {
  const [mode, setMode] = useState<Mode>("chat");
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<Turn[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  // Restore this session's complete persisted history on mount (Prompt
  // 15.0 Part 2 item 5) -- reopening a session must not start blank.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const body = await fetchJsonCached<{
          turns: {
            id: string;
            kind: Mode;
            message: string;
            status: string;
            response: unknown;
          }[];
        }>(`/api/sessions/${source.sessionId}/turns`, 30_000);

        if (cancelled) {
          return;
        }

        setHistory(
          body.turns.map((turn) => ({
            id: turn.id,
            mode: turn.kind,
            userMessage: turn.message,
            result: turnResultFromStored(turn.status, turn.response),
          })),
        );
      } catch {
        // A failed history load just means starting from an empty
        // history for this visit -- the session's real data is
        // unaffected, and new turns still persist normally.
      } finally {
        if (!cancelled) {
          setHistoryLoaded(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source.sessionId]);

  useEffect(() => {
    const el = textareaRef.current;

    if (!el) {
      return;
    }

    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, MIN_TEXTAREA_HEIGHT_PX), MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, [message]);

  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ block: "end" });
  }, [history]);

  const isPending = history.at(-1)?.result.kind === "pending";

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    const trimmed = message.trim();

    if (!trimmed || isPending) {
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const isLikelyEdit =
      mode === "edit" ||
      /^\s*(remove|delete|add|drop|hide|change layout|rename|turn this into|filter|group by)\b/i.test(trimmed) ||
      (/\b(tab|widget|chart|kpi|overview)\b/i.test(trimmed) && /\b(remove|delete|drop|hide|add|delete the)\b/i.test(trimmed));

    const effectiveMode: Mode = isLikelyEdit ? "edit" : "chat";

    const turnId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? `local-${crypto.randomUUID()}`
        : `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    setHistory((current) => [
      ...current,
      { id: turnId, mode: effectiveMode, userMessage: trimmed, result: { kind: "pending" } },
    ]);
    setMessage("");

    const setResult = (result: Turn["result"]): void => {
      setHistory((current) =>
        current.map((turn) => (turn.id === turnId ? { ...turn, result } : turn)),
      );
    };

    try {
      if (effectiveMode === "chat") {
        const response = await fetch(`/api/sessions/${source.sessionId}/chat`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed }),
          signal: controller.signal,
        });

        const body = (await response.json()) as ChatAnswer & { error?: string };

        if (!response.ok) {
          setResult({ kind: "error", message: body.error ?? `Request returned ${response.status}.` });
          return;
        }

        setResult({
          kind: "chat-answered",
          answer: {
            directAnswer: body.directAnswer,
            metrics: body.metrics ?? [],
            citations: body.citations ?? [],
            caveats: body.caveats,
          },
        });
      } else {
        const response = await fetch(`/api/sessions/${source.sessionId}/edit`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: trimmed }),
          signal: controller.signal,
        });

        const body = (await response.json()) as {
          status?: "applied" | "needs_clarification";
          targetKind?: string;
          version?: number;
          question?: string;
          error?: string;
        };

        if (!response.ok) {
          setResult({ kind: "error", message: body.error ?? `Request returned ${response.status}.` });
          return;
        }

        if (body.status === "needs_clarification") {
          setResult({ kind: "needs-clarification", question: body.question ?? "" });
          return;
        }

        setResult({
          kind: "edit-applied",
          version: body.version ?? 0,
          targetKind: body.targetKind ?? "",
        });
        invalidateClientCache(`/api/sessions/${source.sessionId}/turns`);
        onEditApplied?.();
      }
      invalidateClientCache(`/api/sessions/${source.sessionId}/turns`);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        setResult({ kind: "error", message: "Request cancelled by user." });
      } else {
        setResult({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  };

  const showEmptyState = historyLoaded && history.length === 0;

  return (
    <div className={`flex h-full flex-col ${showEmptyState ? "justify-center" : ""}`}>
      {history.length > 0 ? (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-4 pr-1">
          {history.map((turn) => (
            <TurnBubble key={turn.id} turn={turn} />
          ))}
          <div ref={historyEndRef} />
        </div>
      ) : showEmptyState ? (
        <div className="flex flex-col items-center justify-center p-4 text-center space-y-4 my-auto">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[color:var(--color-forest-surface)] border border-[color:var(--color-forest-bright)]/20 shadow-2xs text-lg">
            ✨
          </div>
          <div className="space-y-1 max-w-[260px]">
            <h4 className="text-xs font-extrabold text-[color:var(--color-forest)]">
              Treelife Copilot
            </h4>
            <p className="text-[11px] text-[color:var(--color-steel)] leading-relaxed">
              Ask deep questions about {source.name} or prompt changes to reshape your dashboard.
            </p>
          </div>

          <div className="flex flex-col gap-1.5 w-full pt-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-steel)] text-left px-1">
              Suggested Prompts:
            </span>
            {[
              { text: "Summarize key findings & high-priority risks", mode: "chat" as const },
              { text: "What are the most significant trends across categories?", mode: "chat" as const },
              { text: "Make the first chart into a horizontal bar graph", mode: "edit" as const },
              { text: "Change chart color to blue or emerald", mode: "edit" as const },
            ].map((sug, sIdx) => (
              <button
                key={sIdx}
                type="button"
                onClick={() => {
                  setMode(sug.mode);
                  setMessage(sug.text);
                  textareaRef.current?.focus();
                }}
                className="text-left rounded-xl border border-[color:var(--color-cloud)] bg-white/90 px-3 py-2 text-xs font-medium text-[color:var(--color-ink)] shadow-2xs transition-all duration-150 hover:bg-[color:var(--color-forest-surface)] hover:border-[color:var(--color-forest-bright)]/30 hover:text-[color:var(--color-forest)] active:scale-98"
              >
                {sug.text}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="shrink-0 space-y-2.5 pt-2 border-t border-[color:var(--color-cloud)]/80">
        {/* Sliding Segmented Toggle */}
        <div className="grid grid-cols-2 gap-1 rounded-xl border border-[color:var(--color-cloud)] bg-[color:var(--color-cloud-light)] p-1 shadow-2xs">
          <button
            type="button"
            onClick={() => setMode("chat")}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-bold transition-all duration-150 ${
              mode === "chat"
                ? "bg-white text-[color:var(--color-forest)] shadow-xs"
                : "text-[color:var(--color-steel)] hover:text-[color:var(--color-ink)] hover:bg-white/40"
            }`}
          >
            <span>💬</span>
            <span>Chat & Inquire</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("edit")}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-bold transition-all duration-150 ${
              mode === "edit"
                ? "bg-[color:var(--color-forest)] text-white shadow-xs"
                : "text-[color:var(--color-steel)] hover:text-[color:var(--color-ink)] hover:bg-white/40"
            }`}
          >
            <span>✏️</span>
            <span>Reshape Dashboard</span>
          </button>
        </div>

        {/* Input Form with Focus Glow & Shortcuts */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-2">
          <label htmlFor="panel-message" className="sr-only">
            {mode === "chat" ? "Ask a question" : "Describe the change"}
          </label>
          <div className="relative">
            <textarea
              ref={textareaRef}
              id="panel-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              disabled={isPending}
              rows={2}
              placeholder={
                mode === "chat"
                  ? "Ask anything about this dataset (e.g. key drivers, anomalies, summaries)..."
                  : "Describe changes (e.g. make bar chart horizontal, change color to blue, add KPI)..."
              }
              style={{ minHeight: "68px" }}
              className="w-full resize-none rounded-xl border border-[color:var(--color-cloud)] bg-white px-3.5 py-2.5 text-xs leading-relaxed text-[color:var(--color-ink)] placeholder-[color:var(--color-steel-light)] shadow-xs transition-all focus:border-[color:var(--color-forest)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-forest-bright)]/20 disabled:opacity-50"
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-[color:var(--color-steel)] flex items-center gap-1">
              Press <kbd className="rounded-md bg-[color:var(--color-cloud-light)] border border-[color:var(--color-cloud)] px-1.5 py-0.5 font-mono text-[9px] font-semibold text-[color:var(--color-steel)]">Enter ↵</kbd>
            </span>
            <button
              type="submit"
              disabled={isPending || message.trim().length === 0}
              className="inline-flex items-center justify-center gap-1 rounded-xl bg-[color:var(--color-forest)] px-4 py-1.5 text-xs font-bold text-white shadow-xs transition-all duration-150 hover:bg-[color:var(--color-forest-mid)] hover:shadow-sm active:scale-95 disabled:opacity-40"
            >
              {isPending ? (
                <span className="animate-pulse">
                  {mode === "chat" ? "Analyzing…" : "Applying…"}
                </span>
              ) : mode === "chat" ? (
                <>
                  <span>Ask</span>
                  <span>→</span>
                </>
              ) : (
                <>
                  <span>Apply</span>
                  <span>✓</span>
                </>
              )}
            </button>
            {isPending && (
              <button
                type="button"
                onClick={() => {
                  abortControllerRef.current?.abort();
                }}
                title="Stop generation"
                className="inline-flex items-center justify-center rounded-xl bg-[color:var(--color-risk-high)] hover:bg-[color:var(--color-risk-high)]/90 text-white p-2.5 shadow-xs transition-all duration-150 active:scale-95"
              >
                <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};

/** Reconstructs a Turn's result from a persisted ConversationTurns row. */
const turnResultFromStored = (status: string, response: unknown): Turn["result"] => {
  const body = (response ?? {}) as Record<string, unknown>;

  if (status === "answered") {
    return {
      kind: "chat-answered",
      answer: {
        directAnswer: String(body.directAnswer ?? ""),
        metrics: Array.isArray(body.metrics) ? (body.metrics as ChatAnswer["metrics"]) : [],
        citations: Array.isArray(body.citations) ? (body.citations as ChatAnswer["citations"]) : [],
        caveats: typeof body.caveats === "string" ? body.caveats : undefined,
      },
    };
  }

  if (status === "edit_applied") {
    return {
      kind: "edit-applied",
      version: Number(body.configVersion ?? body.summaryVersion ?? 0),
      targetKind: "",
    };
  }

  if (status === "needs_clarification") {
    return { kind: "needs-clarification", question: String(body.question ?? "") };
  }

  return { kind: "error", message: String(body.error ?? "This turn failed.") };
};

const renderFormattedInline = (text: string): React.ReactNode => {
  const tokens = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
  return tokens.map((token, idx) => {
    if (token.startsWith("**") && token.endsWith("**")) {
      return (
        <strong key={idx} className="font-bold text-[color:var(--color-forest)]">
          {token.slice(2, -2)}
        </strong>
      );
    }
    if (token.startsWith("*") && token.endsWith("*")) {
      return <em key={idx}>{token.slice(1, -1)}</em>;
    }
    if (token.startsWith("`") && token.endsWith("`")) {
      return (
        <code
          key={idx}
          className="rounded bg-[color:var(--color-cloud-light)] border border-[color:var(--color-cloud)] px-1.5 py-0.5 font-mono text-[11px] text-[color:var(--color-forest)]"
        >
          {token.slice(1, -1)}
        </code>
      );
    }
    return token;
  });
};

export const StructuredAnswer = ({ text }: { text: string }) => {
  if (!text) return null;

  const paragraphs = text.split(/\n{2,}/);

  return (
    <div className="space-y-3 text-xs leading-relaxed text-[color:var(--color-ink)]">
      {paragraphs.map((paragraph, pIdx) => {
        const trimmed = paragraph.trim();

        if (
          trimmed.startsWith("Summary:") ||
          trimmed.startsWith("Key Takeaway:") ||
          trimmed.startsWith("Conclusion:")
        ) {
          return (
            <div
              key={pIdx}
              className="rounded-xl border border-[color:var(--color-forest-bright)]/30 bg-[color:var(--color-forest-surface)] p-3 shadow-2xs"
            >
              <p className="font-semibold text-[color:var(--color-forest)]">
                {renderFormattedInline(trimmed)}
              </p>
            </div>
          );
        }

        const lines = trimmed.split("\n");
        const isBulleted = lines.every((line) => {
          const l = line.trim();
          return l.startsWith("- ") || l.startsWith("• ") || /^\d+\.\s/.test(l);
        });

        if (isBulleted && lines.length > 0) {
          return (
            <ul key={pIdx} className="space-y-1.5 pl-1">
              {lines.map((line, lIdx) => {
                const clean = line.trim().replace(/^[-•]\s+|\d+\.\s+/, "");
                return (
                  <li key={lIdx} className="flex items-start gap-2">
                    <span className="font-bold text-[color:var(--color-forest-bright)] shrink-0 mt-0.5">•</span>
                    <span>{renderFormattedInline(clean)}</span>
                  </li>
                );
              })}
            </ul>
          );
        }

        if (trimmed.includes(" - ") && trimmed.split(" - ").length >= 3) {
          const parts = trimmed.split(" - ");
          return (
            <div key={pIdx} className="space-y-1 rounded-xl bg-[color:var(--color-cloud-light)]/70 p-3 border border-[color:var(--color-cloud)]">
              {parts[0] ? <p className="font-bold text-[color:var(--color-forest)]">{renderFormattedInline(parts[0])}</p> : null}
              <ul className="space-y-1 pl-1">
                {parts.slice(1).map((part, partIdx) => (
                  <li key={partIdx} className="flex items-start gap-1.5">
                    <span className="font-bold text-[color:var(--color-forest-bright)] shrink-0">•</span>
                    <span>{renderFormattedInline(part)}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        }

        return (
          <p key={pIdx} className="leading-relaxed whitespace-pre-line">
            {renderFormattedInline(trimmed)}
          </p>
        );
      })}
    </div>
  );
};

const TurnBubble = ({ turn }: { turn: Turn }) => (
  <div className="space-y-2">
    {/* User Bubble in Deep Forest Green */}
    <div className="flex items-start justify-end gap-1.5">
      <div className="flex flex-col items-end gap-1 max-w-[90%]">
        <span className="rounded-full bg-[color:var(--color-cloud-light)] border border-[color:var(--color-cloud)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[color:var(--color-steel)]">
          {turn.mode}
        </span>
        <div className="rounded-2xl rounded-tr-xs bg-[color:var(--color-forest)] px-3.5 py-2.5 text-xs font-medium text-white shadow-xs leading-relaxed">
          {turn.userMessage}
        </div>
      </div>
    </div>

    {turn.result.kind === "pending" ? (
      <div className="flex items-center gap-2 rounded-xl bg-white border border-[color:var(--color-cloud)] p-3 text-xs text-[color:var(--color-steel)] shadow-2xs animate-pulse">
        <span className="text-sm">✦</span>
        <span>{turn.mode === "chat" ? "Analyzing data with Treelife's Bot…" : "Applying requested edits to dashboard…"}</span>
      </div>
    ) : null}

    {turn.result.kind === "chat-answered" ? (
      <div
        role="status"
        className="rounded-2xl border border-[color:var(--color-cloud)] bg-white p-3.5 text-xs text-[color:var(--color-ink)] shadow-xs space-y-3"
      >
        <StructuredAnswer text={turn.result.answer.directAnswer} />

        {turn.result.answer.metrics.length > 0 ? (
          <div className="flex flex-wrap gap-2 pt-2 border-t border-[color:var(--color-cloud)]/70">
            {turn.result.answer.metrics.map((metric, index) => {
              const formatted =
                typeof metric.value === "number"
                  ? formatNumber(metric.value)
                  : metric.value !== null && metric.value !== undefined
                    ? String(metric.value)
                    : "n/a";
              return (
                <div
                  key={`${metric.label}-${index}`}
                  className="inline-flex flex-col rounded-xl bg-[color:var(--color-cloud-light)]/80 border border-[color:var(--color-cloud)] px-2.5 py-1.5 shadow-2xs transition-all hover:bg-white"
                >
                  <span className="font-mono text-xs font-black text-[color:var(--color-forest)] tabular-nums">
                    {formatted}
                  </span>
                  <span className="text-[10px] font-bold text-[color:var(--color-steel)] uppercase tracking-wide">
                    {metric.label}
                    {metric.datasetName ? ` · ${metric.datasetName}` : ""}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}

        {turn.result.answer.citations.length > 0 ? (
          <div className="space-y-1.5 pt-1 border-t border-[color:var(--color-cloud)]/70">
            {turn.result.answer.citations.map((citation, index) => (
              <blockquote
                key={index}
                className="rounded-lg bg-[color:var(--color-cobalt-surface)]/60 p-2.5 border border-[color:var(--color-cobalt)]/25 text-xs italic text-[color:var(--color-ink)]"
              >
                &ldquo;{citation.quote}&rdquo;
                {citation.documentName ? (
                  <footer className="mt-1 not-italic font-semibold text-[11px] text-[color:var(--color-cobalt-text)]">
                    — {citation.documentName}
                  </footer>
                ) : null}
              </blockquote>
            ))}
          </div>
        ) : null}

        {turn.result.answer.caveats ? (
          <div className="rounded-lg bg-[color:var(--color-gold-surface)] p-2.5 border border-[color:var(--color-gold)]/30 text-[11px] italic text-[color:var(--color-ink-muted)]">
            ℹ {turn.result.answer.caveats}
          </div>
        ) : null}
      </div>
    ) : null}

    {turn.result.kind === "edit-applied" ? (
      <div role="status" className="rounded-xl border border-[color:var(--color-risk-low)]/30 bg-[color:var(--color-risk-low-surface)] p-3 text-xs font-semibold text-[color:var(--color-risk-low-text)] shadow-2xs">
        ✓ Edit applied successfully{turn.result.targetKind ? ` to the ${turn.result.targetKind}` : ""} (v{turn.result.version}).
      </div>
    ) : null}

    {turn.result.kind === "needs-clarification" ? (
      <div role="status" className="rounded-xl border border-[color:var(--color-risk-med)]/30 bg-[color:var(--color-risk-med-surface)] p-3 text-xs font-semibold text-[color:var(--color-risk-med-text)] shadow-2xs">
        ❓ {turn.result.question}
      </div>
    ) : null}

    {turn.result.kind === "error" ? (
      <div role="alert" className="rounded-xl border border-[color:var(--color-risk-high)]/30 bg-[color:var(--color-risk-high-surface)] p-3 space-y-1">
        <p className="text-xs font-bold text-[color:var(--color-risk-high)]">
          {turn.result.message.length > 120 || turn.result.message.includes("{") || turn.result.message.includes("[")
            ? turn.mode === "chat"
              ? "Could not generate an answer. The AI response did not match the expected structure."
              : "Could not apply this edit. The AI response did not match the expected structure."
            : turn.result.message}
        </p>
        {turn.result.message.length > 120 || turn.result.message.includes("{") || turn.result.message.includes("[") ? (
          <details className="mt-1">
            <summary className="cursor-pointer text-[10px] font-medium text-[color:var(--color-steel)] hover:underline">
              Technical details
            </summary>
            <pre className="mt-1 max-h-32 overflow-auto rounded bg-white p-2 text-[10px] text-[color:var(--color-ink)] whitespace-pre-wrap border border-[color:var(--color-cloud)]">
              {turn.result.message}
            </pre>
          </details>
        ) : null}
      </div>
    ) : null}
  </div>
);

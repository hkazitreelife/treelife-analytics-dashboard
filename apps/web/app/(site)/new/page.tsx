"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { AppShell } from "@/components/shell/AppShell";
import { TreelifeLogo } from "@/components/ui/BrandLogo";
import { fileTypeFromFilename } from "@/lib/fileType";
import { hasSupportedExtension, supportedExtensions } from "@/lib/uploadValidation";

/**
 * The landing/upload page, reached only via the sidebar's New button
 * (Prompt 14.0 fix 1 -- "/" redirects a signed-in user with existing
 * content straight to their most recently active session instead of
 * showing this).
 *
 * Prompt 15.0 Part 4: redesigned so the prompt is the dominant element,
 * not the upload button -- what's typed here becomes the framing Claude
 * gets alongside the very first config/summary generation call for a
 * single-file upload (Jobs.intentPrompt -> worker -> claudeConfig.ts's/
 * claudeDocumentSummary.ts's adminIntent option), and becomes the new
 * session's display name for a multi-file batch. Everything below the
 * prompt -- attach, stage, upload, poll -- is the same real pipeline as
 * before, just visually subordinate now.
 *
 * Uploading two or more files together also triggers session synthesis:
 * once every file in that batch reaches a terminal state, whichever ones
 * produced or matched a real dataset/document are grouped into a session
 * (Prompt 15.0: every dataset/document is itself already wrapped in its
 * own single-source session by the worker, so a lone file's completion
 * navigates to ITS session too, not a bare dataset/document route).
 */

type UploadResponseBody = {
  status?: string;
  jobId?: string;
  fileId?: string;
  datasetId?: string;
  documentId?: string;
  existingDatasetId?: string;
  existingDocumentId?: string;
  requiresUserChoice?: boolean;
  message?: string;
  error?: string;
};

type JobStatusBody = {
  status: string;
  error: string | null;
  datasetId: string | null;
  documentId: string | null;
};

type FilePhase =
  | { kind: "uploading" }
  | { kind: "upload-error"; message: string }
  // Section 10.1: exactly one of existingDatasetId/existingDocumentId is
  // set, mirroring which collection the server-side collision check found
  // the match in.
  | {
      kind: "duplicate";
      existingDatasetId: string | null;
      existingDocumentId: string | null;
      message: string;
    }
  | {
      kind: "collision";
      fileId: string;
      existingDatasetId: string | null;
      existingDocumentId: string | null;
      message: string;
      submitting: boolean;
    }
  | { kind: "processing"; jobId: string; datasetId: string | null; documentId: string | null; status: string }
  | { kind: "job-failed"; jobId: string; error: string | null }
  | { kind: "lost-connection"; jobId: string }
  | { kind: "done"; datasetId: string | null; documentId: string | null };

type QueueItem = { id: string; fileName: string; phase: FilePhase };

type RecentSession = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  datasetCount: number;
  documentCount: number;
  singleSource?: {
    kind: "dataset" | "document";
    fileType: string | null;
    totalRows: number | null;
    keyPointsCount: number | null;
  } | null;
};

const formatRelativeTime = (dateStr?: string): string => {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
};

const JOB_STEPS = [
  "queued",
  "processing",
  "validating",
  "generating_config",
  "completed",
] as const;

const STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  processing: "Extracting data",
  validating: "Validating extracted data",
  generating_config: "Generating dashboard",
  completed: "Completed",
  failed: "Failed",
};

const POLL_INTERVAL_MS = 2000;
// Consecutive failed polls (network error, non-2xx, or a dropped session)
// before this gives up and shows an explicit state, rather than polling
// forever in silence.
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

let nextQueueItemId = 0;

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Prompt 15.0 Part 1: a lone upload's real destination is now the
 * single-source session the worker wraps it in, not the bare
 * /datasets/:id or /documents/:id route -- those still work (LegacyRedirect
 * makes the same lookup and forwards), but going straight there avoids the
 * extra hop for the common case this page exists for.
 */
const navigateToWrappingSession = async (
  kind: "dataset" | "document",
  sourceId: string,
  router: ReturnType<typeof useRouter>,
): Promise<void> => {
  try {
    const response = await fetch(`/api/${kind}s/${sourceId}/session`, { credentials: "include" });
    const body = (await response.json()) as { sessionId?: string };

    if (response.ok && body.sessionId) {
      router.push(`/sessions/${body.sessionId}`);
      return;
    }
  } catch {
    // Fall through to the legacy route below.
  }

  router.push(kind === "dataset" ? `/datasets/${sourceId}` : `/documents/${sourceId}`);
};

export default function NewSessionPage() {
  const router = useRouter();

  const [staged, setStaged] = useState<File[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [note, setNote] = useState("");
  // Bumped after every completed upload so AppShell's sidebar refetches.
  const [sidebarRefreshToken, setSidebarRefreshToken] = useState(0);
  // Set only for a batch of 2+ files, watched by the effect below that
  // triggers session synthesis once every item in it reaches a terminal
  // state. Null for a lone-file upload (no session possible or needed).
  const [activeBatch, setActiveBatch] = useState<string[] | null>(null);
  // Prompt 15.0 Part 4: whatever was typed alongside a multi-file batch,
  // used as the resulting combined session's display name.
  const [activeBatchName, setActiveBatchName] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollTimersRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const consecutiveFailuresRef = useRef<Map<string, number>>(new Map());
  const handledBatchKeyRef = useRef<string | null>(null);

  const setItemPhase = (id: string, phase: FilePhase): void => {
    setQueue((current) => current.map((item) => (item.id === id ? { ...item, phase } : item)));
  };

  const stopPollingFor = (id: string): void => {
    const timer = pollTimersRef.current.get(id);

    if (timer) {
      clearInterval(timer);
      pollTimersRef.current.delete(id);
    }
  };

  const startPolling = useCallback(
    (id: string, jobId: string, isSoleFileInBatch: boolean): void => {
      stopPollingFor(id);
      consecutiveFailuresRef.current.set(id, 0);

      const giveUp = (): void => {
        stopPollingFor(id);
        setItemPhase(id, { kind: "lost-connection", jobId });
      };

      const poll = async (): Promise<void> => {
        try {
          const response = await fetch(`/api/jobs/${jobId}`, { credentials: "include" });

          if (!response.ok) {
            const failures = (consecutiveFailuresRef.current.get(id) ?? 0) + 1;
            consecutiveFailuresRef.current.set(id, failures);

            if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
              giveUp();
            }

            return;
          }

          consecutiveFailuresRef.current.set(id, 0);

          const body = (await response.json()) as JobStatusBody;

          if (body.status === "completed") {
            stopPollingFor(id);

            // Section 10.0: a document job's completion carries documentId
            // instead of datasetId -- checked first since the two are
            // mutually exclusive on any one job.
            if (body.documentId) {
              setItemPhase(id, { kind: "done", datasetId: null, documentId: body.documentId });
              setSidebarRefreshToken((token) => token + 1);

              if (isSoleFileInBatch) {
                void navigateToWrappingSession("document", body.documentId, router);
              }
            } else if (body.datasetId) {
              setItemPhase(id, { kind: "done", datasetId: body.datasetId, documentId: null });
              setSidebarRefreshToken((token) => token + 1);

              if (isSoleFileInBatch) {
                void navigateToWrappingSession("dataset", body.datasetId, router);
              }
            } else {
              setItemPhase(id, {
                kind: "job-failed",
                jobId,
                error: "Job completed with no dataset or document attached.",
              });
            }

            return;
          }

          if (body.status === "failed") {
            stopPollingFor(id);
            setItemPhase(id, { kind: "job-failed", jobId, error: body.error });
            return;
          }

          setItemPhase(id, {
            kind: "processing",
            jobId,
            datasetId: body.datasetId,
            documentId: body.documentId,
            status: body.status,
          });
        } catch {
          const failures = (consecutiveFailuresRef.current.get(id) ?? 0) + 1;
          consecutiveFailuresRef.current.set(id, failures);

          if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
            giveUp();
          }
        }
      };

      void poll();
      pollTimersRef.current.set(id, setInterval(() => void poll(), POLL_INTERVAL_MS));
    },
    [router],
  );

  const uploadOne = async (
    id: string,
    file: File,
    isSoleFileInBatch: boolean,
    intent: string,
  ): Promise<void> => {
    setItemPhase(id, { kind: "uploading" });

    try {
      const form = new FormData();
      form.append("file", file);

      // Prompt 15.0 Part 4: only wired for the common case (one clear
      // intent statement against one file). A multi-file batch's note is
      // used as the resulting combined session's name instead (see the
      // POST /api/sessions call below) -- passing it into every file's own
      // independent config/summary generation isn't built; see ISSUES.
      if (isSoleFileInBatch && intent.trim().length > 0) {
        form.append("intent", intent.trim());
      }

      const response = await fetch("/api/uploads", {
        method: "POST",
        credentials: "include",
        body: form,
      });

      const body = (await response.json()) as UploadResponseBody;

      if (!response.ok) {
        // Shows the server's real message verbatim -- e.g. the actual
        // configured size limit on a 413, not a client-guessed number.
        setItemPhase(id, {
          kind: "upload-error",
          message:
            (body as any).detail ||
            body.error ||
            `Upload failed (status ${response.status}).`,
        });
        return;
      }

      if (body.status === "duplicate_noop" && (body.existingDatasetId || body.existingDocumentId)) {
        if (!isSoleFileInBatch) {
          setItemPhase(id, {
            kind: "done",
            datasetId: body.existingDatasetId ?? null,
            documentId: body.existingDocumentId ?? null,
          });
          return;
        }

        setItemPhase(id, {
          kind: "duplicate",
          existingDatasetId: body.existingDatasetId ?? null,
          existingDocumentId: body.existingDocumentId ?? null,
          message: body.message ?? "File already processed.",
        });
        return;
      }

      if (body.requiresUserChoice && body.fileId && (body.existingDatasetId || body.existingDocumentId)) {
        setItemPhase(id, {
          kind: "collision",
          fileId: body.fileId,
          existingDatasetId: body.existingDatasetId ?? null,
          existingDocumentId: body.existingDocumentId ?? null,
          message: body.message ?? "A dataset with this filename exists.",
          submitting: false,
        });
        return;
      }

      if (body.jobId && (body.datasetId || body.documentId)) {
        setItemPhase(id, {
          kind: "processing",
          jobId: body.jobId,
          datasetId: body.datasetId ?? null,
          documentId: body.documentId ?? null,
          status: "queued",
        });
        startPolling(id, body.jobId, isSoleFileInBatch);
        return;
      }

      setItemPhase(id, { kind: "upload-error", message: "Unexpected response from the server." });
    } catch (error: unknown) {
      setItemPhase(id, {
        kind: "upload-error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const confirmCollision = async (id: string, choice: "update_existing" | "create_new"): Promise<void> => {
    const item = queue.find((entry) => entry.id === id);

    if (!item || item.phase.kind !== "collision") {
      return;
    }

    const { fileId, existingDatasetId, existingDocumentId } = item.phase;
    setItemPhase(id, { ...item.phase, submitting: true });

    try {
      const response = await fetch("/api/uploads/confirm", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          existingDocumentId ? { fileId, existingDocumentId, choice } : { fileId, existingDatasetId, choice },
        ),
      });

      const body = (await response.json()) as UploadResponseBody;

      if (!response.ok || !body.jobId || !(body.datasetId || body.documentId)) {
        setItemPhase(id, {
          kind: "upload-error",
          message: body.error ?? `Confirmation failed (status ${response.status}).`,
        });
        return;
      }

      setItemPhase(id, {
        kind: "processing",
        jobId: body.jobId,
        datasetId: body.datasetId ?? null,
        documentId: body.documentId ?? null,
        status: "queued",
      });
      startPolling(id, body.jobId, queue.length === 1);
    } catch (error: unknown) {
      setItemPhase(id, {
        kind: "upload-error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const stageFiles = (files: FileList | File[] | null): void => {
    if (!files) {
      return;
    }

    const accepted: File[] = [];
    const badNames: string[] = [];

    for (const file of Array.from(files)) {
      if (hasSupportedExtension(file.name)) {
        accepted.push(file);
      } else {
        badNames.push(file.name);
      }
    }

    if (badNames.length > 0) {
      setRejected(badNames);
    }

    if (accepted.length > 0) {
      setStaged((current) => [...current, ...accepted]);
    }
  };

  const removeStaged = (index: number): void => {
    setStaged((current) => current.filter((_, i) => i !== index));
  };

  // Sequential by design: each file goes through the exact same
  // single-file upload -> poll -> complete flow as before, one after
  // another, so per-file behaviour is identical to the pre-shell homepage.
  // Only the "what happens on completion" step changes with batch size:
  // a lone file still navigates straight to its dashboard/summary; a batch
  // of several just marks each one done and lets the sidebar list them.
  const startUploadBatch = async (): Promise<void> => {
    if (staged.length === 0) {
      return;
    }

    const filesToUpload = staged;
    const isSoleFileInBatch = filesToUpload.length === 1;
    const intentAtSubmitTime = note;
    const newItems: QueueItem[] = filesToUpload.map((file, idx) => ({
      id: `f-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
      fileName: file.name,
      phase: { kind: "uploading" },
    }));

    setStaged([]);
    setNote("");
    setQueue((current) => [...newItems, ...current]);

    if (newItems.length > 1) {
      setActiveBatch(newItems.map((item) => item.id));
      setActiveBatchName(intentAtSubmitTime);
    }

    for (let index = 0; index < filesToUpload.length; index += 1) {
      await uploadOne(newItems[index]!.id, filesToUpload[index]!, isSoleFileInBatch, intentAtSubmitTime);
    }
  };

  // Session synthesis's trigger. uploadOne above starts polling and
  // returns immediately -- it does not wait for a job to finish -- so a
  // batch's actual completion can only be detected here, watching `queue`
  // as each item's poll timer independently updates its phase over time.
  // Fires once per distinct batch (handledBatchKeyRef), the moment every
  // item in it has reached a terminal state, successful or not.
  useEffect(() => {
    if (!activeBatch) {
      return;
    }

    const batchKey = activeBatch.join(",");

    if (handledBatchKeyRef.current === batchKey) {
      return;
    }

    const items = queue.filter((item) => activeBatch.includes(item.id));

    if (items.length !== activeBatch.length) {
      return;
    }

    const isTerminal = (phase: FilePhase): boolean =>
      phase.kind === "done" ||
      phase.kind === "duplicate" ||
      phase.kind === "upload-error" ||
      phase.kind === "job-failed" ||
      phase.kind === "lost-connection";

    if (!items.every((item) => isTerminal(item.phase))) {
      return;
    }

    handledBatchKeyRef.current = batchKey;

    const datasetIds: string[] = [];
    const documentIds: string[] = [];

    for (const item of items) {
      if (item.phase.kind === "done") {
        if (item.phase.datasetId) datasetIds.push(item.phase.datasetId);
        if (item.phase.documentId) documentIds.push(item.phase.documentId);
      } else if (item.phase.kind === "duplicate") {
        if (item.phase.existingDatasetId) datasetIds.push(item.phase.existingDatasetId);
        if (item.phase.existingDocumentId) documentIds.push(item.phase.existingDocumentId);
      }
    }

    // Fewer than two usable sources: nothing to combine. Leave the queue's
    // per-file results exactly as they are (including whichever failed).
    if (datasetIds.length + documentIds.length < 2) {
      setActiveBatch(null);
      return;
    }

    void (async () => {
      try {
        const response = await fetch("/api/sessions", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            datasetIds,
            documentIds,
            name: activeBatchName.trim() || undefined,
          }),
        });

        const body = (await response.json()) as { sessionId?: string; error?: string };

        if (response.ok && body.sessionId) {
          router.push(`/sessions/${body.sessionId}`);
        }
        // A failed synthesis call is non-fatal here: each file's own
        // upload already succeeded and is visible in the queue below,
        // exactly as if this batch had never been grouped into a session.
      } finally {
        setActiveBatch(null);
      }
    })();
  }, [activeBatch, activeBatchName, queue, router]);

  const onDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragActive(false);
    stageFiles(event.dataTransfer.files);
  };

  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function loadSessions() {
      try {
        const res = await fetch("/api/sessions?limit=8", { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          if (!cancelled && Array.isArray(data.sessions)) {
            setRecentSessions(data.sessions);
          }
        }
      } catch {
        // non-fatal error fallback
      } finally {
        if (!cancelled) setSessionsLoading(false);
      }
    }
    void loadSessions();
    return () => {
      cancelled = true;
    };
  }, [sidebarRefreshToken]);

  useEffect(() => {
    const el = promptTextareaRef.current;

    if (!el) {
      return;
    }

    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 96), 320)}px`;
  }, [note]);

  return (
    <AppShell refreshToken={sidebarRefreshToken}>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={onDrop}
        className="mx-auto flex max-w-3xl flex-col gap-6 py-10 px-4"
      >
        {/* Centered Hero Composition with Treelife brand identity */}
        <div className="text-center space-y-3 pt-2">
          <div className="flex justify-center">
            <TreelifeLogo size="lg" showTagline={true} />
          </div>
          
          <div className="pt-2">
            <div className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--color-forest-surface)] px-3 py-1 text-xs font-semibold text-[color:var(--color-forest)] border border-[color:var(--color-forest-bright)]/20 shadow-2xs">
              <span className="text-[11px]">✦</span> Intelligent Analytics & Cross-Source Synthesis
            </div>
          </div>

          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-[color:var(--color-forest)]">
            What would you like to analyze?
          </h1>
          <p className="mx-auto max-w-xl text-sm leading-relaxed text-[color:var(--color-steel)]">
            Describe your analytical goal, upload datasets and documents, and let Treelife&apos;s Bot synthesize executive insights, live KPI cards, and cross-source connections.
          </p>
        </div>

        {/* Clickable Example Prompt Chips */}
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          <span className="text-xs font-medium text-[color:var(--color-steel)]">Try prompt:</span>
          {[
            { label: "Build an exec overview", prompt: "Build an executive overview combining attrition numbers with leadership takeaways" },
            { label: "Focus on department breakdown", prompt: "Focus on department-by-department breakdown and highlight outlier teams" },
            { label: "Just give me raw numbers", prompt: "Just give me raw counts, KPIs, and summary tables with no added narrative" },
            { label: "Attrition & tenure risk deep dive", prompt: "Deep dive into first 90-day exits, tenure buckets, and performance-based separations" },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                setNote(item.prompt);
                promptTextareaRef.current?.focus();
              }}
              className="inline-flex items-center gap-1 rounded-full border border-[color:var(--color-cloud)] bg-white px-3 py-1 text-xs font-medium text-[color:var(--color-ink)] shadow-2xs transition-all duration-150 hover:border-[color:var(--color-forest-bright)] hover:bg-[color:var(--color-forest-surface)] hover:text-[color:var(--color-forest)] hover:shadow-xs active:scale-95"
            >
              <span>✨</span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        {/* Main Input Form with Focus Ring & Glow */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void startUploadBatch();
          }}
          className="flex flex-col gap-4 rounded-2xl border border-[color:var(--color-cloud)] bg-white p-5 shadow-sm transition-all duration-200 focus-within:border-[color:var(--color-forest)] focus-within:ring-4 focus-within:ring-[color:var(--color-forest-bright)]/10"
        >
          <div>
            <label htmlFor="landing-note" className="block text-xs font-semibold uppercase tracking-wider text-[color:var(--color-steel)] mb-2">
              Framing & Instructions (Optional)
            </label>
            <textarea
              ref={promptTextareaRef}
              id="landing-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder='e.g. "Focus on executive takeaways and department breakdown with stop/start/continue categories"...'
              rows={3}
              style={{ minHeight: "84px" }}
              className="w-full resize-none rounded-xl border border-[color:var(--color-cloud)]/80 bg-[color:var(--color-cloud-light)]/40 px-3.5 py-2.5 text-sm leading-relaxed text-[color:var(--color-ink)] placeholder-[color:var(--color-steel-light)] focus:border-[color:var(--color-forest)] focus:bg-white focus:outline-none transition-colors"
            />
          </div>

          {/* Dedicated Drag-and-Drop Upload Target */}
          <div
            onClick={() => fileInputRef.current?.click()}
            className={`group relative flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center transition-all duration-200 ${
              dragActive
                ? "border-[color:var(--color-forest-bright)] bg-[color:var(--color-forest-surface)] scale-[1.01]"
                : "border-[color:var(--color-cloud)] bg-[color:var(--color-cloud-light)]/30 hover:border-[color:var(--color-forest-bright)] hover:bg-[color:var(--color-forest-surface)]/50"
            }`}
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white shadow-xs group-hover:scale-110 transition-transform duration-200">
              <svg
                className="h-6 w-6 text-[color:var(--color-forest)]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                />
              </svg>
            </div>
            <p className="mt-2.5 text-sm font-semibold text-[color:var(--color-forest)]">
              Click to choose files <span className="font-normal text-[color:var(--color-steel)]">or drag and drop here</span>
            </p>
            <p className="mt-1 text-xs text-[color:var(--color-steel-light)]">
              Supported formats: Excel (.xlsx), CSV (.csv), Word (.docx), PDF (.pdf), Text (.txt)
            </p>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={supportedExtensions().join(",")}
              onChange={(event) => {
                stageFiles(event.target.files);
                event.target.value = "";
              }}
              className="hidden"
            />
          </div>

          {/* Staged Files & Action Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[color:var(--color-cloud)]/80">
            <div className="flex flex-wrap items-center gap-2">
              {staged.length === 0 ? (
                <span className="text-xs text-[color:var(--color-steel)] italic">
                  No files staged yet. Attach at least one file to create a dashboard.
                </span>
              ) : (
                staged.map((file, index) => (
                  <StagedFileChip key={`${file.name}-${index}`} file={file} onRemove={() => removeStaged(index)} />
                ))
              )}
            </div>

            <button
              type="submit"
              disabled={staged.length === 0}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[color:var(--color-forest)] px-5 py-2.5 text-sm font-semibold text-white shadow-xs transition-all duration-150 hover:bg-[color:var(--color-forest-mid)] hover:shadow-md active:scale-95 disabled:opacity-40 disabled:pointer-events-none"
            >
              <span>🚀</span>
              <span>
                {staged.length === 0
                  ? "Attach files to start"
                  : `Synthesize Dashboard (${staged.length} file${staged.length === 1 ? "" : "s"})`}
              </span>
            </button>
          </div>
        </form>

        {rejected.length > 0 ? (
          <div role="alert" className="rounded-xl border border-[color:var(--color-risk-high)]/30 bg-[color:var(--color-risk-high-surface)] p-3 text-xs font-medium text-[color:var(--color-risk-high)]">
            Unsupported format: {rejected.join(", ")}. Allowed: {supportedExtensions().join(", ")}.
          </div>
        ) : null}

        {queue.length > 0 ? (
          <div className="flex w-full flex-col gap-3">
            {queue.map((item) => (
              <QueueItemCard
                key={item.id}
                item={item}
                onConfirmCollision={(choice) => void confirmCollision(item.id, choice)}
                onRetryPolling={() => {
                  if (item.phase.kind === "lost-connection") {
                    startPolling(item.id, item.phase.jobId, queue.length === 1);
                  }
                }}
                onDismiss={() => setQueue((current) => current.filter((entry) => entry.id !== item.id))}
              />
            ))}
          </div>
        ) : null}

        {/* Executive Memory & Prior User Sessions */}
        <section className="mt-4 flex flex-col gap-3.5 border-t border-[color:var(--color-cloud)]/80 pt-6" aria-labelledby="executive-memory-heading">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-[color:var(--color-forest-surface)] text-xs text-[color:var(--color-forest)] font-bold border border-[color:var(--color-forest-bright)]/20 shadow-2xs">
                🧠
              </span>
              <div>
                <h2 id="executive-memory-heading" className="text-sm font-bold text-[color:var(--color-forest)]">
                  Executive Memory & Past Sessions
                </h2>
                <p className="text-[11px] text-[color:var(--color-steel)]">
                  Pick up where you left off or synthesize a new dataset above
                </p>
              </div>
            </div>

            {recentSessions.length > 0 ? (
              <span className="rounded-full bg-[color:var(--color-forest-surface)] px-2.5 py-0.5 text-[11px] font-semibold text-[color:var(--color-forest)] border border-[color:var(--color-forest-bright)]/20 shadow-2xs">
                {recentSessions.length} session{recentSessions.length === 1 ? "" : "s"} in memory
              </span>
            ) : null}
          </div>

          {sessionsLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" aria-busy="true">
              {[1, 2].map((i) => (
                <div key={i} className="h-24 animate-pulse rounded-2xl border border-[color:var(--color-cloud)] bg-white/70 p-4 shadow-2xs" />
              ))}
            </div>
          ) : recentSessions.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {recentSessions.map((s) => {
                const totalSources = s.datasetCount + s.documentCount;
                const isSingleDataset = s.datasetCount === 1 && s.documentCount === 0;
                const isSingleDoc = s.documentCount === 1 && s.datasetCount === 0;

                return (
                  <Link
                    key={s.id}
                    href={`/sessions/${s.id}`}
                    className="group relative flex flex-col justify-between rounded-2xl border border-[color:var(--color-cloud)] bg-white p-4 shadow-2xs transition-all duration-200 hover:-translate-y-0.5 hover:border-[color:var(--color-forest-bright)] hover:shadow-xs"
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2 pb-2">
                        <span className="inline-flex items-center gap-1 rounded-md bg-[color:var(--color-cloud-light)] px-2 py-0.5 text-[10px] font-bold text-[color:var(--color-forest)]">
                          <span>{isSingleDataset ? "📊" : isSingleDoc ? "📑" : "⚡"}</span>
                          <span>
                            {isSingleDataset
                              ? "Spreadsheet"
                              : isSingleDoc
                              ? "Document"
                              : "Cross-Source Synthesis"}
                          </span>
                        </span>
                        <span className="text-[10px] text-[color:var(--color-steel)] font-medium">
                          {formatRelativeTime(s.updatedAt || s.createdAt)}
                        </span>
                      </div>

                      <h3 className="text-xs font-bold text-[color:var(--color-ink)] group-hover:text-[color:var(--color-forest)] transition-colors line-clamp-1">
                        {s.name}
                      </h3>

                      <p className="mt-1 text-[11px] text-[color:var(--color-steel)]">
                        {isSingleDataset && s.singleSource?.totalRows != null
                          ? `${s.singleSource.totalRows.toLocaleString("en-IN")} rows analyzed`
                          : isSingleDoc && s.singleSource?.keyPointsCount != null
                          ? `${s.singleSource.keyPointsCount} key strategic points`
                          : `${totalSources} source${totalSources === 1 ? "" : "s"} (${s.datasetCount} datasets, ${s.documentCount} docs)`}
                      </p>
                    </div>

                    <div className="mt-3 flex items-center justify-between border-t border-[color:var(--color-cloud)]/50 pt-2 text-[11px] font-semibold text-[color:var(--color-forest)]">
                      <span>Open Session</span>
                      <span className="transition-transform duration-150 group-hover:translate-x-1">→</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-[color:var(--color-cloud)] bg-[color:var(--color-cloud-light)]/30 p-6 text-center">
              <p className="text-xs font-medium text-[color:var(--color-steel)]">
                No past sessions yet. Upload a dataset or document above to begin your first synthesis.
              </p>
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}

/**
 * Prompt 15.0 Part 4: the attach control is now secondary, so a staged
 * file is a compact chip (name, size, type badge) sitting inline with it,
 * not the larger card Prompt 14.0 used when the dropzone was the page's
 * dominant element.
 */
const StagedFileChip = ({ file, onRemove }: { file: File; onRemove: () => void }) => {
  const fileType = fileTypeFromFilename(file.name);

  return (
    <span className="flex items-center gap-1.5 rounded-md border border-[color:var(--color-cloud)] bg-[color:var(--color-warm-white)] py-1 pl-2.5 pr-1.5 text-xs text-[color:var(--color-ink)]">
      <span className="max-w-[10rem] truncate font-medium">{file.name}</span>
      <span className="text-[color:var(--color-steel)]">{formatBytes(file.size)}</span>
      {fileType ? (
        <span className="rounded bg-[color:var(--color-cloud)] px-1 py-0.5 text-[9px] font-medium uppercase text-[color:var(--color-steel)]">
          {fileType}
        </span>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${file.name}`}
        className="ml-0.5 text-[color:var(--color-steel)] hover:text-[color:var(--color-risk-high)]"
      >
        ×
      </button>
    </span>
  );
};

const QueueItemCard = ({
  item,
  onConfirmCollision,
  onRetryPolling,
  onDismiss,
}: {
  item: QueueItem;
  onConfirmCollision: (choice: "update_existing" | "create_new") => void;
  onRetryPolling: () => void;
  onDismiss: () => void;
}) => {
  const { phase, fileName } = item;

  return (
    <div className="rounded-lg border border-[color:var(--color-cloud)] bg-white p-3 text-left text-sm">
      <p className="font-medium text-[color:var(--color-ink)]">{fileName}</p>

      {phase.kind === "uploading" ? (
        <p className="mt-1 text-xs text-[color:var(--color-steel)]">Uploading…</p>
      ) : null}

      {phase.kind === "upload-error" ? (
        <p role="alert" className="mt-1 text-xs text-[color:var(--color-risk-high)]">
          {phase.message}
        </p>
      ) : null}

      {phase.kind === "duplicate" ? (
        <p className="mt-1 text-xs text-[color:var(--color-steel)]">
          {phase.message}{" "}
          <a
            href={phase.existingDocumentId ? `/documents/${phase.existingDocumentId}` : `/datasets/${phase.existingDatasetId}`}
            className="font-medium text-[color:var(--color-cobalt-text)]"
          >
            {phase.existingDocumentId ? "Go to the existing summary" : "Go to the existing dashboard"}
          </a>
        </p>
      ) : null}

      {phase.kind === "collision" ? (
        <div className="mt-1 flex flex-col gap-2">
          <p className="text-xs text-[color:var(--color-steel)]">{phase.message}</p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={phase.submitting}
              onClick={() => onConfirmCollision("update_existing")}
              className="rounded-md border border-[color:var(--color-cloud)] px-2.5 py-1 text-xs font-medium text-[color:var(--color-ink)] disabled:opacity-50"
            >
              Update existing {phase.existingDocumentId ? "document" : "dataset"}
            </button>
            <button
              type="button"
              disabled={phase.submitting}
              onClick={() => onConfirmCollision("create_new")}
              className="rounded-md bg-[color:var(--color-forest)] px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              Create new {phase.existingDocumentId ? "document" : "dataset"}
            </button>
          </div>
          {phase.submitting ? <p className="text-xs text-[color:var(--color-steel)]">Submitting…</p> : null}
        </div>
      ) : null}

      {phase.kind === "processing" ? (
        <div className="mt-1">
          <p className="text-xs font-medium text-[color:var(--color-forest)]">
            {STATUS_LABELS[phase.status] ?? phase.status}
          </p>
          <ol className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-[color:var(--color-steel)]">
            {JOB_STEPS.map((step) => {
              const currentIndex = JOB_STEPS.indexOf(phase.status as (typeof JOB_STEPS)[number]);
              const stepIndex = JOB_STEPS.indexOf(step);
              const done = currentIndex >= 0 && stepIndex < currentIndex;
              const active = step === phase.status;

              return (
                <li
                  key={step}
                  style={{
                    color: active ? "var(--color-forest)" : done ? "var(--color-steel)" : "var(--color-cloud)",
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {STATUS_LABELS[step]}
                  {done ? " ✓" : active ? " …" : ""}
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      {phase.kind === "job-failed" ? (
        <div className="mt-1">
          <p role="alert" className="text-xs font-medium text-[color:var(--color-risk-high)]">
            Processing failed.
          </p>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-[color:var(--color-warm-white)] p-2 text-[11px] text-[color:var(--color-steel)]">
            {phase.error ?? "No technical detail was stored for this failure."}
          </pre>
        </div>
      ) : null}

      {phase.kind === "lost-connection" ? (
        <div className="mt-1 flex items-center gap-2">
          <p role="alert" className="text-xs text-[color:var(--color-risk-high)]">
            Lost connection while checking status.
          </p>
          <button
            type="button"
            onClick={onRetryPolling}
            className="text-xs font-medium text-[color:var(--color-cobalt-text)]"
          >
            Retry
          </button>
        </div>
      ) : null}

      {phase.kind === "done" ? (
        <p className="mt-1 text-xs text-[color:var(--color-risk-low-text)]">
          Ready.{" "}
          <a
            href={phase.documentId ? `/documents/${phase.documentId}` : `/datasets/${phase.datasetId}`}
            className="font-medium text-[color:var(--color-cobalt-text)]"
          >
            {phase.documentId ? "Open summary" : "Open dashboard"}
          </a>
        </p>
      ) : null}

      {phase.kind !== "uploading" && phase.kind !== "processing" && phase.kind !== "collision" ? (
        <button
          type="button"
          onClick={onDismiss}
          className="mt-2 text-[11px] text-[color:var(--color-steel)] hover:text-[color:var(--color-ink)]"
        >
          Dismiss
        </button>
      ) : null}
    </div>
  );
};

"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { hasSupportedExtension, supportedExtensions } from "@/lib/uploadValidation";

/**
 * Landing page. Payload, the worker, Gemini and Claude are all connected;
 * this lists whatever datasets actually exist right now (zero hardcoded
 * knowledge of any of them, same as every other page here) and lets an
 * admin upload a new file end to end: drop/pick -> POST /api/uploads ->
 * handle whichever of the three real responses comes back -> poll the job
 * -> land on the dashboard once it's ready. DashboardRenderer.tsx's own SSE
 * wiring takes over from there; nothing here duplicates it.
 */

type DatasetSummary = {
  id: string;
  name: string;
  status: string;
  totalRows: number;
};

type DatasetsPhase =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "error"; message: string }
  | { kind: "ready"; datasets: DatasetSummary[] };

type UploadResponseBody = {
  status?: string;
  jobId?: string;
  fileId?: string;
  datasetId?: string;
  existingDatasetId?: string;
  requiresUserChoice?: boolean;
  message?: string;
  error?: string;
};

type JobStatusBody = {
  status: string;
  error: string | null;
  datasetId: string | null;
};

type UploadPhase =
  | { kind: "idle" }
  | { kind: "rejected"; reason: string }
  | { kind: "uploading"; fileName: string }
  | { kind: "upload-error"; message: string }
  | { kind: "duplicate"; existingDatasetId: string; message: string }
  | {
      kind: "collision";
      fileId: string;
      existingDatasetId: string;
      message: string;
      submitting: boolean;
    }
  | { kind: "processing"; jobId: string; datasetId: string | null; status: string }
  | { kind: "job-failed"; jobId: string; error: string | null }
  | { kind: "lost-connection"; jobId: string; datasetId: string | null };

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

export default function HomePage() {
  const router = useRouter();

  const [datasetsPhase, setDatasetsPhase] = useState<DatasetsPhase>({
    kind: "loading",
  });
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>({ kind: "idle" });
  const [dragActive, setDragActive] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const consecutiveFailuresRef = useRef(0);

  const loadDatasets = useCallback(async (): Promise<void> => {
    setDatasetsPhase({ kind: "loading" });

    try {
      const response = await fetch("/api/datasets", { credentials: "include" });

      if (response.status === 401) {
        setDatasetsPhase({ kind: "signed-out" });
        return;
      }

      if (!response.ok) {
        setDatasetsPhase({
          kind: "error",
          message: `Could not load datasets (status ${response.status}).`,
        });
        return;
      }

      const body = (await response.json()) as { datasets: DatasetSummary[] };
      setDatasetsPhase({ kind: "ready", datasets: body.datasets });
    } catch (error: unknown) {
      setDatasetsPhase({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    void loadDatasets();
  }, [loadDatasets]);

  const stopPolling = (): void => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  // Never leave an interval running past unmount.
  useEffect(() => stopPolling, []);

  const startPolling = useCallback(
    (jobId: string): void => {
      stopPolling();
      consecutiveFailuresRef.current = 0;

      const giveUp = (): void => {
        stopPolling();
        setUploadPhase((current) =>
          current.kind === "processing"
            ? { kind: "lost-connection", jobId, datasetId: current.datasetId }
            : current,
        );
      };

      const poll = async (): Promise<void> => {
        try {
          const response = await fetch(`/api/jobs/${jobId}`, {
            credentials: "include",
          });

          if (!response.ok) {
            consecutiveFailuresRef.current += 1;

            if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_POLL_FAILURES) {
              giveUp();
            }

            return;
          }

          consecutiveFailuresRef.current = 0;

          const body = (await response.json()) as JobStatusBody;

          if (body.status === "completed") {
            stopPolling();

            if (body.datasetId) {
              router.push(`/datasets/${body.datasetId}`);
            } else {
              setUploadPhase({
                kind: "job-failed",
                jobId,
                error: "Job completed with no dataset attached.",
              });
            }

            return;
          }

          if (body.status === "failed") {
            stopPolling();
            setUploadPhase({ kind: "job-failed", jobId, error: body.error });
            return;
          }

          setUploadPhase({
            kind: "processing",
            jobId,
            datasetId: body.datasetId,
            status: body.status,
          });
        } catch {
          consecutiveFailuresRef.current += 1;

          if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_POLL_FAILURES) {
            giveUp();
          }
        }
      };

      void poll();
      pollTimerRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);
    },
    [router],
  );

  const handleFiles = async (files: FileList | null): Promise<void> => {
    const file = files?.[0];

    if (!file) {
      return;
    }

    if (!hasSupportedExtension(file.name)) {
      setUploadPhase({
        kind: "rejected",
        reason: `"${file.name}" has an unsupported extension. Allowed: ${supportedExtensions().join(", ")}.`,
      });
      return;
    }

    setUploadPhase({ kind: "uploading", fileName: file.name });

    try {
      const form = new FormData();
      form.append("file", file);

      const response = await fetch("/api/uploads", {
        method: "POST",
        credentials: "include",
        body: form,
      });

      const body = (await response.json()) as UploadResponseBody;

      if (!response.ok) {
        // Shows the server's real message verbatim -- e.g. the actual
        // configured size limit on a 413, not a client-guessed number.
        setUploadPhase({
          kind: "upload-error",
          message: body.error ?? `Upload failed (status ${response.status}).`,
        });
        return;
      }

      if (body.status === "duplicate_noop" && body.existingDatasetId) {
        setUploadPhase({
          kind: "duplicate",
          existingDatasetId: body.existingDatasetId,
          message: body.message ?? "File already processed.",
        });
        return;
      }

      if (body.requiresUserChoice && body.fileId && body.existingDatasetId) {
        setUploadPhase({
          kind: "collision",
          fileId: body.fileId,
          existingDatasetId: body.existingDatasetId,
          message: body.message ?? "A dataset with this filename exists.",
          submitting: false,
        });
        return;
      }

      if (body.jobId && body.datasetId) {
        setUploadPhase({
          kind: "processing",
          jobId: body.jobId,
          datasetId: body.datasetId,
          status: "queued",
        });
        startPolling(body.jobId);
        return;
      }

      setUploadPhase({
        kind: "upload-error",
        message: "Unexpected response from the server.",
      });
    } catch (error: unknown) {
      setUploadPhase({
        kind: "upload-error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const confirmCollision = async (
    choice: "update_existing" | "create_new",
  ): Promise<void> => {
    if (uploadPhase.kind !== "collision") {
      return;
    }

    const { fileId, existingDatasetId } = uploadPhase;
    setUploadPhase({ ...uploadPhase, submitting: true });

    try {
      const response = await fetch("/api/uploads/confirm", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId, existingDatasetId, choice }),
      });

      const body = (await response.json()) as UploadResponseBody;

      if (!response.ok || !body.jobId || !body.datasetId) {
        setUploadPhase({
          kind: "upload-error",
          message: body.error ?? `Confirmation failed (status ${response.status}).`,
        });
        return;
      }

      setUploadPhase({
        kind: "processing",
        jobId: body.jobId,
        datasetId: body.datasetId,
        status: "queued",
      });
      startPolling(body.jobId);
    } catch (error: unknown) {
      setUploadPhase({
        kind: "upload-error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const resetUpload = (): void => {
    stopPolling();
    setUploadPhase({ kind: "idle" });
    void loadDatasets();
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragActive(false);
    void handleFiles(event.dataTransfer.files);
  };

  const showDropzone =
    uploadPhase.kind === "idle" ||
    uploadPhase.kind === "rejected" ||
    uploadPhase.kind === "uploading" ||
    uploadPhase.kind === "upload-error";

  return (
    <main
      style={{
        padding: 24,
        maxWidth: 720,
        margin: "0 auto",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1>Analytics Dashboard</h1>
      <p>Upload a file and a dashboard is generated for it automatically.</p>

      {showDropzone ? (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
          style={{
            border: `2px dashed ${dragActive ? "#0d3b26" : "#c9c9c9"}`,
            borderRadius: 8,
            padding: 32,
            textAlign: "center",
            background: dragActive ? "#f0f7f2" : "#fafafa",
            marginTop: 16,
          }}
        >
          {uploadPhase.kind === "uploading" ? (
            <p>Uploading &quot;{uploadPhase.fileName}&quot;…</p>
          ) : (
            <>
              <p>Drag a file here, or</p>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                style={{
                  padding: "8px 16px",
                  borderRadius: 6,
                  border: "1px solid #0d3b26",
                  background: "#0d3b26",
                  color: "#fff",
                  cursor: "pointer",
                }}
              >
                Choose a file
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept={supportedExtensions().join(",")}
                onChange={(event) => void handleFiles(event.target.files)}
                style={{ display: "none" }}
              />
              <p style={{ fontSize: 12, color: "#666", marginTop: 12 }}>
                Supported: {supportedExtensions().join(", ")}
              </p>
            </>
          )}
        </div>
      ) : null}

      {uploadPhase.kind === "rejected" ? (
        <p role="alert" style={{ color: "#c0392b" }}>
          {uploadPhase.reason}
        </p>
      ) : null}

      {uploadPhase.kind === "upload-error" ? (
        <p role="alert" style={{ color: "#c0392b" }}>
          {uploadPhase.message}{" "}
          <button type="button" onClick={resetUpload}>
            Try again
          </button>
        </p>
      ) : null}

      {uploadPhase.kind === "duplicate" ? (
        <div style={{ marginTop: 16, padding: 16, border: "1px solid #cce3d8", borderRadius: 8 }}>
          <p>{uploadPhase.message}</p>
          <p>
            <a href={`/datasets/${uploadPhase.existingDatasetId}`}>
              Go to the existing dashboard
            </a>{" "}
            &middot; <button type="button" onClick={resetUpload}>Upload something else</button>
          </p>
        </div>
      ) : null}

      {uploadPhase.kind === "collision" ? (
        <div style={{ marginTop: 16, padding: 16, border: "1px solid #e6d5a8", borderRadius: 8 }}>
          <p>{uploadPhase.message}</p>
          <button
            type="button"
            disabled={uploadPhase.submitting}
            onClick={() => void confirmCollision("update_existing")}
            style={{ marginRight: 8 }}
          >
            Update existing dataset
          </button>
          <button
            type="button"
            disabled={uploadPhase.submitting}
            onClick={() => void confirmCollision("create_new")}
          >
            Create new dataset
          </button>
          {uploadPhase.submitting ? <p>Submitting…</p> : null}
        </div>
      ) : null}

      {uploadPhase.kind === "processing" ? (
        <div style={{ marginTop: 16, padding: 16, border: "1px solid #cce3d8", borderRadius: 8 }}>
          <p>
            <strong>{STATUS_LABELS[uploadPhase.status] ?? uploadPhase.status}</strong>
          </p>
          <ol style={{ paddingLeft: 20 }}>
            {JOB_STEPS.map((step) => {
              const currentIndex = JOB_STEPS.indexOf(
                uploadPhase.status as (typeof JOB_STEPS)[number],
              );
              const stepIndex = JOB_STEPS.indexOf(step);
              const done = currentIndex >= 0 && stepIndex < currentIndex;
              const active = step === uploadPhase.status;

              return (
                <li
                  key={step}
                  style={{
                    color: active ? "#0d3b26" : done ? "#666" : "#aaa",
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {STATUS_LABELS[step]}
                  {done ? " ✓" : active ? " …" : ""}
                </li>
              );
            })}
          </ol>
          <p style={{ fontSize: 12, color: "#666" }}>
            Checking every {POLL_INTERVAL_MS / 1000}s. This page will move to
            the dashboard automatically once it's ready.
          </p>
        </div>
      ) : null}

      {uploadPhase.kind === "job-failed" ? (
        <div style={{ marginTop: 16, padding: 16, border: "1px solid #f0c9c2", borderRadius: 8 }}>
          <p role="alert" style={{ color: "#c0392b" }}>
            <strong>Processing failed.</strong>
          </p>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              fontSize: 12,
              color: "#444",
              background: "#f7f6f2",
              padding: 8,
              borderRadius: 4,
            }}
          >
            {uploadPhase.error ?? "No technical detail was stored for this failure."}
          </pre>
          <button type="button" onClick={resetUpload}>
            Try a different file
          </button>
        </div>
      ) : null}

      {uploadPhase.kind === "lost-connection" ? (
        <div style={{ marginTop: 16, padding: 16, border: "1px solid #f0c9c2", borderRadius: 8 }}>
          <p role="alert" style={{ color: "#c0392b" }}>
            Lost connection while checking job {uploadPhase.jobId}&apos;s
            status. It may still be running on the server.
          </p>
          <button type="button" onClick={() => startPolling(uploadPhase.jobId)}>
            Retry checking
          </button>{" "}
          <button type="button" onClick={resetUpload}>
            Start over
          </button>
        </div>
      ) : null}

      <hr style={{ margin: "32px 0", border: "none", borderTop: "1px solid #e8eef4" }} />

      {datasetsPhase.kind === "loading" ? <p>Loading your datasets…</p> : null}

      {datasetsPhase.kind === "signed-out" ? (
        <p>
          <a href="/login">Sign in</a> to view your datasets and upload new
          files.
        </p>
      ) : null}

      {datasetsPhase.kind === "error" ? (
        <p style={{ color: "#c0392b" }}>{datasetsPhase.message}</p>
      ) : null}

      {datasetsPhase.kind === "ready" ? (
        datasetsPhase.datasets.length === 0 ? (
          <p>No datasets yet. Upload a file above to get started.</p>
        ) : (
          <>
            <h2>Your datasets</h2>
            <ul>
              {datasetsPhase.datasets.map((dataset) => (
                <li key={dataset.id}>
                  <a href={`/datasets/${dataset.id}`}>{dataset.name}</a>{" "}
                  <span style={{ color: "#666" }}>
                    ({dataset.status}, {dataset.totalRows.toLocaleString("en-IN")}{" "}
                    rows)
                  </span>
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}
    </main>
  );
}

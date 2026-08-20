/**
 * Basic request & error logging utility, Sentry-ready.
 * If SENTRY_DSN is configured, it can forward errors to Sentry;
 * otherwise it formats structured diagnostic logs.
 */

export type ErrorContext = {
  path?: string;
  method?: string;
  userId?: string | number;
  sessionId?: string | number;
  datasetId?: string | number;
  documentId?: string | number;
  [key: string]: unknown;
};

export const captureException = (
  error: unknown,
  context?: ErrorContext,
): void => {
  const timestamp = new Date().toISOString();
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;

  const payload = {
    level: "error",
    timestamp,
    message: errorMessage,
    stack: errorStack,
    context: context ?? {},
  };

  console.error(`[MONITORING_ERROR] ${errorMessage}`, JSON.stringify(payload));

  // If a global Sentry instance is available (or when @sentry/nextjs is attached)
  if (typeof globalThis !== "undefined" && (globalThis as any).Sentry) {
    try {
      (globalThis as any).Sentry.captureException(error, {
        extra: context,
      });
    } catch {
      // Sentry dispatch failed silently
    }
  }
};

export const captureMessage = (
  message: string,
  level: "info" | "warn" | "error" = "info",
  context?: ErrorContext,
): void => {
  const timestamp = new Date().toISOString();

  const payload = {
    level,
    timestamp,
    message,
    context: context ?? {},
  };

  if (level === "warn") {
    console.warn(`[MONITORING_WARN] ${message}`, JSON.stringify(payload));
  } else if (level === "error") {
    console.error(`[MONITORING_ERROR] ${message}`, JSON.stringify(payload));
  } else {
    console.info(`[MONITORING_INFO] ${message}`, JSON.stringify(payload));
  }
};

export const logRequest = (
  req: Request,
  status: number,
  durationMs: number,
): void => {
  const url = new URL(req.url);

  console.info(
    `[HTTP] ${req.method} ${url.pathname} ${status} in ${Math.round(durationMs)}ms`,
  );
};

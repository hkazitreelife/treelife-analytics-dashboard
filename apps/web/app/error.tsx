"use client";

import { useEffect } from "react";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[APP_ERROR]", error);
  }, [error]);

  const isBillingError =
    error.message.toLowerCase().includes("billing") ||
    error.message.toLowerCase().includes("quota") ||
    error.message.toLowerCase().includes("credit");

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center p-6 text-center">
      <div className="max-w-md space-y-4 rounded-2xl border border-[color:var(--color-cloud)] bg-white p-6 shadow-sm">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-[color:var(--color-risk-high-surface)] text-xl font-bold text-[color:var(--color-risk-high)]">
          !
        </div>
        <h2 className="text-lg font-bold text-[color:var(--color-forest)]">
          {isBillingError ? "AI Service Quota Notice" : "Something went wrong"}
        </h2>
        <p className="text-xs leading-relaxed text-[color:var(--color-steel)]">
          {isBillingError
            ? "The AI processing service experienced a quota or billing limit. Please verify your provider account or try again in a moment."
            : error.message && error.message.length < 150 && !error.message.includes("{")
              ? error.message
              : "An unexpected error occurred while loading this view. You can try refreshing or returning to the home screen."}
        </p>

        <div className="flex justify-center gap-3 pt-2">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-xl bg-[color:var(--color-forest)] px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-[color:var(--color-forest)]/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="rounded-xl border border-[color:var(--color-cloud)] px-4 py-2 text-xs font-semibold text-[color:var(--color-ink)] hover:bg-[color:var(--color-cloud-light)]"
          >
            Back to Dashboard
          </a>
        </div>
      </div>
    </div>
  );
}

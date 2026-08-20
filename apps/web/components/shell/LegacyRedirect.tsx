"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { ErrorState, Skeleton } from "@/components/ui/primitives";

/**
 * Prompt 15.0 Part 1: /datasets/:id and /documents/:id stay directly
 * linkable (old bookmarks, direct navigation) but no longer render their
 * own shell -- they look up the single-source session that now wraps this
 * source and redirect there, the one place it's actually rendered from.
 */
export const LegacyRedirect = ({
  lookupUrl,
  label,
}: {
  lookupUrl: string;
  label: string;
}) => {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(lookupUrl, { credentials: "include" });
        const body = (await response.json()) as { sessionId?: string; error?: string };

        if (cancelled) {
          return;
        }

        if (!response.ok || !body.sessionId) {
          setError(body.error ?? `Could not find the session wrapping this ${label}.`);
          return;
        }

        router.replace(`/sessions/${body.sessionId}`);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [lookupUrl, label, router]);

  return (
    <AppShell>
      {error ? (
        <ErrorState title={`Could not open this ${label}`} detail={error} />
      ) : (
        <div className="space-y-4" aria-busy="true" aria-live="polite">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}
    </AppShell>
  );
};

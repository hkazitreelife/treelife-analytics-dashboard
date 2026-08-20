"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { TreelifeLogo } from "@/components/ui/BrandLogo";

export type AppShellProps = {
  children: ReactNode;
  /** Highlights the matching sidebar entry; omit on the landing state. */
  active?: { sessionId: string };
  /** Right panel content. Omitted entirely (not just hidden) on the landing state. */
  rightPanel?: ReactNode;
  /** Bump this to force the sidebar to refetch, e.g. right after an upload completes. */
  refreshToken?: number;
};

export const AppShell = ({ children, rightPanel }: AppShellProps) => {
  const [rightPanelOpen, setRightPanelOpen] = useState(false);

  return (
    <div className="mx-auto flex h-screen max-w-[1920px] gap-2 sm:gap-3 p-2 sm:p-3 bg-[color:var(--color-warm-white)] overflow-hidden">
      {/* Main Dashboard Area */}
      <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto rounded-xl sm:rounded-2xl border border-[color:var(--color-cloud)] bg-white p-3.5 sm:p-5 shadow-xs">
        {/* Header with Treelife Brand Logo and Action Buttons */}
        <div className="flex items-center justify-between pb-3.5 mb-3.5 sm:mb-4 border-b border-[color:var(--color-cloud)]/70 no-print min-h-[54px] sm:min-h-[62px] gap-2">
          <Link href="/new" className="hover:opacity-95 transition-opacity flex items-center shrink-0 py-0.5">
            <TreelifeLogo size="md" className="h-11 sm:h-14 md:h-16 w-auto max-w-[220px] sm:max-w-[320px]" />
          </Link>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {rightPanel ? (
              <button
                type="button"
                onClick={() => setRightPanelOpen(!rightPanelOpen)}
                className={`flex items-center gap-1 sm:gap-1.5 rounded-xl border px-2 sm:px-2.5 py-1.5 text-xs font-bold transition-all cursor-pointer shadow-2xs ${
                  rightPanelOpen
                    ? "bg-[color:var(--color-forest-surface)] border-[color:var(--color-forest-bright)] text-[color:var(--color-forest)]"
                    : "border-[color:var(--color-cloud)] bg-white text-[color:var(--color-forest)] hover:border-[color:var(--color-forest-bright)] hover:bg-[color:var(--color-forest-surface)]"
                }`}
              >
                <span>💬</span>
                <span className="hidden sm:inline">Assistant</span>
              </button>
            ) : null}

            <Link
              href="/admin/users"
              title="User Management"
              className="flex items-center gap-1 sm:gap-1.5 rounded-xl border border-[color:var(--color-cloud)] bg-white px-2 sm:px-2.5 py-1.5 text-xs font-bold text-[color:var(--color-ink)] shadow-2xs hover:border-[color:var(--color-forest-bright)] hover:bg-[color:var(--color-forest-surface)] transition-all"
            >
              <span>👥</span>
              <span className="hidden sm:inline">Users</span>
            </Link>

            <Link
              href="/new"
              title="New Session"
              className="flex items-center gap-1 sm:gap-1.5 rounded-xl bg-[color:var(--color-forest)] px-2.5 sm:px-3 py-1.5 text-xs font-bold text-white shadow-2xs transition-all duration-150 hover:bg-[color:var(--color-forest-mid)] hover:shadow-sm active:scale-95"
            >
              <span aria-hidden="true" className="text-sm font-extrabold leading-none">
                +
              </span>
              <span>New</span>
            </Link>
          </div>
        </div>

        {children}
      </main>

      {/* Co-Pilot / Assistant Panel: Responsive Desktop Sidebar & Mobile Slide-Over Drawer */}
      {rightPanel && rightPanelOpen ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-xs lg:static lg:inset-auto lg:bg-transparent lg:z-auto">
          <aside className="relative flex h-full w-[90vw] sm:w-[24rem] lg:w-[22rem] shrink-0 flex-col rounded-l-2xl lg:rounded-2xl border border-[color:var(--color-cloud)] bg-white p-3.5 shadow-2xl lg:shadow-xs transition-all duration-200">
            <div className="mb-2 flex items-center justify-between pb-2 border-b border-[color:var(--color-cloud)]/80">
              <div className="flex items-center gap-1.5">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[color:var(--color-forest-surface)] text-[color:var(--color-forest)] text-xs font-bold">
                  ✦
                </span>
                <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-forest)]">
                  Assistant & Co-Pilot
                </span>
              </div>
              <button
                type="button"
                onClick={() => setRightPanelOpen(false)}
                title="Close panel"
                aria-label="Close panel"
                className="flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold text-[color:var(--color-steel)] hover:bg-[color:var(--color-cloud-light)] hover:text-[color:var(--color-ink)] transition-colors"
              >
                ✕
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {rightPanel}
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
};

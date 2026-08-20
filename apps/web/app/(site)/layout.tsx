import type { ReactNode } from "react";

import "../globals.css";

/**
 * Its own complete root layout (Next.js "multiple root layouts" pattern):
 * this app has no shared top-level app/layout.tsx, because
 * (payload)/layout.tsx already renders a full <html>/<body> of its own
 * (Payload's RootLayout component does this internally) -- a shared root
 * layout on top of that produced a nested <html>-in-<body> hydration error
 * on every /admin page. Each top-level route group -- this one, (dashboard),
 * (payload) -- now provides its own <html>/<body> independently instead.
 *
 * Prompt 12.0: the homepage now shares the same three-column shell
 * (sidebar/center/right panel) as the dataset and document pages, so it
 * needs the same Tailwind tokens. app/globals.css moved out of (dashboard)
 * to a location both this layout and (dashboard)/layout.tsx can import;
 * (payload) still doesn't, so /admin is unaffected.
 *
 * suppressHydrationWarning on both tags: browser extensions (seen so far --
 * a "data-qb-installed" attribute, Grammarly's data-gr-ext-installed /
 * data-new-gr-c-s-check-loaded on other pages) inject attributes into
 * <html>/<body> before React hydrates. That's not a real mismatch -- it's
 * not code here doing a server/client branch, random values, or bad
 * nesting -- so it's suppressed at the two elements extensions actually
 * touch, the same fix (payload.config.ts's admin.suppressHydrationWarning)
 * already applies to Payload's own <html> tag on /admin.
 */

export const metadata = {
  title: "Treelife AI - Executive Intelligence & Analytics",
  description: "Upload-driven intelligent analytics powered by Treelife's Bot",
};

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="app-shell-root" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}

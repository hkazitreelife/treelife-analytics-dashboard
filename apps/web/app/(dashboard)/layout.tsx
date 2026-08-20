import type { ReactNode } from "react";

import "../globals.css";

/**
 * Its own complete root layout, same reasoning as (site)/layout.tsx's doc
 * comment: no shared top-level app/layout.tsx exists, because
 * (payload)/layout.tsx's Payload RootLayout already renders a full
 * <html>/<body> on its own, and a shared root layout on top of that
 * produced a nested <html> hydration error on every /admin page.
 *
 * Imports the same app/globals.css (site)/layout.tsx now also imports
 * (Prompt 12.0: one shared three-column shell needs the same Tailwind
 * tokens on both sides). Still not shared with (payload), which never
 * imports this file.
 *
 * suppressHydrationWarning on both tags: same reasoning as
 * (site)/layout.tsx -- browser extensions inject attributes into
 * <html>/<body> before React hydrates, which isn't a real mismatch.
 */

export const metadata = {
  title: "Treelife AI - Executive Dashboard",
  description: "Executive analytics and intelligent dashboard synthesis powered by Treelife's Bot",
};

export default function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <div className="dashboard-root">{children}</div>
      </body>
    </html>
  );
}

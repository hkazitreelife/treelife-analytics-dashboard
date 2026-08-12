import type { ReactNode } from "react";

import "./globals.css";

/**
 * Its own complete root layout, same reasoning as (site)/layout.tsx's doc
 * comment: no shared top-level app/layout.tsx exists, because
 * (payload)/layout.tsx's Payload RootLayout already renders a full
 * <html>/<body> on its own, and a shared root layout on top of that
 * produced a nested <html> hydration error on every /admin page.
 */

export const metadata = {
  title: "Analytics Dashboard",
  description: "Upload-driven intelligent analytics dashboard",
};

export default function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="dashboard-root">{children}</div>
      </body>
    </html>
  );
}

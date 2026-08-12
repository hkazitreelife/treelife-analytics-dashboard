import type { ReactNode } from "react";

/**
 * Its own complete root layout (Next.js "multiple root layouts" pattern):
 * this app has no shared top-level app/layout.tsx, because
 * (payload)/layout.tsx already renders a full <html>/<body> of its own
 * (Payload's RootLayout component does this internally) -- a shared root
 * layout on top of that produced a nested <html>-in-<body> hydration error
 * on every /admin page. Each top-level route group -- this one, (dashboard),
 * (payload) -- now provides its own <html>/<body> independently instead.
 *
 * Deliberately no CSS import here: the homepage stays plain-styled (inline
 * styles only), the same convention it already used before this fix.
 * (dashboard)'s Tailwind globals.css is scoped to (dashboard) only, exactly
 * as its own comment already documented -- unrelated to this fix.
 */

export const metadata = {
  title: "Analytics Dashboard",
  description: "Upload-driven intelligent analytics dashboard",
};

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

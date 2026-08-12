import type { ReactNode } from "react";

import "./globals.css";

export const metadata = {
  title: "Analytics Dashboard",
  description: "Upload-driven intelligent analytics dashboard",
};

export default function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <div className="dashboard-root">{children}</div>;
}

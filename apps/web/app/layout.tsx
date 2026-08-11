import type { ReactNode } from "react";

export const metadata = {
  title: "Analytics Dashboard",
  description: "Upload-driven intelligent analytics dashboard",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

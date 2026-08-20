"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[GLOBAL_ERROR]", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          background: "#fbfcfb",
          color: "#1b2820",
          display: "flex",
          minHeight: "100vh",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <div
          style={{
            maxWidth: 440,
            width: "100%",
            background: "#ffffff",
            border: "1px solid #e1e7e3",
            borderRadius: 16,
            padding: 32,
            textAlign: "center",
            boxShadow: "0 4px 12px rgba(0, 0, 0, 0.05)",
          }}
        >
          <div
            style={{
              display: "inline-flex",
              width: 48,
              height: 48,
              borderRadius: "50%",
              backgroundColor: "#fef2f2",
              color: "#dc2626",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 24,
              fontWeight: "bold",
              marginBottom: 16,
            }}
          >
            !
          </div>
          <h1 style={{ fontSize: 20, margin: "0 0 8px 0", color: "#0d3b26" }}>
            Application Error
          </h1>
          <p
            style={{
              fontSize: 13,
              lineHeight: 1.6,
              color: "#52675a",
              margin: "0 0 24px 0",
            }}
          >
            An unexpected error occurred. The application state has been preserved.
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                backgroundColor: "#0d3b26",
                color: "#ffffff",
                border: "none",
                borderRadius: 8,
                padding: "10px 18px",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Reload Page
            </button>
            <a
              href="/"
              style={{
                backgroundColor: "#ffffff",
                color: "#1b2820",
                border: "1px solid #c9d5cd",
                borderRadius: 8,
                padding: "10px 18px",
                fontSize: 13,
                fontWeight: 600,
                textDecoration: "none",
                display: "inline-block",
              }}
            >
              Go to Home
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}

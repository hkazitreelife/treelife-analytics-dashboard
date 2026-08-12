"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Section 20/24's admin auth, with an actual UI: posts to the existing
 * POST /api/users/login Payload already exposes, same credentials, same
 * session cookie (payload-token, HttpOnly). Lives under (site), not
 * (payload) -- this is this app's own login screen, not Payload's admin
 * UI, so a signed-out user never has to land on /admin to get in.
 */

type LoginPhase =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "error"; message: string };

type LoginResponseBody = {
  message?: string;
  errors?: { message: string }[];
};

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<LoginPhase>({ kind: "idle" });

  const handleSubmit = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (phase.kind === "pending") {
      return;
    }

    setPhase({ kind: "pending" });

    try {
      const response = await fetch("/api/users/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const body = (await response.json()) as LoginResponseBody;

      if (!response.ok) {
        // Shows Payload's real message verbatim (e.g. "The email or
        // password provided is incorrect."), not a generic string.
        setPhase({
          kind: "error",
          message:
            body.errors?.[0]?.message ??
            `Login failed (status ${response.status}).`,
        });
        return;
      }

      // The session cookie is already set by the response above; this just
      // moves to the page that actually uses it.
      router.push("/");
    } catch (error: unknown) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <main
      style={{
        padding: 24,
        maxWidth: 360,
        margin: "80px auto",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1>Log in</h1>
      <p style={{ color: "#666", fontSize: 14 }}>
        Analytics Dashboard admin access.
      </p>

      <form onSubmit={handleSubmit} style={{ marginTop: 16 }}>
        <label htmlFor="login-email" style={{ display: "block", fontSize: 14 }}>
          Email
        </label>
        <input
          id="login-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          autoComplete="email"
          disabled={phase.kind === "pending"}
          style={{
            display: "block",
            width: "100%",
            padding: 8,
            marginTop: 4,
            marginBottom: 12,
            borderRadius: 6,
            border: "1px solid #c9c9c9",
          }}
        />

        <label htmlFor="login-password" style={{ display: "block", fontSize: 14 }}>
          Password
        </label>
        <input
          id="login-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          autoComplete="current-password"
          disabled={phase.kind === "pending"}
          style={{
            display: "block",
            width: "100%",
            padding: 8,
            marginTop: 4,
            marginBottom: 16,
            borderRadius: 6,
            border: "1px solid #c9c9c9",
          }}
        />

        {phase.kind === "error" ? (
          <p role="alert" style={{ color: "#c0392b", fontSize: 14 }}>
            {phase.message}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={phase.kind === "pending"}
          style={{
            width: "100%",
            padding: "10px 16px",
            borderRadius: 6,
            border: "1px solid #0d3b26",
            background: "#0d3b26",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          {phase.kind === "pending" ? "Logging in…" : "Log in"}
        </button>
      </form>
    </main>
  );
}

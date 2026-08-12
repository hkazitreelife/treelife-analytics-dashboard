/**
 * Local dev helper: mints a Payload session from the app's own login endpoint
 * and serves a tiny page on 127.0.0.1 that sets the cookie and redirects to a
 * dashboard. Lets a browser reach an authenticated route without a password
 * being typed into a form, and without the token appearing anywhere else.
 *
 * Development only. Binds to loopback and exits when stopped.
 */
import { createServer } from "node:http";

const APP = process.env.PUBLIC_APP_URL ?? "http://localhost:3000";
const PORT = 3999;

const main = async (): Promise<void> => {
  const target = process.argv[2];

  if (!target) {
    throw new Error("Usage: dev-session-bridge.ts <path-to-open>");
  }

  const login = await fetch(`${APP}/api/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    }),
  });

  if (!login.ok) {
    throw new Error(`Login failed: ${login.status}`);
  }

  const setCookies = login.headers.getSetCookie();

  if (setCookies.length === 0) {
    throw new Error("Login returned no Set-Cookie header.");
  }

  console.log(`session minted (${setCookies.length} cookie(s))`);

  const server = createServer((request, response) => {
    // Re-issues the session cookie for localhost, then bounces to the target.
    response.setHeader(
      "Set-Cookie",
      setCookies.map((cookie) =>
        cookie.replace(/;\s*Domain=[^;]*/i, "").replace(/;\s*Secure/i, ""),
      ),
    );
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<!doctype html><meta http-equiv="refresh" content="0;url=${APP}${target}"><p>Signing in, redirecting to ${target}</p>`,
    );
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`bridge ready at http://127.0.0.1:${PORT}/ -> ${target}`);
  });
};

void main().catch((error: unknown) => {
  console.error("bridge failed:", error);
  process.exit(1);
});

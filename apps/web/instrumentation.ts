import { captureException } from "./lib/monitoring";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    console.info("[INSTRUMENTATION] Node.js server runtime initialized.");
  }
}

export const onRequestError = async (
  err: { digest: string } & Error,
  request: {
    path: string;
    method: string;
    headers: Record<string, string>;
  },
  context: {
    routerKind: "Pages Router" | "App Router";
    routePath: string;
    routeType: "render" | "route" | "action" | "middleware";
    revalidateReason?: "on-demand" | "stale" | undefined;
    renderSource?:
      | "react-server-components"
      | "server-rendering"
      | "server-action"
      | undefined;
  },
) => {
  captureException(err, {
    path: request.path,
    method: request.method,
    digest: err.digest,
    routerKind: context.routerKind,
    routePath: context.routePath,
    routeType: context.routeType,
  });
};

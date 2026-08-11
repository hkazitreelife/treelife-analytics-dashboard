import { withPayload } from "@payloadcms/next/withPayload";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @analytics/shared is published as TypeScript source inside the workspace.
  transpilePackages: ["@analytics/shared"],
  // bullmq is server-only and lazily requires optional Redis clients, which the
  // bundler cannot resolve. Loading it at runtime avoids that.
  serverExternalPackages: ["bullmq"],
};

export default withPayload(nextConfig);

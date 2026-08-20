import { withPayload } from "@payloadcms/next/withPayload";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @analytics/shared is published as TypeScript source inside the workspace.
  transpilePackages: ["@analytics/shared"],
  // bullmq is server-only and lazily requires optional Redis clients, which the
  // bundler cannot resolve. Loading it at runtime avoids that.
  serverExternalPackages: ["bullmq"],
  webpack: (config, { isServer, webpack }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        https: false,
        http: false,
        net: false,
        tls: false,
        crypto: false,
        path: false,
        os: false,
        stream: false,
        zlib: false,
      };
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
          resource.request = resource.request.replace(/^node:/, "");
        }),
      );
    }
    return config;
  },
};

export default withPayload(nextConfig);

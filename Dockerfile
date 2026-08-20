# ==========================================
# Production Dockerfile for Worker (BullMQ Background Ingestion)
# ==========================================
FROM node:20-alpine AS base

RUN npm install -g pnpm@11.22.0

WORKDIR /app

# Copy root workspace configurations
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/
COPY worker/package.json ./worker/

# Install all workspace dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/shared ./packages/shared
COPY apps/web/payload.config.ts ./apps/web/
COPY apps/web/collections ./apps/web/collections
COPY worker ./worker

ENV NODE_ENV=production

CMD ["pnpm", "--filter", "worker", "start"]

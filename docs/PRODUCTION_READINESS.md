# Production-Readiness Architecture & Operations Guide

This document outlines the production architecture, security controls, backup strategies, worker processes, and operational procedures for the Analytics Dashboard.

---

## 1. Secrets & Environment Variables

### Security Confirmation
- **Git Repository Audit**: All `.env`, `.env.local`, `.env.production`, and credential files are strictly excluded via `.gitignore`. No API keys, database credentials, or secret keys are hardcoded in the codebase.
- **Runtime Configuration**: The system reads all secrets and configurations exclusively from environment variables (`process.env`).

### Required & Optional Environment Variables

| Variable | Required | Default / Description |
| :--- | :--- | :--- |
| `NODE_ENV` | Yes | `production` in live environments, `development` locally. |
| `PORT` | No | Port for Next.js HTTP server (default: `3000`). |
| `PUBLIC_APP_URL` | Yes | Public canonical URL (e.g., `https://dashboard.example.com`). |
| `DATABASE_URI` | Yes | PostgreSQL connection string (`postgresql://user:pass@host:5432/dbname`). |
| `REDIS_URL` | Yes | Redis connection string (`redis://host:6379`). |
| `PAYLOAD_SECRET` | Yes | Cryptographically secure 64+ char random string for session tokens and encryption. |
| `ADMIN_EMAIL` | Yes | Primary admin user email. |
| `ADMIN_PASSWORD` | Yes | Admin password (enforced min 12 chars with upper, lower, digit, special chars). |
| `GEMINI_API_KEY` | Yes | Google Gemini API key for spreadsheet parsing & document extraction. |
| `GEMINI_MODEL` | No | Primary Gemini model (default: `gemini-3.6-flash`). |
| `GEMINI_RETRY_MODEL` | No | Fallback Gemini model (default: `gemini-3.1-pro-preview`). |
| `ANTHROPIC_API_KEY` | Yes | Anthropic Claude API key for dashboard synthesis, chat, and editing. |
| `ANTHROPIC_MODEL` | No | Primary Claude model for chat/edit (default: `claude-sonnet-5`). |
| `ANTHROPIC_RETRY_MODEL` | No | Retry Claude model for chat/edit (default: `claude-opus-5`). |
| `ANTHROPIC_CONFIG_MODEL` | No | Primary Claude model for initial dashboard config (default: `claude-opus-5`). |
| `ANTHROPIC_CONFIG_RETRY_MODEL` | No | Retry Claude model for dashboard config (default: `claude-opus-5`). |
| `UPLOAD_MAX_SIZE_MB` | No | Maximum file upload size in megabytes (default: `25`). |
| `MAX_ROWS_PER_TABLE` | No | Hard cap on rows ingested per table (default: `10000`). |
| `MAX_TOTAL_ROWS` | No | Hard cap on total dataset rows (default: `25000`). |
| `MAX_TABLES_PER_FILE` | No | Hard cap on tables extracted per file (default: `25`). |
| `S3_BUCKET` | Optional | AWS S3 or S3-compatible bucket name for uploaded media. |
| `S3_ACCESS_KEY_ID` | Optional | S3 Access Key ID. |
| `S3_SECRET_ACCESS_KEY` | Optional | S3 Secret Access Key. |
| `S3_REGION` | Optional | S3 region (default: `us-east-1`). |
| `S3_ENDPOINT` | Optional | Custom S3 endpoint (e.g. MinIO, Cloudflare R2). |
| `S3_FORCE_PATH_STYLE` | Optional | Set `true` for MinIO or local S3 emulators. |
| `MEDIA_DIR` | Optional | Local media storage directory override (for container mounts). |
| `SENTRY_DSN` | Optional | Sentry DSN for error and performance monitoring. |

---

## 2. Storage Architecture

### Local vs. S3-Compatible Storage
- **Local Disk Mode**: Uploaded files default to `apps/web/media` (or the directory specified by `MEDIA_DIR`).
- **Production S3 Mode**: When `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` are provided, Payload automatically mounts `@payloadcms/storage-s3` plugin to stream uploads directly to S3 or any S3-compatible service (AWS S3, Cloudflare R2, MinIO, Wasabi).
- **Container Volume**: If running on local disk inside containers, mount a persistent volume at `/app/apps/web/media` and configure `MEDIA_DIR=/app/apps/web/media`.

---

## 3. Database Management, Migrations & Backup Strategy

### Migrations
- In development (`NODE_ENV !== "production"`), schema pushes directly.
- In production, schema changes are managed via Payload's Postgres migration runner:
  ```bash
  # Generate new migration
  pnpm --filter @analytics/web migrate:create
  
  # Run pending migrations
  pnpm --filter @analytics/web migrate
  
  # Check migration status
  pnpm --filter @analytics/web migrate:status
  ```

### Backup Strategy
1. **Daily Automated Snapshots**:
   ```bash
   pg_dump -Fc --no-acl --no-owner -h <db_host> -U <db_user> -d analytics_dashboard > backup_$(date +%Y%m%d_%H%M%S).dump
   ```
2. **Point-In-Time Recovery (PITR)**: Enable Write-Ahead Log (WAL) archiving on PostgreSQL (e.g., AWS RDS Automated Backups or pgBackRest).
3. **Restoration Runbook**:
   ```bash
   pg_restore -h <db_host> -U <db_user> -d analytics_dashboard --clean --if-exists backup_YYYYMMDD_HHMMSS.dump
   ```

---

## 4. Ingestion Worker in Production

The ingestion worker handles asynchronous spreadsheet extraction, Gemini structured analysis, and Claude dashboard generation.

### Process Management & Concurrency
- **Single Owner Lock & Heartbeat**: The worker uses Redis heartbeat locking (`analytics:worker:heartbeat`) with automatic takeover and graceful stale instance retirement.
- **Systemd Service Example**:
  ```ini
  [Unit]
  Description=Analytics Ingestion Worker
  After=network.target redis.service

  [Service]
  Type=simple
  User=node
  WorkingDirectory=/app/worker
  ExecStart=/usr/bin/node src/index.js
  Restart=always
  RestartSec=5
  EnvironmentFile=/etc/analytics/worker.env

  [Install]
  WantedBy=multi-user.target
  ```
- **Docker / Container Deployment**:
  ```yaml
  worker:
    build:
      context: .
      dockerfile: Dockerfile.worker
    environment:
      - NODE_ENV=production
      - DATABASE_URI=postgresql://postgres:password@postgres:5432/analytics_dashboard
      - REDIS_URL=redis://redis:6379
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - GEMINI_API_KEY=${GEMINI_API_KEY}
    restart: unless-stopped
  ```

---

## 5. Authentication, Rate Limiting & Upload Controls

- **Admin Brute-Force Rate Limiting**: Payload is configured with `maxLoginAttempts: 5` and a `lockTime: 600000` (10-minute lockout) on the `users` collection.
- **Session Security**: JWT cookies use `SameSite: Lax` and enforce `Secure: true` in production over HTTPS.
- **Admin Password Policy**: Enforced minimum 12 characters, requiring uppercase, lowercase, numbers, and special symbols.
- **Server-Side Upload Limits**:
  - File size cap enforced via `UPLOAD_MAX_SIZE_MB` (default 25 MB).
  - Dual MIME-type and extension agreement validation on the server before storing raw bytes or allocating resources.
  - Allowed types: `.xlsx`, `.csv`, `.pdf`, `.pptx`, `.docx`, `.png`, `.jpg`, `.jpeg`.

---

## 6. LLM Cost Optimization, Token Caps & Caching

- **Response Caching (`apps/web/lib/llmCache.ts`)**: Identical model + prompt + context requests are cached with SHA-256 fingerprinting, eliminating redundant Anthropic API calls for repeated inquiries.
- **Token Caps**: All LLM calls specify explicit `max_tokens` limits (e.g. `4000`).
- **Token Logging**: Every invocation logs structured telemetry (`[TOKEN_USAGE] action=... model=... in=... out=... total=... cached=...`).

---

## 7. Error Handling & Monitoring

- **No Raw JSON in UI**: All failure paths (billing errors, validation failures, network timeouts) are rendered with human-readable error messages and optional technical detail accordions.
- **Next.js Error Boundaries**: `app/error.tsx` and `app/global-error.tsx` catch uncaught exceptions and render clean recovery UI.
- **Instrumentation & Monitoring (`apps/web/lib/monitoring.ts` & `instrumentation.ts`)**: Structured JSON error logging ready for Sentry, Datadog, or CloudWatch ingestion.

# Production Deployment Plan: Vercel & Cloud Services

This document outlines the architecture, environment configuration, and step-by-step deployment plan for deploying the **Treelife AI Executive Workspace** to **Vercel** with high availability, sub-second latency, and zero-hardcoding data pipelines.

---

## 1. 🏗️ High-Level Architecture

```mermaid
flowchart TD
    subgraph ClientLayer [Client & Executive Users]
        Browser["Desktop & Mobile Web Browser"]
    end

    subgraph VercelApp [Vercel (Serverless Next.js 15)]
        UI["Next.js App Router (Dashboard, Login, Admin)"]
        API["API Routes & Server Actions (/api/sessions, /api/datasets)"]
        PayloadAdmin["Payload CMS Admin Panel"]
        SSE["SSE Real-Time Progress Pipeline"]
    end

    subgraph ManagedData [Managed Cloud Infrastructure]
        Postgres["Neon / Supabase / AWS RDS\n(PostgreSQL 16)"]
        Redis["Upstash / Redis Cloud\n(BullMQ & Token Cache)"]
        S3Bucket["AWS S3 / Cloudflare R2\n(Uploaded Files & Spreadsheets)"]
    end

    subgraph BackgroundLayer [Worker Service (Railway / Render / Fly.io)]
        Worker["BullMQ Worker Process\n(worker/src/index.ts)"]
        GeminiAPI["Gemini 2.5 Flash / Pro API"]
        ClaudeAPI["Claude 3.5 Sonnet API"]
    end

    Browser -->|HTTPS| VercelApp
    VercelApp -->|SQL Queries| Postgres
    VercelApp -->|Enqueues Jobs| Redis
    VercelApp -->|Direct Uploads| S3Bucket

    Worker -->|Consumes Jobs| Redis
    Worker -->|Reads Files| S3Bucket
    Worker -->|Updates Status & Configs| Postgres
    Worker -->|Metadata Extraction| GeminiAPI
    Worker -->|Dashboard Layout & Copilot| ClaudeAPI
    VercelApp -->|Streams Progress| Browser
```

---

## 2. 📋 Service Requirements

| Component | Recommended Service | Free Tier / Cost | Notes |
| :--- | :--- | :--- | :--- |
| **Web Frontend & API** | **Vercel** | Free Hobby / $20 Pro | Hosts `apps/web` (Next.js 15 + Payload CMS). |
| **PostgreSQL Database** | **Neon** or **Supabase** | Free Tier Available | Serverless PostgreSQL with pooling connection string. |
| **Redis & Queue** | **Upstash Redis** or **Redis Cloud** | Free Tier Available | Supports BullMQ queue processing and fast caching. |
| **Media / S3 Storage** | **Cloudflare R2** or **AWS S3** | Free Tier / Pay per GB | S3-compatible object storage for spreadsheets & documents. |
| **Background Ingestion Worker** | **Railway** or **Render** | ~$5/month or Free Tier | Long-running Node.js process running `worker/src/index.ts`. |

---

## 3. 🔑 Environment Variables Matrix

### Required for **Vercel** (`apps/web`):
```ini
# --- Core Application ---
NODE_ENV=production
NEXT_PUBLIC_APP_URL=https://your-vercel-domain.vercel.app
PAYLOAD_SECRET=your-random-32-character-secret-key

# --- Database (PostgreSQL with Connection Pooling) ---
DATABASE_URI=postgresql://user:password@ep-cool-pooler.us-east-2.aws.neon.tech/analytics_dashboard?sslmode=require

# --- Redis (BullMQ & Cache) ---
REDIS_URL=rediss://default:your-password@your-upstash-redis.upstash.io:6379

# --- AI APIs ---
ANTHROPIC_API_KEY=sk-ant-api03-...
ANTHROPIC_MODEL=claude-sonnet-5
GEMINI_API_KEY=AIzaSy...

# --- S3 / Cloudflare R2 Storage (Payload S3 Plugin) ---
S3_BUCKET=treelife-analytics-media
S3_REGION=auto
S3_ACCESS_KEY_ID=your-access-key-id
S3_SECRET_ACCESS_KEY=your-secret-access-key
S3_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
S3_PREFIX=media
S3_FORCE_PATH_STYLE=false

# --- Admin Credentials ---
ADMIN_EMAIL=admin@treelife.com
ADMIN_INITIAL_PASSWORD=YourStrongAdminPassword123!
```

### Required for **Worker** (`worker/` on Railway / Render):
```ini
NODE_ENV=production
DATABASE_URI=postgresql://user:password@ep-cool-pooler.us-east-2.aws.neon.tech/analytics_dashboard?sslmode=require
REDIS_URL=rediss://default:your-password@your-upstash-redis.upstash.io:6379
ANTHROPIC_API_KEY=sk-ant-api03-...
GEMINI_API_KEY=AIzaSy...
S3_BUCKET=treelife-analytics-media
S3_REGION=auto
S3_ACCESS_KEY_ID=your-access-key-id
S3_SECRET_ACCESS_KEY=your-secret-access-key
S3_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
```

---

## 4. 🚀 Step-by-Step Deployment Guide

### Step 1: Provision Managed Database & Redis
1. **Neon PostgreSQL (or Supabase):**
   - Create a project `treelife-analytics`.
   - Copy the pooled connection string (`postgresql://...`).
2. **Upstash Redis:**
   - Create a Redis database with TLS enabled.
   - Copy the `rediss://...` connection URL.
3. **Cloudflare R2 or AWS S3:**
   - Create bucket `treelife-analytics-media`.
   - Generate S3 API tokens (Access Key ID & Secret Access Key).

---

### Step 2: Deploy Next.js to Vercel
1. Push your repository to **GitHub / GitLab**.
2. Go to [Vercel Dashboard](https://vercel.com/new) -> **Import Repository**.
3. Configure Project Settings:
   - **Framework Preset:** `Next.js`
   - **Root Directory:** `apps/web` (or select root with pnpm workspace)
   - **Build Command:** `pnpm --filter @analytics/web build`
   - **Install Command:** `pnpm install`
4. Add all environment variables from Section 3.
5. Click **Deploy**.

---

### Step 3: Seed Admin User & Run Migrations
After your first Vercel deployment completes:
Run the seed script against your production database using your local terminal:
```bash
# Run from repository root
DATABASE_URI="your-production-neon-postgres-url" \
ADMIN_EMAIL="admin@treelife.com" \
ADMIN_INITIAL_PASSWORD="YourStrongAdminPassword123!" \
pnpm --filter @analytics/web seed:admin
```

---

### Step 4: Deploy the Background Worker (Railway / Render)
Because Vercel serverless functions cannot run infinite daemon processes, deploy the worker on **Railway** or **Render**:
1. Connect the same GitHub repository to **Railway** (or **Render**).
2. Set Root / Working Directory: `worker/` (or repository root with monorepo build).
3. Set Start Command:
   ```bash
   pnpm --filter worker start
   ```
4. Configure the environment variables (Database URI, Redis URL, Anthropic API Key, Gemini API Key, S3 credentials).
5. Deploy the worker.

---

## 5. ✅ Post-Deployment Verification Checklist

- [ ] **Login Portal:** Navigate to `https://your-domain.vercel.app/login` and sign in with admin credentials.
- [ ] **Spreadsheet Upload:** Upload a test Excel or CSV file on `/new`.
- [ ] **Worker Pipeline:** Confirm worker picks up the job from Upstash Redis, extracts metadata via Gemini, and generates the layout via Claude.
- [ ] **Real-time SSE:** Verify upload progress moves from `Uploading` -> `Processing` -> `Ready`.
- [ ] **Interactive Copilot:** Ask a question in the right rail chat and test prompt edits.
- [ ] **Tab Navigation:** Verify fast client-side tab switching and chart rendering.

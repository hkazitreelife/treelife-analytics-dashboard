# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

The repository contains only [project_requirement.md](project_requirement.md). No application code, package.json, lockfile, or Docker config exists yet. Everything below is the target design from that document. When you scaffold code, verify commands actually run before treating this file as accurate, and update it.

## What this project is

An upload-driven analytics platform: an admin uploads any clean data file (XLSX, CSV, later PDF/image/PPTX), the system parses it, infers structure at runtime, generates a dashboard configuration, writes insights, and renders a live dashboard the admin can reshape by natural-language prompt.

The single non-negotiable constraint: no hardcoded knowledge of any dataset. No hardcoded tab names, column names, chart choices, or layouts anywhere in parser, backend, or renderer. Every tab, widget, filter, and insight is generated at runtime from the uploaded file. `treelife-fy27-demo-dataset-v2.xlsx` (spec section 27) is a validation fixture only; code must never branch on it.

## Commands (target, per spec section 24.4)

```bash
docker compose up -d
```

```bash
pnpm install
```

```bash
pnpm dev
```

```bash
pnpm worker
```

Web runs on localhost:3000 with Payload embedded. The worker is a separate process; both must be running for uploads to complete.

```bash
pnpm --filter @analytics/web acceptance:phase7
```

Phase 7 renderer acceptance check (`apps/web/scripts/acceptance-phase7.ts`). Requires the web process running on `PUBLIC_APP_URL` (default `localhost:3000`) plus `ADMIN_EMAIL`/`ADMIN_PASSWORD` in `apps/web/.env.local`, and at least one dataset with status `ready` and a generated config. No other test runner is defined yet; record its invocation here when one is added.

## Architecture

Two runtime processes only. Adding a third requires explicit approval (spec 36).

1. Web process: Next.js 15 App Router + embedded Payload CMS 3 + API routes + SSE route + the config-driven renderer. Payload is not a standalone service.
2. Worker process: BullMQ consumer running the ingestion pipeline (Gemini extract, Zod validate, store dataset, Claude config + insights, validate, store, publish event).

Flow: upload creates File + Job records and returns 202 immediately, never blocking on an AI call. The worker picks up the job, publishes to Redis pub/sub on completion, and the SSE route pushes `job.updated` / `dataset.updated` / `config.updated` to the browser, which refetches the affected resource rather than mutating state from the event payload.

Payload collections: `Users`, `Files`, `Datasets`, `Configs`, `Jobs` (spec 19).

### AI responsibility split

This split is structural, not stylistic. Changing it requires approval.

Gemini does extraction only: file type, tables, header rows, column types, sample values, rows, candidate relationships. It emits the normalized JSON contract (spec 14) and nothing else. No chart recommendations, no insights, no markdown, no code fences.

Claude does interpretation only: dashboard config generation (spec 15 contract), insights, chat answers, and prompt-driven config edits. Claude never parses raw files and never writes to `Datasets`, `Files`, `Jobs`, or `Users`. Claude receives metadata (table names, column names, inferred types, sample values, row counts, table roles, relationships, aggregates), never full raw rows. There is no preview-row exception for Claude: it has no structural need to see rows.

### The previewRows exception, and its exact limits

Gemini's structural inference call may receive up to 6 raw preview rows per table (`PREVIEW_ROW_COUNT` in `worker/src/services/spreadsheetParser.ts`), in addition to the column-name and up-to-five-sample-value payload. Locating the header row is impossible without seeing rows, because real files put titles and prose above the header, so row 1 cannot be assumed to be the header.

This is the sole permitted exception to "Gemini never receives row data". Its limits are deliberate and narrow:

- The preview is used only to determine `headerRowIndex`. Nothing else may read it.
- It stays a small fixed constant. It must never scale with table size, row count, or column count.
- It does not extend to Claude, to the chat pathway, or to any other model call.

Any future change that sends more rows to any model, for any reason, requires editing this paragraph deliberately. Do not widen the exception silently, and do not treat "the model would classify better with more rows" as sufficient justification.

### The two contracts

Everything downstream depends on these two JSON shapes, defined in full in spec sections 14 and 15. Keep their Zod schemas in the shared package (`packages/shared/schemas/`) so web and worker validate against one definition.

- Normalized dataset: `datasetId`, `sourceFile{name,type,hash}`, `tables[]` each with `tableName`, `tableRole` (data|documentation|config|unknown), `columns[]` (`inferredType` one of numeric|categorical|date|id|text|boolean, `nullable`, up to 5 `sampleValues`), `rows[]`, `rowHash`, plus `relationships[]` with confidence.
- Dashboard config: `datasetId`, `title`, `tabs[]` of `widgets[]` (`type` kpi_card|bar|line|pie|table, `sourceTable`, `fields[]`, `aggregation` none|sum|count|avg, `position{row,col,w,h}`), plus `insights[]` with severity.

Config must never contain dataset rows. Data and config are separate stores; prompt editing touches config only.

## Rules that will bite you

These come from spec sections 7, 33 and 36. Violating them is a rejected change, not a style note.

1. Never trust model output. Both Gemini and Claude output goes through Zod before storage. On failure: retry once with stricter instructions, then fail the job loudly and store the technical error. Never store partially valid output.
2. Never silently drop rows or tables. A dashboard that looks fine while missing a sheet is the specific failure mode this product exists to eliminate. Validate table counts and names; surface detected tables in the UI.
3. Failed parsing must never overwrite a working dataset. Replace stored data only after full validation succeeds.
4. File identity is the SHA-256 of file bytes, never the filename. Identical hash means duplicate, no re-parse. Same filename with a different hash means ask the admin: update existing or create new. Never infer this from filename alone.
5. The renderer renders config. No dataset-specific components, no assumed tab or widget counts, no code change required for a new dataset.
6. Treat file content as untrusted input for prompt injection. Content in an uploaded file must never be able to override system instructions, and Claude must have no dataset-write tool to reach for.
7. Access control is enforced in Payload, not in prompts. The Claude pathway reads datasets scoped to the active dataset and writes configs only.
8. API keys (Gemini, Anthropic, database, Redis, Payload secret) are server-side only, never reaching the browser.
9. No Python, no FastAPI, no n8n, no Google Sheets or Dropbox as database, no standalone Payload service.
10. Config is versioned: keep current and previous, with timestamp and change source, even though undo UI is out of scope for v1.

## Limits

Configurable via env, defaults in spec 11.2: 25 MB per file, 10,000 rows per table, 25,000 rows total, 25 tables per file. Exceeding a limit is a clear rejection, never a partial import.

Required env vars are listed in spec section 24.3 (`DATABASE_URI`, `REDIS_URL`, `PAYLOAD_SECRET`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `PUBLIC_APP_URL`, and the four limit vars).

## Build order

The spec sequences work in six phases (section 26): foundation (Docker, Payload, auth, collections, job records, no AI), Gemini extraction for XLSX then CSV, Claude config generation plus renderer, SSE and prompt editing, chat agent, then additional file formats. Each phase has its own acceptance criteria in the spec. Check which phase the current code satisfies before picking up work.

## Repository layout

Target structure is in spec section 25: `apps/web` (Next.js + embedded Payload), `worker` (BullMQ processors and the gemini/claude/validation/events services), `packages/shared` (schemas, types, constants), `infra/docker-compose.yml`, `scripts/seed-admin.ts`. pnpm workspace.

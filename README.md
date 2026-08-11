# Upload-Driven Intelligent Analytics Dashboard

Local-first analytics platform that converts uploaded files into live, prompt-editable dashboards.

## Core Rules

1. Upload-based, zero hardcoding.
2. Gemini extracts structure only.
3. Claude interprets, generates config, generates insights, and edits config only.
4. Claude must never write dataset rows.
5. Files are the source of truth.
6. Failed parsing must never overwrite a working dataset.
7. No Python, no FastAPI, no Google Sheets database, no Dropbox database.

## Stack

- Next.js 15
- Payload CMS 3
- PostgreSQL
- Redis
- BullMQ
- Gemini API
- Claude API, later MCP

## Bootstrap Commands

```bash
pnpm install
pnpm docker:up
```

## Expected Bootstrap State

- PostgreSQL available on localhost:5432
- Redis available on localhost:6379
- Shared TypeScript contracts present
- No web app implemented yet
- No worker implemented yet

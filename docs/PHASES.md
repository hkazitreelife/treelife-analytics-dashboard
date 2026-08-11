# Build Phases

Authoritative source: project_requirement.md, Section 26.
If this file conflicts with project_requirement.md, project_requirement.md wins.

## Bootstrap — Not a numbered phase

Purpose:
Prepare the repository skeleton before Phase 1 implementation.

Scope:
- Repository skeleton
- pnpm workspace
- Docker Compose file for PostgreSQL and Redis
- Shared TypeScript contracts
- Environment variable template
- No Next.js
- No Payload
- No Gemini
- No Claude
- No dashboard renderer

## Phase 1: Foundation

Scope:
- Docker Compose for PostgreSQL and Redis
- Next.js 15 app
- Payload CMS 3 embedded inside Next.js
- Payload collections: Users, Files, Datasets, Configs, Jobs
- BullMQ worker skeleton
- Upload API route that stores a file, creates a Job, enqueues the job, and returns 202
- Simple admin authentication using Payload built-in auth

Not allowed in Phase 1:
- No Gemini integration
- No Claude integration
- No dashboard renderer

## Phase 2: Gemini Extraction

Scope:
- Worker consumes queue
- Worker calls Gemini
- Gemini output is validated against the normalized dataset schema
- Dataset is stored only after validation succeeds
- XLSX is the first supported file type
- CSV is the second supported file type

Not required in Phase 2:
- PDF
- Image OCR
- PPTX

## Phase 3: Claude Config Generation and Renderer

Scope:
- Claude generates dashboard config from normalized dataset metadata
- Claude generates insights
- Config is validated before storage
- Renderer draws tabs, widgets, and insights from config
- A real dashboard appears with zero manual configuration

## Phase 4: Real-Time Updates and Prompt Editing

Scope:
- SSE wiring
- dataset.updated events
- config.updated events
- update existing dataset flow
- duplicate detection
- prompt-to-edit dashboard config
- rowHash is stored, but row-level diffing is deferred

## Phase 5: Chat Agent

Scope:
- Chat UI for the active dataset
- Read-only access to dataset data
- Dataset-scoped access control
- No path to data mutation

## Phase 6: Additional File Formats

Scope:
- PDF parsing
- Image OCR
- PPTX extraction

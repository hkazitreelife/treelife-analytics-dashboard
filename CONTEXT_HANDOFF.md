# Context handoff: Upload-Driven Intelligent Analytics Dashboard

Purpose of this file: full project history and current state, for a Claude Code session in VS Code picking up where a Claude.ai chat session left off. Read this alongside `project_requirement.md` (the locked PRD) and `CLAUDE.md` (in-repo build rules, including amendments made during the build). This file is the narrative and decision log, the PRD is the spec, CLAUDE.md is the enforceable ruleset.

---

## 1. What this project is

Generic, upload-driven analytics platform. Admin uploads any clean file (XLSX, CSV, later PDF/image/PPTX), the system parses it, stores a normalized dataset, generates a dashboard configuration and written insights, renders a config-driven dashboard, and lets the admin reshape it by prompting without touching the underlying data. Zero hardcoded knowledge of any specific dataset anywhere in the code.

Full spec: `project_requirement.md`, version 1.0, approved for build. That document is authoritative. Any conflict between this file and the PRD, the PRD wins.

---

## 2. Locked stack

- Next.js 15 App Router, TypeScript, Tailwind, shadcn/ui-idiom components, Recharts
- Payload CMS 3 embedded inside the Next.js process, not a separate service
- PostgreSQL via Docker, accessed through Payload
- Redis + BullMQ, separate worker process
- Gemini API — extraction/structure only (never reasons about chart choice, never emits insights)
- Claude API — interpretation only (dashboard config, insights, later chat and prompt-edit)
- pnpm monorepo: `apps/web`, `worker`, `packages/shared`
- No Python, no FastAPI, no MCP for this phase, no Google Drive/service account ingestion — all explicitly out of scope for v1 per PRD Section 5 and Section 31

Two runtime processes only: web (Next.js + Payload) and worker (BullMQ consumer).

---

## 3. Phase progress against PRD Section 26

| Phase | Content | Status |
|---|---|---|
| 1 | Docker, Payload collections (Users/Files/Datasets/Configs/Jobs), auth, upload route, job lifecycle skeleton | Done |
| 2 | Deterministic XLSX/CSV parsing (SheetJS), Gemini metadata-only inference, Section 14 normalized contract, merge step, real ingestion processor | Done |
| 3 | Claude dashboard config + insight generation, config-driven renderer | Done |
| 4 | SSE real-time updates, prompt-based config editing | Not started |
| 5 | Chat agent (read-only, dataset-scoped) | Not started |
| 6 | PDF/image/PPTX parsing | Not started |

Prompt numbering in the actual build session does not map 1:1 to PRD phases — Prompts 1 to 4 covered Phase 1, Prompt 5 (plus 5.1 to 5.5 sub-prompts) covered Phase 2, Prompt 6 covered the backend half of Phase 3, Prompt 7 covered the frontend half of Phase 3.

---

## 4. Key architectural decisions made during the build (not all in the original PRD text)

These were corrections or clarifications made mid-build. CLAUDE.md should already reflect the ones marked "in CLAUDE.md" — verify on resume.

- **Two-model split enforced literally.** Gemini never receives or returns raw row data, with one narrow, deliberate exception below. Claude never receives raw rows either, only dataset metadata (table/column names, inferred types, sample values, row counts, relationships).
- **previewRows exception (in CLAUDE.md).** Gemini's structural inference call may receive up to 6 raw preview rows per table, solely for header-row detection, in addition to column names and up to 5 sample values per column. This is the one permitted exception to "no row data." Must stay a fixed small constant, never scale with table size, never used for anything else.
- **Header row is inferred, not assumed.** The parser does not assume row 1 is the header. Gemini returns a `headerRowIndex` per table (added to the Section 14 contract), the merge step slices deterministic rows using that index, and fails validation rather than defaulting to row 0 if the index is missing or out of bounds. This fixed a real bug: the Treelife fixture has title rows before real headers on at least one sheet.
- **Deterministic parsing, not LLM transcription.** Row/column values are extracted with SheetJS in the worker, never re-typed by an LLM. This is the actual guarantee against silent data loss (Section 3's core problem). Gemini's job is metadata inference only: types, table roles, relationships, header location.
- **Duplicate detection requires a completed Job.** A File row with a matching hash only counts as a true duplicate if it's linked to a Job that reached `completed` with a Dataset attached. An orphaned File (e.g. from an abandoned collision-choice flow) does not count, preventing a broken "duplicate" pointer to a nonexistent dataset.
- **Tiered Gemini model strategy.** Default extraction model: `gemini-3.6-flash`. Retry-on-validation-failure model: `gemini-3.1-pro-preview` (paid-only, confirmed via live pricing check). Retry is conditional on error type: only `GeminiValidationError`/`MergeError` (output-quality problems) trigger the retry-with-stronger-model path. Request/billing/network failures fail fast with a path-accurate stored error message, no retry, no silent conflation between "bad output" and "can't reach the model."
- **Claude config generation follows the same conditional-retry pattern** (`ClaudeValidationError` retries once, request/billing failures fail fast).
- **Validation happens twice for Claude output**, once inside the client, once again at the write site immediately before the Configs write — deliberate duplication, because a stubbed/swapped client bypassing the first check must never be able to write invalid data.
- **Job only reaches `completed` after a Configs row exists**, not merely after the Dataset reaches `ready`. Verified live: Dataset can be `ready` with zero Configs rows while Job sits at `generating_config`.
- **No dataset-level lock yet.** Flagged five separate times across the build. Required by PRD Section 11.4 before Phase 4 (SSE plus concurrent prompt-edits raise real concurrency risk). This is the single most-repeated open item — do not let Phase 4 start without addressing it.

---

## 5. Known issues carried forward, unresolved

Ordered roughly by how soon they'll bite:

1. **No per-dataset lock (Section 11.4).** Must be addressed before or as part of Phase 4. Two jobs targeting the same dataset concurrently is currently possible if worker concurrency is ever raised above 1.
2. **Config-quality problem, needs a decision before Phase 4 widget/config logic gets extended.** Claude's generated config faithfully renders what it's told to render, but two of its own choices are semantically meaningless even though arithmetically correct: summing a heterogeneous key-value `Constants` table's `value` column (target + tail count + client count + billing fractions, all added together = 128.87, meaningless), and summing `annual_revenue_Cr` across Bands rows that include non-data footer rows. Claude's own insights correctly flag the underlying data problems, but the widgets still show the bad numbers. The Section 15 config contract has no concept of "this table shouldn't be summed" or row-level filtering. Needs either a config-time rule (e.g. `tableRole: config` tables get restricted aggregation options) or a filter concept added to the contract. Not fixed yet, deliberately deferred, but should not keep being deferred indefinitely.
3. **Config version hardcoded to 1, no uniqueness constraint.** Re-ingesting the same dataset creates a second version-1 row; the config-fetch endpoint sorts by `-version` and picks arbitrarily between duplicates. Section 13.4 versioning (current + previous + change source) is Phase 4 scope, but re-ingestion needs a version bump too and isn't currently getting one.
4. **Dataset marked `failed` when only config generation fails, not the parse.** If Gemini and merge succeed but Claude's config step fails, the Dataset (which holds perfectly good validated data) is marked `failed` anyway. Arguably correct since a dataset with no dashboard isn't usable, but conflates two different failure types. Needs a deliberate decision once Phase 4 surfaces status via SSE to the UI.
5. **Gemini's billing/tier-rejection classifier is string-matching on Google's current error wording**, with no structural error code to key on. Documented with a ten-case test suite as the tripwire; will silently stop working if Google changes their wording. Watch, don't rebuild preemptively.
6. **429 (rate limit) on Claude treated as billing failure, fails fast, no backoff.** Defensible for now given BullMQ's own job-level retry exists at the queue layer, but a proper backoff would serve better under real load.
7. **Drizzle `push: true` can hang the worker on an interactive prompt** if a collection field type change is structurally ambiguous (happened once, changing `generatedBy` from relationship to select). No error surfaces, it just hangs. Worth a CLAUDE.md note to check for ambiguity before running push non-interactively; migrations instead of push would remove the whole class of problem, not done yet.
8. **shadcn/ui was not installed via its CLI.** The CLI is interactive and rewrites tsconfig/next.config/global CSS, risking the working Payload build. Primitives were hand-written in the shadcn idiom on Radix instead. PRD Section 8.1 permits "shadcn/ui or equivalent," so this is compliant, but if the real CLI wiring is wanted later, it needs to be done as an isolated change, not assumed already in place.
9. **`dev-session-bridge.ts` exists as a dev-only helper** that mints an authenticated session via the app's own login API and a loopback redirect, used only for headless/browser verification without typing a password into a form. Binds to 127.0.0.1 only. Delete it if this pattern shouldn't persist in the repo, otherwise it's harmless dev tooling.
10. **An Anthropic API key was leaked into a build-session transcript** by a diagnostic probe that printed it in full (the probe script has since been deleted, the key was never committed to any file). As of the last message in this history, rotation had not yet been confirmed done. If it still hasn't happened, rotate it at console.anthropic.com before continuing any work that uses that key, and update `apps/web/.env.local`.
11. **ADMIN_EMAIL environment drift happened twice** during the build (manual .env edits reverting or corrupting the admin email, breaking login with a 401 that isn't obviously about env drift). A boot-time warning now exists in `payload.config.ts`'s `onInit` that logs a mismatch rather than silently failing — it's a warning only, doesn't auto-correct. Verified firing correctly and staying silent when there's no mismatch.

---

## 6. Files of note (as of end of Phase 3 / Prompt 7)

```
apps/web/
  app/(dashboard)/datasets/[id]/page.tsx      dashboard route
  app/api/uploads/route.ts                    upload, hash/collision logic
  app/api/uploads/confirm/route.ts            update-vs-new confirmation
  app/api/jobs/[id]/route.ts
  app/api/datasets/route.ts
  app/api/datasets/[id]/route.ts
  app/api/datasets/[id]/config/route.ts       Section 20.7
  app/api/datasets/[id]/data/route.ts         Section 20.6
  collections/{Files,Datasets,Configs,Jobs}.ts
  components/dashboard/{DashboardRenderer,WidgetRenderer,InsightsPanel}.tsx
  components/ui/primitives.tsx                hand-written shadcn-idiom components
  lib/{payload,auth,uploads,queue,aggregate,utils}.ts
  payload.config.ts                            includes boot-time ADMIN_EMAIL check
  payload-types.ts                              generated, committed
  scripts/acceptance-phase2*.ts, acceptance-phase3*.ts, acceptance-phase7.ts, dev-session-bridge.ts

worker/
  src/index.ts                                  Gemini + Claude client wiring
  src/processors/ingestion.ts                   full pipeline, conditional retry logic
  src/services/{spreadsheetParser,gemini,mergeDataset,claudeConfig}.ts

packages/shared/
  src/schemas/{normalizedDataset,dashboardConfig}.ts   Zod contracts, Section 14 and 15
  src/{constants,queue}.ts

CLAUDE.md          in-repo rules, amended with the previewRows exception
project_requirement.md   the locked PRD, do not re-derive from memory, read the file
```

Last confirmed commit at end of this history: `ed4e1c8` (Prompt 7 partial/truncated — acceptance checks 1 through 3 done, checks 4 and 5 from the original Prompt 7 acceptance list were never run because the prompt got cut off mid-paste; see open item below).

---

## 7. Immediate next steps, in order

1. **Confirm the Anthropic key rotation status** (item 10 above) before doing anything else that calls the Claude API.
2. **Finish Prompt 7's acceptance checks 4 and 5** if not already done — point the dashboard route at a nonexistent dataset id and confirm the error state renders instead of crashing; re-confirm the zero-hardcoding grep check.
3. **Decide on the per-dataset lock approach (item 1)** before starting Phase 4. This has been flagged five times and should not be deferred again.
4. **Decide on the config-quality / aggregation problem (item 2)** — at minimum, agree on whether `tableRole: config` tables get excluded from sum/avg aggregation by default in Claude's config generation, or whether a filter concept gets added to the Section 15 contract. This affects both current widget correctness and how Phase 4's prompt-editing endpoint should validate edits.
5. **Then proceed to Phase 4**: SSE event stream (Section 18), prompt-based dashboard editing (Section 13), config versioning done properly (Section 13.4) — including fixing the version-1-hardcoded issue (item 3) as part of building this, not separately.

---

## 8. How to keep working in this style

Every prompt given to Claude Code in this build has followed a consistent pattern: scoped tightly to one phase or sub-task, explicit about what's out of scope, requiring a structured STATUS/FILES_CREATED/FILES_MODIFIED/VALIDATION/ISSUES/ACCEPTANCE_RESULTS report back, and requiring real acceptance testing against the `treelife-fy27-demo-dataset-v2.xlsx` fixture rather than self-reported success. Continue that pattern. Do not let scope creep into a prompt that's supposed to be about one thing. Do not accept a "done" report without a paste of what actually happened.

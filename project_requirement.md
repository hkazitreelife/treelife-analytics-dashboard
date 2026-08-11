# Project Requirement Document
## Upload-Driven Intelligent Analytics Dashboard

Version: 1.0  
Status: Approved for build  
Target audience: Engineering, product, AI agents, reviewers  
Primary objective: Build a generic, upload-driven analytics platform that converts any clean data file into a live, insightful, prompt-editable dashboard.

---

## 1. Executive Summary

We are building a local-first web application that allows an admin to upload any clean data file, including XLSX, CSV, PDF, image, and PPTX. The system must automatically parse the file, understand its structure, store the parsed data, generate a dashboard configuration, produce written insights, render a live dashboard, and allow the admin to reshape the dashboard through natural-language prompts without modifying the underlying data.

The product is not a fixed report. It is a generic analytics platform. The code must not contain hardcoded knowledge of any specific dataset. Every dashboard, chart, tab, filter, insight, and layout must be generated at runtime from the uploaded file.

The system uses two AI models with strictly separated responsibilities:

- Gemini performs extraction and structural understanding only.
- Claude performs interpretation, insight generation, chat, and dashboard configuration editing.

The backend is Payload CMS embedded inside a Next.js application. The database is PostgreSQL. A background worker processes ingestion jobs asynchronously using Redis and BullMQ.

Python and FastAPI are explicitly out of scope for this version.

---

## 2. Product Vision

### 2.1 One-line definition

A generic, upload-driven analytics platform where any clean file becomes a live, insightful, prompt-editable dashboard.

### 2.2 Core experience

The admin should be able to:

1. Upload a file.
2. See the system process the file asynchronously.
3. Receive a dashboard automatically.
4. See charts, tables, KPI cards, and written insights.
5. Chat with the data.
6. Ask the system to change the dashboard layout or chart types by prompting.
7. Re-upload or update the file and see the dashboard update automatically.

### 2.3 What makes this different

The system must not require a developer to define fields, charts, tabs, or relationships manually. The system must infer the structure from the uploaded file and generate the dashboard dynamically.

---

## 3. Problem Statement

Generic parsers and dashboard tools often fail on real-world files because they assume a fixed schema.

Observed failure examples:

- A multi-sheet Excel workbook may be parsed as only the first sheet.
- Documentation sheets may be mistaken for data.
- Data rows may be silently dropped.
- A dashboard may appear successful while actually missing important tabs or tables.
- A fixed dashboard template may break when column names or file structures change.

This project must eliminate those failure modes by using:

1. Runtime schema discovery.
2. Strict validation of AI-generated output.
3. A normalized data contract.
4. A config-driven renderer.
5. Loud failure instead of silent data loss.

---

## 4. Goals

### 4.1 Primary goals

1. Accept multiple file formats: XLSX, CSV, PDF, image, PPTX.
2. Parse uploaded files into one normalized JSON structure.
3. Store parsed data in PostgreSQL through Payload CMS.
4. Automatically generate a dashboard configuration.
5. Render the dashboard dynamically from configuration.
6. Generate written insights from the parsed data.
7. Provide a chat agent that can answer questions using the parsed data.
8. Allow prompt-based dashboard editing without changing data.
9. Update dashboards when files are re-uploaded or modified.
10. Maintain strict separation between data and dashboard configuration.

### 4.2 Business goals

1. Reduce time from raw file to visual insight.
2. Avoid manual dashboard configuration.
3. Support non-technical admin users.
4. Allow future expansion to HR, finance, operations, and other teams.
5. Create a reusable analytics engine rather than a one-off report.

---

## 5. Non-Goals

The following are explicitly out of scope for this version:

1. No Python backend.
2. No FastAPI service.
3. No export of dashboards to PPTX.
4. No export of dashboards to PDF.
5. No multi-user simultaneous editing.
6. No public sharing links.
7. No mobile-native application.
8. No Google Sheets as primary database.
9. No Dropbox as database.
10. No hardcoded dataset-specific logic.
11. No map visualization in the initial version.
12. No external multi-tenant SaaS billing system.

---

## 6. Users and Roles

### 6.1 Admin user

The admin is the primary user for this version.

The admin can:

1. Log in.
2. Upload files.
3. View datasets.
4. View dashboards.
5. Chat with the data.
6. Prompt the system to change dashboard layout or chart types.
7. Re-upload updated files.
8. Choose whether a conflicting upload should update an existing dataset or create a new dataset.
9. View job status and errors.

### 6.2 Future roles

Future roles may include:

1. Viewer.
2. Editor.
3. Team admin.
4. Finance user.
5. HR user.
6. Operations user.

These roles are not required for the initial version, but the data model should not prevent them later.

---

## 7. Core Product Principles

These principles override all implementation convenience.

### 7.1 Upload-based, zero hardcoding

The application must not contain hardcoded assumptions about any specific dataset.

Forbidden examples:

- Hardcoding a tab named "Pipeline".
- Hardcoding a column named "wallet_value".
- Hardcoding a chart for "Bands".
- Assuming every file has a README sheet.
- Assuming every file has financial columns.

Allowed behavior:

- Detect tables dynamically.
- Detect columns dynamically.
- Infer types dynamically.
- Generate tabs dynamically.
- Generate charts dynamically.
- Generate insights dynamically.

### 7.2 One normalized shape

Every uploaded file, regardless of format, must be converted into one normalized JSON structure.

The renderer and Claude must not need to know whether the original file was XLSX, CSV, PDF, image, or PPTX.

### 7.3 Frontend is a renderer

The frontend must render whatever the dashboard configuration describes.

The frontend must not contain dataset-specific layouts.

### 7.4 Configuration is the CMS layer

The dashboard layout, tabs, widgets, chart types, positions, and insights are stored as configuration.

Prompt-based editing modifies configuration only.

Prompt-based editing must never modify raw parsed data.

### 7.5 File is the source of truth

When a file is updated and the admin chooses to update the existing dataset, the system must fully re-parse the file and replace the current parsed dataset after successful validation.

Failed parsing must not overwrite the previous working dataset.

### 7.6 No silent failure

If parsing fails, validation fails, or data is incomplete, the system must show a clear error.

The system must never present an empty or partial dashboard as if it were complete without warning.

---

## 8. Locked Technology Stack

### 8.1 Frontend

- Next.js 15, App Router.
- TypeScript.
- Tailwind CSS.
- shadcn/ui or equivalent accessible component system.
- Recharts or equivalent React charting library.
- Custom config-driven dashboard renderer.

The frontend must be built from scratch as a renderer. A fixed Vercel dashboard template must not be used if it imposes hardcoded data assumptions.

### 8.2 Backend / CMS

- Payload CMS 3.
- Payload must be embedded inside the Next.js application.
- Payload provides:
  - Admin authentication.
  - Collections.
  - REST API.
  - Access control.
  - Media/file storage.
  - Config storage.
  - Dataset storage.
  - Job storage.

### 8.3 Database

- PostgreSQL.
- Accessed through Payload.
- Local Dockerized PostgreSQL for development.

Google Sheets must not be used as the primary database.

### 8.4 Queue and background processing

- Redis.
- BullMQ.
- A separate worker process consumes ingestion jobs.

### 8.5 AI models

#### Gemini

Gemini is responsible for extraction only.

Gemini must:

1. Detect file type.
2. Detect sheets, pages, slides, or tables.
3. Detect header rows.
4. Infer column types.
5. Detect likely relationships.
6. Emit normalized JSON.

Gemini must not:

1. Decide final chart types.
2. Generate dashboard configuration.
3. Generate user-facing insights.
4. Modify stored data.
5. Chat with the user.

#### Claude

Claude is responsible for interpretation.

Claude must:

1. Generate dashboard configuration from normalized data metadata.
2. Generate written insights.
3. Answer chat questions using read-only data access.
4. Edit dashboard configuration based on admin prompts.

Claude must not:

1. Parse raw files.
2. Write to dataset collections.
3. Modify uploaded files.
4. Change raw extracted values.
5. Access data outside the active dataset scope.

### 8.6 Real-time mechanism

- Server-Sent Events, SSE.
- SSE is used for dataset-updated and config-updated events.
- WebSockets are not required for the initial version.

### 8.7 Package manager and runtime

- Node.js 20 or newer.
- pnpm.
- TypeScript.
- Docker for PostgreSQL and Redis.

### 8.8 Explicitly excluded technologies

The following are excluded for this version:

1. Python.
2. FastAPI.
3. n8n.
4. WordPress.
5. Google Sheets as database.
6. Dropbox as database.
7. Separate standalone Payload service outside Next.js.

---

## 9. High-Level Architecture

```text
Admin Browser
    |
    | Upload file / prompt edit / chat
    v
Next.js Frontend
    |
    | API calls
    v
Next.js API Routes + Payload CMS
    |
    | Creates File, Dataset, Job records
    v
Redis + BullMQ Queue
    |
    v
Worker Process
    |
    | Calls Gemini for extraction
    | Validates normalized JSON
    | Stores dataset
    | Calls Claude for config and insights
    | Stores config
    | Publishes completion event
    v
Redis Pub/Sub
    |
    v
SSE Route
    |
    v
Frontend updates dashboard
```

---

## 10. Runtime Processes

There are two primary runtime processes.

### 10.1 Web process

Runs:

1. Next.js.
2. Embedded Payload CMS.
3. API routes.
4. SSE route.
5. Frontend renderer.

### 10.2 Worker process

Runs:

1. BullMQ worker.
2. Gemini ingestion pipeline.
3. Schema validation.
4. Claude configuration generation.
5. Insight generation.
6. Event publishing.

Payload is not a separate third service. Payload is embedded inside the Next.js web process.

---

## 11. Functional Requirements

### 11.1 Authentication

#### Requirement

The system must support a single admin user for the initial version.

#### Implementation

1. Use Payload built-in authentication.
2. Use email and password login.
3. Seed one admin user on first boot.
4. Protect all dashboard, upload, dataset, config, and chat routes.

#### Acceptance criteria

1. Unauthenticated users cannot access dashboards.
2. Unauthenticated users cannot upload files.
3. Unauthenticated users cannot access API endpoints except login-related endpoints.
4. Admin can log in and log out.

---

### 11.2 File upload

#### Requirement

The admin must be able to upload a file through the frontend.

#### Supported file formats

Initial version target:

1. XLSX.
2. CSV.

Subsequent phases must support:

1. PDF.
2. Image files, including PNG and JPEG.
3. PPTX.

#### Upload behavior

When a file is uploaded, the system must:

1. Validate file extension and MIME type.
2. Validate file size.
3. Store the raw file in Payload media storage.
4. Compute SHA-256 hash of the file bytes.
5. Create or reuse a File record.
6. Determine whether this upload is duplicate, new, or an update candidate.
7. Create a Job record.
8. Enqueue the job.
9. Return HTTP 202 immediately.

#### Upload limits

Default limits:

1. Maximum file size: 25 MB.
2. Maximum rows per table: 10,000.
3. Maximum total rows across all tables: 25,000.
4. Maximum number of tables per file: 25.

These limits must be configurable through environment variables.

If a file exceeds limits, the system must fail with a clear user-visible error.

#### Acceptance criteria

1. Upload returns immediately and does not block the browser while parsing.
2. The admin sees a job status indicator.
3. Duplicate identical files are detected.
4. Oversized files are rejected with a clear message.
5. Unsupported file types are rejected with a clear message.

---

### 11.3 Duplicate and update handling

#### Requirement

The system must distinguish between duplicate uploads, new datasets, and updates to existing datasets.

#### Identity rules

1. File identity is based on SHA-256 content hash, not filename.
2. Filename is not sufficient identity.
3. If the same file hash already exists, the system must not re-parse it by default.
4. If a filename matches an existing dataset but the hash differs, the system must ask the admin to choose:
   - Update existing dataset.
   - Create new dataset.
5. If the admin chooses update, the new file is linked to the existing dataset.
6. If the admin chooses create new, a new dataset is created.
7. If no filename match exists, a new dataset is created.

#### Duplicate behavior

If an identical file hash already exists:

1. Do not create a new parsing job.
2. Return reference to the existing dataset and dashboard.
3. Show message: file already processed.

#### Update behavior

If the admin chooses to update an existing dataset:

1. Create a new job linked to the existing dataset.
2. Parse the full file again.
3. Validate the new normalized JSON.
4. Only replace existing dataset data after successful validation.
5. Regenerate or update dashboard configuration if needed.
6. Emit dataset-updated and config-updated events.

#### Failed update behavior

If parsing or validation fails:

1. Keep the previous dataset intact.
2. Mark the job failed.
3. Show the error to the admin.
4. Do not replace the dashboard with empty or partial data.

#### Acceptance criteria

1. Re-uploading the exact same file does not trigger a full re-parse.
2. Uploading a changed file with the same filename triggers an explicit user choice.
3. Choosing update replaces data only after success.
4. Choosing create new creates a separate dataset and dashboard.
5. Failed updates do not destroy the previous dashboard.

---

### 11.4 Asynchronous ingestion

#### Requirement

All parsing and AI processing must happen asynchronously.

The upload endpoint must not wait for Gemini or Claude to finish.

#### Job lifecycle

Job statuses:

1. `queued`
2. `processing`
3. `validating`
4. `generating_config`
5. `completed`
6. `failed`
7. `duplicate_noop`

#### Job fields

Each job must store:

1. `id`
2. `fileId`
3. `datasetId`, if known
4. `fileHash`
5. `status`
6. `error`, if failed
7. `retryCount`
8. `createdAt`
9. `updatedAt`
10. `completedAt`

#### Worker behavior

The worker must:

1. Pick jobs from BullMQ.
2. Lock processing per dataset to prevent race conditions.
3. Call Gemini.
4. Validate Gemini output.
5. Retry once on validation failure with a stricter prompt.
6. Store normalized dataset if validation succeeds.
7. Call Claude to generate config and insights.
8. Validate Claude output.
9. Store config.
10. Mark job completed.
11. Publish events.

#### Acceptance criteria

1. Upload endpoint responds quickly with 202.
2. Large files do not crash the HTTP request.
3. The admin can see job progress or status.
4. Two simultaneous uploads for the same dataset do not corrupt data.
5. A failed job does not silently disappear.

---

### 11.5 Gemini parsing requirements

#### Responsibility

Gemini is the extraction engine.

#### Inputs

Gemini receives:

1. The uploaded file or extracted file content.
2. A strict system prompt.
3. The normalized JSON schema contract.
4. Instructions to output JSON only.

#### Outputs

Gemini must return only the normalized JSON structure defined in Section 14.

#### Gemini must detect

1. File type.
2. Tables.
3. Sheet names or page/slide groupings.
4. Header rows.
5. Column names.
6. Column types.
7. Nullable behavior.
8. Sample values.
9. Row data.
10. Potential relationships between tables.

#### Gemini must not output

1. Markdown.
2. Explanations.
3. Chart recommendations.
4. Insights.
5. Dashboard tabs.
6. Widget configuration.
7. Comments.
8. Code fences.

#### Validation

Gemini output must be validated with a strict schema validator such as Zod.

Validation must check:

1. Required fields.
2. Correct types.
3. Valid inferred types.
4. Table structure.
5. Row object structure.
6. Relationship structure.
7. Hash presence.
8. Row count limits.

If validation fails:

1. Retry once with stricter instructions.
2. If retry fails, mark the job failed.
3. Store the validation error.
4. Show a clear error to the admin.

#### Type inference

Supported inferred types:

1. `numeric`
2. `categorical`
3. `date`
4. `id`
5. `text`
6. `boolean`

Guidelines:

1. Columns with parseable numbers, including currency symbols and thousand separators, should be considered numeric when appropriate.
2. Columns with mostly unique values and no aggregation meaning should be considered id.
3. Columns with low-cardinality repeated values should be considered categorical.
4. Columns with parseable temporal values should be considered date.
5. Long free-text values should be considered text.
6. True/false-like values should be considered boolean.

Sample values must be preserved so Claude can sanity-check type inference during config generation.

---

### 11.6 Claude interpretation requirements

#### Responsibility

Claude is the interpretation engine.

#### Claude inputs

Claude may receive:

1. Normalized dataset metadata.
2. Table names.
3. Column names.
4. Inferred types.
5. Sample values.
6. Row counts.
7. Relationships.
8. Aggregated summaries.
9. Existing dashboard config, when editing.
10. Admin prompt, when editing or chatting.

Claude should not receive the full raw dataset unless a specific chat query requires a bounded retrieval.

#### Claude outputs

Claude may output:

1. Dashboard config JSON.
2. Insight JSON.
3. Chat answer JSON or text.
4. Modified dashboard config JSON.

#### Claude must not output

1. Raw file parsing logic.
2. Modified dataset rows.
3. Database write instructions outside config.
4. Unvalidated arbitrary code.
5. Markdown inside JSON fields unless explicitly allowed.

#### Validation

All Claude-generated JSON must be validated before storage.

If Claude output fails validation:

1. Retry once.
2. If retry fails, mark the step failed.
3. Show a clear error.
4. Do not save invalid config.

---

## 12. Dashboard Requirements

### 12.1 Dashboard generation

After successful parsing, the system must generate a dashboard automatically.

The dashboard must include:

1. One or more tabs.
2. Widgets appropriate to the detected data.
3. Written insights.
4. A data table view where useful.
5. KPI cards where meaningful numeric summaries exist.

The dashboard must not require manual setup.

### 12.2 Widget types

Initial supported widget types:

1. `kpi_card`
2. `bar`
3. `line`
4. `pie`
5. `table`

Future widget types may include:

1. `area`
2. `scatter`
3. `stacked_bar`
4. `timeline`
5. `map`

### 12.3 Aggregations

Initial supported aggregations:

1. `none`
2. `sum`
3. `count`
4. `avg`

Future aggregations may include:

1. `min`
2. `max`
3. `count_distinct`
4. `median`

### 12.4 Renderer behavior

The renderer must:

1. Fetch dashboard config.
2. Fetch required dataset data.
3. Render tabs.
4. Render widgets.
5. Handle loading states.
6. Handle error states.
7. Handle empty states.
8. Re-render when SSE events arrive.
9. Avoid full-page reload for config or data updates where possible.

### 12.5 Renderer must not

1. Hardcode dataset names.
2. Hardcode column names.
3. Assume a fixed number of tabs.
4. Assume a fixed number of widgets.
5. Require code changes for new datasets.

---

## 13. Prompt-Based Dashboard Editing

### 13.1 Requirement

The admin must be able to change the dashboard by prompting.

Examples:

1. "Change the revenue chart to a pie chart."
2. "Move the summary cards to the top."
3. "Add a new tab for decisions."
4. "Show only the table view for this dataset."
5. "Remove the pie chart."
6. "Make the pipeline table the first widget."

### 13.2 Editing scope

Prompt editing may change:

1. Widget type.
2. Widget title.
3. Widget position.
4. Tab order.
5. Tab names.
6. Fields used by a widget.
7. Aggregation type.
8. Visibility of widgets.
9. Insight emphasis.

Prompt editing must not change:

1. Raw dataset rows.
2. Parsed column values.
3. File records.
4. Job history.
5. Dataset identity.
6. Uploaded source file.

### 13.3 Editing flow

1. Admin submits prompt.
2. Backend retrieves current config.
3. Backend retrieves dataset metadata.
4. Claude receives current config, metadata, and prompt.
5. Claude returns modified config.
6. Backend validates modified config.
7. Backend saves new config version.
8. Backend emits `config.updated`.
9. Frontend re-renders.

### 13.4 Config versioning

The system must store config versions.

Minimum requirement:

1. Keep current config.
2. Keep previous config version.
3. Store timestamp and source of change.

Full undo/redo UI is not required for initial version, but storage must not prevent it later.

---

## 14. Normalized Dataset Contract

This is the core contract between Gemini and the rest of the system.

All Gemini outputs must conform to this contract.

```json
{
  "datasetId": "string",
  "sourceFile": {
    "name": "string",
    "type": "xlsx | csv | pdf | image | pptx",
    "hash": "sha256-string"
  },
  "tables": [
    {
      "tableName": "string",
      "tableRole": "data | documentation | config | unknown",
      "columns": [
        {
          "name": "string",
          "inferredType": "numeric | categorical | date | id | text | boolean",
          "nullable": true,
          "sampleValues": ["value1", "value2"]
        }
      ],
      "rows": [
        {
          "columnName": "value"
        }
      ],
      "rowHash": "sha256-string"
    }
  ],
  "relationships": [
    {
      "fromTable": "string",
      "fromColumn": "string",
      "toTable": "string",
      "toColumn": "string",
      "confidence": 0.0
    }
  ]
}
```

### 14.1 Field definitions

#### datasetId

Server-assigned unique identifier. Gemini may return a temporary placeholder, but the server must assign the final ID.

#### sourceFile.name

Original filename.

#### sourceFile.type

Detected file type.

Allowed values:

1. `xlsx`
2. `csv`
3. `pdf`
4. `image`
5. `pptx`

#### sourceFile.hash

SHA-256 hash of file bytes.

#### tables

An array of detected tables.

For XLSX, each sheet may become one table.

For CSV, the file usually becomes one table.

For PDF, image, and PPTX, tables may be inferred from visual or textual structure.

#### tableName

Human-readable name of the table.

Examples:

1. Sheet name.
2. Slide title.
3. Inferred table label.

#### tableRole

The likely role of the table.

Allowed values:

1. `data`
2. `documentation`
3. `config`
4. `unknown`

This is an inference, not a hardcoded rule.

#### columns

Column metadata.

#### columns.name

Column name as detected from header row or inferred label.

#### columns.inferredType

Allowed values:

1. `numeric`
2. `categorical`
3. `date`
4. `id`
5. `text`
6. `boolean`

#### columns.nullable

Whether the column appears to allow empty values.

#### columns.sampleValues

Up to five raw sample values.

These are used by Claude to sanity-check type inference.

#### rows

Array of row objects.

Each row object maps column name to value.

#### rowHash

A hash representing all rows in the table.

This must be stored to support future diffing, but row-level diffing is not required in the initial version.

#### relationships

Optional array of inferred relationships between tables.

Confidence is a number between 0 and 1.

---

## 15. Dashboard Config Contract

Claude generates and edits this structure.

```json
{
  "datasetId": "string",
  "title": "string",
  "tabs": [
    {
      "tabId": "string",
      "tabName": "string",
      "widgets": [
        {
          "widgetId": "string",
          "type": "kpi_card | bar | line | pie | table",
          "title": "string",
          "sourceTable": "string",
          "fields": ["columnName"],
          "aggregation": "none | sum | count | avg",
          "position": {
            "row": 0,
            "col": 0,
            "w": 6,
            "h": 4
          }
        }
      ]
    }
  ],
  "insights": [
    {
      "insightId": "string",
      "title": "string",
      "body": "string",
      "severity": "info | warning | positive | negative",
      "relatedTables": ["string"]
    }
  ]
}
```

### 15.1 Config rules

1. Claude may only emit this structure.
2. The frontend must render only from this structure.
3. Config must not contain raw dataset rows.
4. Config may reference table names and column names.
5. Config must be validated before storage.
6. Config changes must not modify dataset rows.

---

## 16. Insight Requirements

### 16.1 Purpose

Insights must explain what matters in the data.

Insights are not merely chart descriptions.

Good insight examples:

1. "The model annual revenue is 7.23425 Cr against a committed target of 12.21 Cr, leaving a gap of 4.97575 Cr."
2. "Entry has the highest exit count at 78, contributing 2.6795 Cr annual revenue."
3. "Total expected pipeline is 31.44 Cr against total contracted pipeline of 30.429 Cr."
4. "75 pipeline accounts are unowned and actionable."
5. "Q1 billing actual is 1.98 Cr; Q2 to Q4 billing actuals are not yet filled."

### 16.2 Insight generation rules

Claude should generate insights about:

1. Key totals.
2. Gaps.
3. Trends.
4. Outliers.
5. Missing data.
6. Ownership gaps.
7. Category concentration.
8. Date-based patterns.
9. Relationships between tables.
10. Data quality issues.

### 16.3 Insight constraints

1. Insights must be grounded in the parsed data.
2. Insights must not invent values.
3. If a value is missing, Claude may note the absence but must not fabricate it.
4. Insights must be concise.
5. Insights must be stored as structured JSON.

---

## 17. Chat Agent Requirements

### 17.1 Purpose

The admin must be able to ask natural-language questions about the active dataset.

Example questions:

1. "What is the gap to commit?"
2. "Which band has the highest annual revenue?"
3. "How many pipeline accounts are unowned?"
4. "Show me decisions from July 2026."
5. "What is total expected pipeline?"
6. "Which tables exist in this dataset?"

### 17.2 Chat permissions

The chat agent must have read-only access to the active dataset.

The chat agent must not:

1. Modify dataset rows.
2. Modify files.
3. Modify jobs.
4. Modify users.
5. Access another dataset unless explicitly authorized.
6. Execute arbitrary code.
7. Bypass Payload access control.

### 17.3 Chat implementation rules

1. Chat requests must be scoped by `datasetId`.
2. The backend must enforce dataset scope.
3. Claude may receive aggregated query results, not necessarily full raw data.
4. If a question requires data lookup, the backend should perform the lookup and pass bounded results to Claude.
5. If the answer is not present, Claude must say so.

### 17.4 Chat answer format

The chat answer should include:

1. Direct answer.
2. Optional supporting numbers.
3. Optional source table reference.
4. No fabricated values.

---

## 18. Real-Time Update Requirements

### 18.1 Event mechanism

The system must use Server-Sent Events.

Required events:

1. `job.updated`
2. `dataset.updated`
3. `config.updated`

### 18.2 Event payload

Minimum payload:

```json
{
  "event": "dataset.updated",
  "datasetId": "string",
  "jobId": "string",
  "timestamp": "ISO-8601"
}
```

### 18.3 Frontend behavior

When the frontend receives an event:

1. If the event belongs to the open dashboard, refresh affected data.
2. If `config.updated`, fetch latest config and re-render.
3. If `dataset.updated`, refresh widget data.
4. If `job.updated`, update job status UI.

### 18.4 Performance target

For datasets within the v1 limits:

1. SSE event delivery should occur within 2 seconds of worker publication.
2. Frontend re-render should occur within 2 seconds of event receipt.
3. Full parsing and dashboard generation target is under 60 seconds for small clean files, subject to AI provider latency.

---

## 19. Data Model

Payload domain collections:

1. `Users`
2. `Files`
3. `Datasets`
4. `Configs`
5. `Jobs`

`Users` is required for Payload authentication. The other four are the core domain collections.

### 19.1 Users

Fields:

1. `id`
2. `email`
3. `password`, hashed by Payload
4. `role`, default `admin`
5. `createdAt`
6. `updatedAt`

Initial version requires only one admin role.

### 19.2 Files

Fields:

1. `id`
2. `filename`
3. `mimeType`
4. `size`
5. `sha256`
6. `storagePath`
7. `uploadedBy`
8. `createdAt`

### 19.3 Datasets

Fields:

1. `id`
2. `name`
3. `currentFileId`
4. `currentFileHash`
5. `status`
6. `tableNames`
7. `totalRows`
8. `createdBy`
9. `createdAt`
10. `updatedAt`

Dataset statuses:

1. `processing`
2. `ready`
3. `failed`
4. `updating`

### 19.4 Configs

Fields:

1. `id`
2. `datasetId`
3. `version`
4. `config`
5. `insights`
6. `generatedBy`
7. `createdAt`

### 19.5 Jobs

Fields:

1. `id`
2. `fileId`
3. `datasetId`
4. `fileHash`
5. `status`
6. `retryCount`
7. `error`
8. `createdAt`
9. `updatedAt`
10. `completedAt`

---

## 20. API Requirements

Payload may provide many endpoints automatically. The application must expose the following functional capabilities.

### 20.1 Upload file

```text
POST /api/uploads
```

Request:

- multipart/form-data
- file field

Response:

```json
{
  "jobId": "string",
  "fileId": "string",
  "datasetId": "string | null",
  "status": "queued | duplicate_noop",
  "existingDatasetId": "string | null",
  "requiresUserChoice": false
}
```

If filename collision requires user choice:

```json
{
  "requiresUserChoice": true,
  "existingDatasetId": "string",
  "fileId": "string",
  "message": "A dataset with this filename exists. Choose whether to update it or create a new dataset."
}
```

### 20.2 Confirm update choice

```text
POST /api/uploads/confirm
```

Request:

```json
{
  "fileId": "string",
  "existingDatasetId": "string",
  "choice": "update_existing | create_new"
}
```

Response:

```json
{
  "jobId": "string",
  "datasetId": "string",
  "status": "queued"
}
```

### 20.3 Get job status

```text
GET /api/jobs/:id
```

Response:

```json
{
  "id": "string",
  "status": "queued | processing | validating | generating_config | completed | failed | duplicate_noop",
  "error": "string | null",
  "datasetId": "string | null",
  "updatedAt": "ISO-8601"
}
```

### 20.4 List datasets

```text
GET /api/datasets
```

Response:

Array of dataset summaries.

### 20.5 Get dataset metadata

```text
GET /api/datasets/:id
```

Response:

```json
{
  "id": "string",
  "name": "string",
  "status": "string",
  "tableNames": ["string"],
  "totalRows": 0,
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

### 20.6 Get dataset data

```text
GET /api/datasets/:id/data
```

Optional query params:

1. `table`
2. `limit`
3. `offset`

Response:

```json
{
  "datasetId": "string",
  "table": "string",
  "columns": [
    {
      "name": "string",
      "inferredType": "string"
    }
  ],
  "rows": [
    {}
  ]
}
```

### 20.7 Get dashboard config

```text
GET /api/datasets/:id/config
```

Response:

Dashboard config JSON.

### 20.8 Update dashboard config by prompt

```text
POST /api/datasets/:id/config/prompt
```

Request:

```json
{
  "prompt": "Change the revenue chart to a pie chart."
}
```

Response:

```json
{
  "datasetId": "string",
  "configVersion": 2,
  "status": "updated"
}
```

### 20.9 Chat with dataset

```text
POST /api/datasets/:id/chat
```

Request:

```json
{
  "message": "What is the gap to commit?"
}
```

Response:

```json
{
  "answer": "string",
  "sources": ["string"],
  "datasetId": "string"
}
```

### 20.10 SSE event stream

```text
GET /api/events
```

Or dataset-scoped:

```text
GET /api/events/datasets/:id
```

Response:

SSE stream.

Example:

```text
event: dataset.updated
data: {"datasetId":"123","jobId":"456","timestamp":"2026-08-12T00:00:00.000Z"}
```

---

## 21. Security and Access Control

### 21.1 Authentication

1. All non-public routes require authentication.
2. Payload session or JWT must be used.
3. API keys must never be exposed to the browser.

### 21.2 API key handling

The following keys must exist only on the server:

1. Gemini API key.
2. Anthropic API key.
3. Database credentials.
4. Redis credentials, if used.
5. Payload secret.

### 21.3 Payload access control

Access control must enforce:

1. Admin can read and write all collections.
2. Claude service pathway can read datasets scoped to active dataset.
3. Claude service pathway can write only configs.
4. Claude service pathway cannot write datasets.
5. Claude service pathway cannot write files.
6. Claude service pathway cannot write jobs.
7. Claude service pathway cannot write users.

This must be enforced in Payload access control, not only by prompt instructions.

### 21.4 Prompt injection defense

The system must treat file content as untrusted input.

Rules:

1. File content must not be executed.
2. File content must not override system instructions.
3. Claude must not be given tools that can write datasets.
4. User prompts may edit config only.
5. Uploaded content should be sanitized where appropriate.

### 21.5 File upload security

1. Validate MIME type.
2. Validate extension.
3. Enforce size limits.
4. Store files outside publicly writable web paths where possible.
5. Do not render uploaded HTML or script content directly.

---

## 22. Error Handling Requirements

### 22.1 General rule

Errors must be visible, specific, and recoverable where possible.

### 22.2 Gemini malformed output

If Gemini returns malformed JSON:

1. Validate output.
2. Retry once with stricter prompt.
3. If still invalid, mark job failed.
4. Show error: "Parser output failed validation."
5. Include technical detail in job record.

### 22.3 Gemini type misclassification

If Claude detects that a chart choice would fail due to likely type misclassification:

1. Claude may choose a safer widget.
2. Claude may mark an insight warning about data quality.
3. The system must not crash.

Example:

A column labeled "amount" contains values like "₹1,000" and Gemini marks it as text. Claude can still choose a table or warn that numeric parsing is uncertain.

### 22.4 File too large

If file exceeds limits:

1. Reject job.
2. Show clear limit message.
3. Do not partially import without warning.

### 22.5 AI provider timeout

If Gemini or Claude times out:

1. Retry once where safe.
2. Mark job failed if retry fails.
3. Preserve previous dataset if this was an update.

### 22.6 Race condition

If two jobs target the same dataset:

1. Use a dataset-level lock.
2. Process jobs sequentially.
3. Do not allow concurrent config writes for the same dataset.

### 22.7 Empty data

If a table has zero rows:

1. Store table metadata.
2. Show empty state in dashboard.
3. Do not generate misleading charts.

---

## 23. Performance Requirements

### 23.1 Upload response

Upload endpoint should return within 500 ms after file storage and job creation for typical local files.

### 23.2 Parsing time

For clean files within v1 limits:

1. Target parsing and validation under 60 seconds.
2. AI provider latency may affect actual time.
3. The UI must show progress/status.

### 23.3 Dashboard load

For datasets within v1 limits:

1. Initial dashboard render should occur within 2 seconds after config and data fetch.
2. Widget data should be paginated or aggregated where appropriate.
3. Tables should not render more than 100 rows initially unless paginated.

### 23.4 Update responsiveness

After a successful update:

1. SSE event should be emitted immediately.
2. Frontend should reflect update within a few seconds.

---

## 24. Local Development Environment

### 24.1 Required tools

1. Node.js 20 or newer.
2. pnpm.
3. Docker.
4. Docker Compose.
5. Git.

### 24.2 Services

Docker Compose must provide:

1. PostgreSQL.
2. Redis.

### 24.3 Environment variables

Required environment variables:

```env
DATABASE_URI=postgresql://postgres:postgres@localhost:5432/analytics_dashboard
REDIS_URL=redis://localhost:6379
PAYLOAD_SECRET=replace-with-long-random-secret
GEMINI_API_KEY=replace-with-gemini-key
ANTHROPIC_API_KEY=replace-with-anthropic-key
PUBLIC_APP_URL=http://localhost:3000
UPLOAD_MAX_SIZE_MB=25
MAX_ROWS_PER_TABLE=10000
MAX_TOTAL_ROWS=25000
MAX_TABLES_PER_FILE=25
```

### 24.4 Commands

```bash
docker compose up -d
pnpm install
pnpm dev
pnpm worker
```

The web app runs on localhost, typically port 3000.

The worker runs as a separate process.

---

## 25. Repository Structure

Recommended structure:

```text
/
  apps/
    web/
      app/
        (auth)/
        (dashboard)/
        api/
      components/
        dashboard/
        chat/
        upload/
        ui/
      lib/
        payload/
        ai/
        queue/
        validation/
        events/
      payload.config.ts
      server.ts
  worker/
    index.ts
    processors/
      ingestion.ts
    services/
      gemini.ts
      claude.ts
      validation.ts
      events.ts
  infra/
    docker-compose.yml
  packages/
    shared/
      schemas/
        normalized-dataset.ts
        dashboard-config.ts
        job.ts
      types/
      constants/
  scripts/
    seed-admin.ts
  .env.example
  package.json
  pnpm-workspace.yaml
```

Note:

Payload is embedded in the Next.js web app. The `apps/web` directory is the main web process. The `worker` directory is the separate background process.

---

## 26. Build Phases

### Phase 1: Foundation

Goal: Local app runs with Payload, PostgreSQL, Redis, authentication, and job infrastructure.

Requirements:

1. Docker Compose starts PostgreSQL and Redis.
2. Next.js starts with embedded Payload.
3. Admin user can be seeded.
4. Admin can log in.
5. Collections exist: Users, Files, Datasets, Configs, Jobs.
6. Upload endpoint stores file and creates Job.
7. Job record transitions through states.
8. No Gemini or Claude integration required yet.

Acceptance criteria:

1. `docker compose up -d` works.
2. `pnpm dev` starts web app.
3. `pnpm worker` starts worker.
4. Admin can log in.
5. File upload creates File and Job records.
6. Job appears in Payload admin or internal jobs UI.

---

### Phase 2: Gemini Extraction

Goal: One file type works end-to-end through extraction and storage.

Primary file type:

1. XLSX.

Secondary file type:

1. CSV.

Requirements:

1. Worker consumes job.
2. Worker calls Gemini.
3. Gemini returns normalized JSON.
4. Output is validated with Zod.
5. Dataset is stored.
6. Job completes.
7. Job failure is visible when output is invalid.

Acceptance criteria:

1. Upload Treelife XLSX.
2. Job completes.
3. Dataset contains detected tables.
4. README-like documentation table is not treated as primary analytic data if inferable.
5. Constants, Bands, Onboarding, Pipeline, and Decisions tables are detected.
6. No rows are silently dropped for detected data tables.
7. Invalid Gemini output causes visible failure.

---

### Phase 3: Claude Config Generation and Renderer

Goal: A real dashboard appears with zero manual configuration.

Requirements:

1. Claude receives normalized dataset metadata.
2. Claude generates dashboard config.
3. Claude generates insights.
4. Config is validated.
5. Config is stored.
6. Frontend renders tabs and widgets from config.
7. Insights panel renders.

Acceptance criteria:

1. After Treelife upload, dashboard appears automatically.
2. At least one KPI card, one chart, and one table are rendered.
3. Insights are shown.
4. No hardcoded Treelife component exists in renderer.
5. A different dataset can render without code changes.

---

### Phase 4: Real-Time Updates and Prompt Editing

Goal: The dashboard updates in place and can be edited by prompt.

Requirements:

1. SSE route emits events.
2. Worker publishes events after completion.
3. Frontend listens and refreshes.
4. Prompt-to-edit endpoint works.
5. Claude modifies config only.
6. Config version is stored.
7. Data remains unchanged after prompt edit.

Acceptance criteria:

1. Re-upload updated file and choose update existing.
2. Dashboard updates without manual refresh.
3. Prompt "Change this chart to a table" works.
4. Prompt "Add a new tab" works.
5. Dataset rows remain unchanged after prompt edit.
6. Failed prompt edit does not corrupt existing config.

---

### Phase 5: Chat Agent

Goal: Admin can ask questions about the active dataset.

Requirements:

1. Chat UI exists.
2. Chat is scoped to active dataset.
3. Backend enforces read-only access.
4. Claude answers using retrieved data.
5. Claude cannot modify data.

Acceptance criteria:

1. "What is the gap to commit?" returns the correct value if present.
2. "Which tables exist?" returns table names.
3. Chat does not expose another dataset.
4. Chat cannot write data.
5. Missing values are handled honestly.

---

### Phase 6: Additional File Formats

Goal: Extend parsing beyond XLSX and CSV.

Requirements:

1. PDF parsing.
2. Image OCR.
3. PPTX extraction.

Acceptance criteria:

1. A clean PDF with tables produces normalized dataset.
2. An image with text produces normalized dataset or clear text table.
3. A PPTX with tables produces normalized dataset.
4. Unsupported or low-quality files fail with clear errors.

---

## 27. Demo Dataset Acceptance

The following dataset is used as a validation fixture:

`treelife-fy27-demo-dataset-v2.xlsx`

This dataset is a test fixture only. The application must not contain hardcoded logic for it.

### 27.1 Expected detected tables

The system should detect:

1. README or documentation-like table.
2. Constants.
3. Bands.
4. Onboarding.
5. Pipeline.
6. Decisions.

### 27.2 Expected table roles

Inferred roles should be similar to:

1. README: `documentation`
2. Constants: `config`
3. Bands: `data`
4. Onboarding: `data`
5. Pipeline: `data`
6. Decisions: `data`

These roles must be inferred, not hardcoded.

### 27.3 Expected key values for validation

The parsed dataset should preserve or allow computation of:

1. `COMMITTED_TARGET_Cr = 12.21`
2. `TAIL_CR = 0.66`
3. `TAIL_CLIENTS = 114`
4. `QF_Q1 = 0.875`
5. `QF_Q2 = 0.625`
6. `QF_Q3 = 0.375`
7. `QF_Q4 = 0.125`
8. Model annual revenue: `7.23425`
9. Committed target: `12.21`
10. Gap to commit: `4.97575`
11. Exit run rate: `9.9`
12. Total contracted pipeline: `30.429`
13. Total expected pipeline: `31.44`
14. Total uplift: `101.1`
15. Unowned actionable: `75`
16. Q1 billing actual: `1.98`

### 27.4 Expected dashboard behavior

The generated dashboard should include:

1. A summary or overview area.
2. A Bands view.
3. An Onboarding view.
4. A Pipeline view.
5. A Decisions view.
6. A Constants or reference values view where useful.

The exact tabs and widgets may be generated by Claude, but the dashboard must not require manual configuration.

### 27.5 Expected insight examples

Claude may generate insights similar to:

1. "The model annual revenue is 7.23425 Cr, which is 4.97575 Cr below the committed target of 12.21 Cr."
2. "Entry has the largest exit count at 78 and contributes 2.6795 Cr annual revenue."
3. "Pipeline expected value is 31.44 Cr, slightly above contracted value of 30.429 Cr."
4. "75 pipeline accounts are unowned and actionable."
5. "Q1 billing actual is 1.98 Cr, while Q2, Q3, and Q4 billing actuals are currently empty."

These are validation examples, not hardcoded required strings.

---

## 28. Testing Requirements

### 28.1 Unit tests

Required for:

1. Normalized dataset schema validation.
2. Dashboard config schema validation.
3. File hash identity logic.
4. Upload duplicate detection.
5. Update-vs-new choice logic.
6. Payload access control rules.
7. Aggregation helpers.

### 28.2 Integration tests

Required for:

1. Upload creates File and Job.
2. Worker processes job.
3. Mock Gemini response is validated and stored.
4. Mock Claude config is validated and stored.
5. Job failure path stores error.
6. SSE event is emitted on completion.

### 28.3 End-to-end tests

Required for:

1. Upload Treelife XLSX.
2. Job completes.
3. Dataset stored.
4. Dashboard config generated.
5. Dashboard renders.
6. Prompt edit updates config.
7. Chat returns grounded answer.

### 28.4 Security tests

Required for:

1. Unauthenticated access blocked.
2. Claude pathway cannot write dataset.
3. Dataset scoping prevents cross-dataset chat access.
4. Invalid file type rejected.
5. Oversized file rejected.

---

## 29. Definition of Done

The initial version is complete when all of the following are true.

### 29.1 Upload and parsing

1. Admin can upload XLSX and CSV files.
2. Files are parsed asynchronously.
3. Gemini output is validated.
4. Dataset is stored in PostgreSQL through Payload.
5. Errors are visible and do not silently drop data.

### 29.2 Dashboard

1. Dashboard is generated automatically.
2. Dashboard contains tabs, widgets, and insights.
3. Renderer is config-driven.
4. No dataset-specific hardcoded UI exists.
5. Dashboard loads within performance targets for v1 dataset sizes.

### 29.3 Updates

1. Identical file upload is detected as duplicate.
2. Changed file with same filename triggers explicit user choice.
3. Update path fully re-parses and replaces data only after success.
4. Failed update preserves previous dataset.
5. Dashboard updates via SSE.

### 29.4 Prompt editing

1. Admin can prompt to change chart type.
2. Admin can prompt to rearrange or add tabs.
3. Claude edits config only.
4. Data remains unchanged.
5. Config changes are validated and versioned.

### 29.5 Chat

1. Admin can ask questions.
2. Answers are based on active dataset.
3. Chat is read-only.
4. Chat is scoped to the active dataset.

### 29.6 Security

1. Admin authentication works.
2. API keys are server-side only.
3. Payload access control enforces Claude's limited permissions.
4. Uploaded files are validated.

### 29.7 Local run

The app can be started locally with:

```bash
docker compose up -d
pnpm install
pnpm dev
pnpm worker
```

---

## 30. Risks and Mitigations

### 30.1 Risk: Gemini outputs invalid JSON

Mitigation:

1. Strict JSON-only prompt.
2. Zod validation.
3. One automatic retry.
4. Loud failure.

### 30.2 Risk: Gemini misclassifies column types

Mitigation:

1. Store sample values.
2. Let Claude sanity-check during config generation.
3. Prefer safe widgets when uncertain.
4. Show data-quality insight if needed.

### 30.3 Risk: Large files exceed AI context limits

Mitigation:

1. Enforce row and file-size limits.
2. Fail with clear message.
3. Future support for chunked parsing.

### 30.4 Risk: Prompt editing accidentally modifies data

Mitigation:

1. Claude has no dataset write tool.
2. Payload access control blocks dataset writes.
3. Config schema validation rejects data mutation fields.
4. Audit config versions.

### 30.5 Risk: Multi-sheet files misread as single sheet

Mitigation:

1. Require Gemini to enumerate all detected tables.
2. Validate table count and names.
3. Show detected tables in UI.
4. Do not treat first table as the only table.

### 30.6 Risk: Documentation tables mistaken for data

Mitigation:

1. Infer `tableRole`.
2. Claude should avoid making documentation tables primary charts.
3. Documentation may still be shown as text or table if useful.

### 30.7 Risk: Real-time complexity

Mitigation:

1. Use SSE, not WebSockets.
2. Use one event stream per dashboard or global event stream with filtering.
3. Keep event payloads small.
4. Frontend refetches affected resources instead of trying to mutate state directly from event payload.

---

## 31. Future Extensions

These are not required for initial delivery but should not be blocked.

1. Map widget for latitude/longitude data.
2. More chart types.
3. Filters and slicers.
4. Scheduled refresh from Google Drive.
5. Direct Google Sheets ingestion.
6. Export dashboard config.
7. Import dashboard config.
8. Multi-user roles.
9. Team workspaces.
10. Dataset version history.
11. Full undo/redo for config edits.
12. Voice prompting.
13. Automated anomaly detection.
14. Alerts.
15. Slack or email notifications.
16. MCP integration for Claude agent.

---

## 32. MCP Note

The initial agent integration should use Claude API through backend-mediated tools.

MCP may be introduced later once the core flow is stable.

When MCP is introduced:

1. Claude's tools must remain scoped.
2. Read tools may access datasets.
3. Write tools may access configs only.
4. No tool may write dataset rows.
5. MCP must not bypass Payload access control.

---

## 33. Implementation Rules for AI Coding Agents

Any AI coding agent working on this project must obey these rules.

1. Do not add Python.
2. Do not add FastAPI.
3. Do not hardcode dataset names.
4. Do not hardcode column names.
5. Do not build fixed dashboard layouts.
6. Do not let Claude write to dataset collections.
7. Do not trust Gemini output without validation.
8. Do not trust Claude output without validation.
9. Do not silently drop rows.
10. Do not block upload requests on AI calls.
11. Do not expose API keys to the client.
12. Do not replace an existing dataset with failed parsing output.
13. Do not infer update-vs-new from filename alone.
14. Do not implement row-level diffing in v1 unless explicitly requested.
15. Do not add new runtime services beyond web and worker without approval.

---

## 34. Final Acceptance Scenario

The following scenario must pass for the initial version to be accepted.

1. Start local environment.
2. Log in as admin.
3. Upload `treelife-fy27-demo-dataset-v2.xlsx`.
4. System returns 202 and shows job processing.
5. Worker parses file with Gemini.
6. Normalized dataset is validated.
7. Tables are stored.
8. Claude generates dashboard config and insights.
9. Dashboard appears automatically.
10. Dashboard shows meaningful views for Bands, Onboarding, Pipeline, Decisions, and Constants.
11. Insights include the gap to commit or equivalent finding.
12. Admin asks in chat: "What is the gap to commit?"
13. System answers using stored data.
14. Admin prompts: "Change the first chart to a table."
15. Config updates.
16. UI updates.
17. Dataset rows remain unchanged.
18. Re-upload identical file.
19. System detects duplicate and does not re-parse unnecessarily.
20. Upload modified file with same filename.
21. System asks whether to update existing dataset or create new.
22. Choose update existing.
23. Dashboard updates after successful parsing.
24. No silent failure occurs anywhere in the flow.

If all steps pass, the core product requirement is satisfied.

---

## 35. Glossary

### Dataset

A parsed, normalized representation of an uploaded file.

### Config

The JSON structure that defines dashboard tabs, widgets, layout, and insights.

### Renderer

The frontend system that draws the dashboard from config.

### Normalized JSON

The common data contract produced by Gemini for every uploaded file.

### Job

An asynchronous processing task that parses a file and generates a dataset and config.

### Source of truth

The uploaded file. The dashboard reflects the latest successfully parsed version of that file.

### Prompt editing

Natural-language modification of dashboard config.

### Table role

The inferred purpose of a table, such as data, documentation, or config.

### SSE

Server-Sent Events, used for real-time dashboard updates.

---

## 36. Approval

This document defines the complete initial requirement.

Any change to the following requires explicit approval:

1. Adding Python.
2. Adding FastAPI.
3. Changing the Gemini/Claude responsibility split.
4. Removing asynchronous job processing.
5. Removing schema validation.
6. Allowing Claude to write datasets.
7. Hardcoding dataset-specific UI.
8. Changing the primary database away from PostgreSQL without migration plan.
9. Adding a third runtime service.
10. Changing the upload-based, zero-hardcoding principle.

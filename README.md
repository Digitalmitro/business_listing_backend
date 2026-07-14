# UrbanCitations business listing backend

## Production observability

The backend emits structured, correlation-aware logs for application lifecycle,
HTTP requests, response time, handled errors, crashes, MongoDB, Redis/BullMQ,
memory, process CPU, event-loop delay, and whole-machine CPU. Production logs are
one-line JSON; development logs use a compact, human-readable format.

Sensitive keys such as passwords, cookies, authorization headers, tokens, API
keys, OTPs, and signatures are recursively redacted. Request and response bodies
are deliberately not logged.

Each response includes an `X-Request-ID`. A safe incoming `X-Request-ID` is
preserved, allowing one ID to be followed across a client, proxy, API logs, and
database diagnostics.

### Run locally

```sh
npm install
npm start
```

Local `server.js` startup will run queue workers inline by default. If you need
to disable that behavior, set `INLINE_WORKERS=false` in `.env`.

Useful health checks:

- `GET /health/live` — confirms the Node.js process is alive.
- `GET /health/ready` — confirms MongoDB and Redis are ready.

## Business CSV/XLSX imports

Send one `.csv` or `.xlsx` file in the `file` or legacy `csvFile` multipart field:

```text
POST /api/business/import
POST /api/business/import-csv
```

Both routes require authentication. The only required columns are `Business Name`
and `Phone`. Optional columns are `Email`, `Address`, `Website`, `Rating`,
`Reviews`, `Latitude`, `Longitude`, `Category`, `Subcategory`, and `Country`.
The response contains summary counts, failure counts by reason, and the first
page of row-level results.

Retrieve any result page later with:

```text
GET /api/business/import-batches/:batchId?page=1&limit=100
GET /api/business/import-batches/:batchId/rows?page=1&limit=100
```

The import stores batch metadata and one audit record per file row. Processing
is chunked and unordered business inserts allow valid rows to succeed even when
other rows fail. Defaults are a 25 MB file limit, 100,000 rows, and 500 rows per
chunk; these can be changed with `BUSINESS_IMPORT_MAX_FILE_BYTES`,
`BUSINESS_IMPORT_MAX_ROWS`, and `BUSINESS_IMPORT_CHUNK_SIZE`.

See `.env.observability.example` for all observability settings. Shell and PM2
environment variables take precedence over `.env`.

## PM2 production setup

Install PM2 on the production host and start the complete process group:

```sh
npm install --global pm2
npm run pm2:start
npm run pm2:setup-logs
pm2 startup
npm run pm2:save
```

Run the exact command printed by `pm2 startup` before `pm2 save`. The ecosystem
starts:

- `business-listing-api`: two cluster instances by default, with zero-downtime reloads.
- `business-listing-workers`: one graceful BullMQ worker process.
- `business-listing-cpu-monitor`: one whole-machine CPU supervisor.

PM2 uses the same `.env`, but the ecosystem explicitly forces
`INLINE_WORKERS=false` for PM2-managed processes so the API does not start a
second copy of the BullMQ workers.

Override API concurrency with `WEB_CONCURRENCY`. Do not set it higher than the
MongoDB connection capacity of the production environment.

### Deploy, reload, and restart

For routine code/config deployments, use the graceful path:

```sh
npm run pm2:deploy
```

For an on-demand API-only zero-downtime reload:

```sh
npm run pm2:reload
```

`pm2 reload` starts replacement cluster workers, waits for MongoDB and the HTTP
listener to become ready, then sends the old workers `SIGINT`. Old workers stop
accepting traffic, drain active requests, and close Redis and MongoDB before
exiting.

Use a hard restart only when reload cannot recover the process:

```sh
npm run pm2:restart
```

### Logs and rotation

```sh
npm run pm2:status
npm run pm2:logs
pm2 logs business-listing-workers --lines 200
pm2 logs business-listing-cpu-monitor --lines 200
```

PM2 writes stdout and stderr to `logs/`. The setup command installs
`pm2-logrotate` with these defaults:

- rotate at 20 MB or daily at midnight;
- retain 14 rotated files;
- compress rotated files.

The `logs/` directory and `.env` are excluded from Git.

## PM2.io dashboard and phone access

Create a PM2.io bucket at [app.pm2.io](https://app.pm2.io), then use the bucket's
secret and public keys once on the production host:

```sh
pm2 link <secret-key> <public-key> urban-citations-production
pm2 save
```

Never commit either key. Once linked, open the same PM2.io dashboard from the
phone browser to view processes, CPU/memory charts, issues, restarts, alerts, and
realtime logs. Realtime dashboard logs are not a replacement for retained local
rotated logs.

`@pm2/io` reports custom HTTP request rate, active requests, error rate, slow
request rate, p95 response time, and handled server errors. Transaction tracing
is opt-in because it adds overhead. Low-level network metrics are also opt-in
because the current `@pm2/io` socket instrumentation can accumulate listeners
on long-lived MongoDB connections:

```sh
PM2_TRANSACTION_TRACING=true
PM2_TRACE_SAMPLING_RATE=10
PM2_NETWORK_METRICS=false
npm run pm2:reload
```

## RCA workflow

Production events contain `timestamp`, `level`, `service`, `event`, `pid`, PM2
instance metadata, and contextual fields. Request events also contain
`requestId`, `method`, and `path`.

Example:

```json
{"timestamp":"2026-06-22T12:00:00.000Z","level":"warn","service":"business-listing-api","event":"http.slow_request","requestId":"...","method":"GET","path":"/api/business","statusCode":200,"durationMs":2431.52,"slowRequestMs":2000}
```

For an incident:

1. Start with `process.crash`, `application.startup_failed`, `pm2.restart_*`, or the PM2 restart counter.
2. Search the surrounding timestamps for `resources.warning`, `cpu.sustained_high`, or `http.slow_request`.
3. Follow the slow or failed request's `requestId` through `http.request_error` and legacy controller errors.
4. Check `database.slow_command`, `database.command_failed`, `database.checkout_failed`, and Redis events.
5. Use the `errorId` returned to the client to locate the full server-side stack without exposing it publicly.

Example local correlation search:

```sh
rg 'REQUEST_ID_HERE|ERROR_ID_HERE' logs
```

Important event families:

| Family | Examples |
| --- | --- |
| Lifecycle/crashes | `application.starting`, `application.ready`, `process.crash`, `application.shutdown_complete` |
| HTTP | `http.request_completed`, `http.slow_request`, `http.request_error`, `http.client_error` |
| MongoDB | `database.connected`, `database.slow_command`, `database.command_failed`, `database.pool_cleared` |
| Redis/queues | `redis.ready`, `redis.reconnecting`, `queue.job_added`, `queue.add_failed` |
| Resources | `resources.sample`, `resources.warning`, `cpu.sustained_high` |
| PM2 recovery | `pm2.restart_started`, `pm2.restart_succeeded`, `pm2.restart_suppressed` |

## Resource and CPU thresholds

The in-process resource monitor logs memory, process CPU, system memory, heap
pressure, and event-loop p95/max delay every minute. Defaults are in
`.env.observability.example`.

The separate CPU monitor samples whole-machine CPU once per minute. It starts
tracking at 60%, starts warning-level tracking at 70%, logs a sustained warning
after five minutes, and invokes `pm2 restart all` at 75%.

Its restart attempt is persisted before PM2 is called. This matters because the
monitor restarts itself as part of `restart all`; the persisted 15-minute cooldown
prevents a high-CPU restart loop.

## Enterprise CRM & Sales Automation Suite

The application includes a fully configuration-driven, production-ready CRM suite designed for enterprise lead tracking, AI reply classification, and automated multi-touch follow-up workflows.

### Key Architectural Highlights:
1. **Configuration-Driven Engine (`CrmConfig`)**: Pipeline stages (`Lead`, `Contact Made`, `Meeting Scheduled`, etc.), probability weights for revenue forecasting, event types, reply classification keywords (`Warm Lead`, `Cold Lead`), and scheduler frequency are stored dynamically in MongoDB and managed via the Admin CRM Panel (`/crm`). No hardcoded status rules or intervals.
2. **Automated Cadence Dispatcher (`leadFollowUpWorker.js`)**: Background worker powered by Redis/BullMQ that checks `CrmFollowUpConfig` settings (`intervalDays`, `maxFollowUps`) and queues automated follow-up touches without blocking main API request threads. Uses distributed Redis locking (`acquireLock`) to prevent concurrent duplicate runs across multi-instance clusters.
3. **AI Reply Sentiment & Classification (`CrmReplyLog`)**: Inbound webhooks (`/api/crm/leads/replies/reply-webhook`) and manual overrides classify replies (`Warm Lead`, `Cold Lead`, `Pending Follow-Up`) with strict keyword precedence, automatically adjusting pipeline status and logging full audit trails.
4. **CRM Audit Logs & CSV Import/Export (`CrmAuditLog`)**: Immutable audit tracking (`create_lead`, `convert_contact`, `send_followup`, `receive_reply`, `import_leads`) with CSV export capabilities, plus batch CSV/Excel spreadsheet upload (`/api/crm/leads/import`) supporting custom fields and status fallbacks.
5. **Admin CRM Panel (`business_listing_admin/src/views/CRM/`)**: A modern 7-tab CoreUI suite (`CrmPanel.jsx`) providing an Executive Dashboard, Kanban Pipeline board, Contact Directory (with 1-click `Convert to Lead`), Cadence Automation Settings, AI Reply Logs, Scheduled Events Calendar, and System Audit Logs.

### CRM API Endpoints Summary:
- `GET/POST /api/crm/leads` — Manage sales opportunities, add activities (`/:id/activities`), and reorder Kanban (`/kanban/reorder`).
- `POST /api/crm/leads/import` — Multipart CSV/Excel batch upload.
- `GET/POST /api/crm/contacts` — Contact directory management & conversion (`/:id/convert`).
- `GET/PUT /api/crm/leads/followup/config` — Configuration-driven automated cadence settings.
- `POST /api/crm/leads/followup/process` — Manually trigger background follow-up sweep.
- `POST /api/crm/leads/replies/reply-webhook` — Public HMAC-verified/rate-limited webhook for inbound email tracking.
- `GET /api/crm/forecast` — Weighted probability revenue forecasting.
- `GET /api/crm/audit` & `/export` — Filtered audit logs and CSV export.
- `GET/PUT /api/crm/config/stages` — Dynamic stage ordering & probabilities.

## Tests

```sh
npm test
```

Focused suites are also available as `npm run test:observability` and
`npm run test:cpu-monitor`.

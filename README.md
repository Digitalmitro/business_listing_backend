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

Useful health checks:

- `GET /health/live` — confirms the Node.js process is alive.
- `GET /health/ready` — confirms MongoDB and Redis are ready.

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

## Tests

```sh
npm test
```

Focused suites are also available as `npm run test:observability` and
`npm run test:cpu-monitor`.

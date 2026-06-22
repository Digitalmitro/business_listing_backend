"use strict";

const io = require("@pm2/io");

io.init({
  catchExceptions: false,
  metrics: {
    eventLoop: true,
    http: true,
    gc: true,
    v8: true,
    // @pm2/io's download instrumentation adds a new `data` listener every
    // time a socket is read, which triggers MaxListenersExceededWarning on
    // long-lived MongoDB TLS sockets. Keep it opt-in until that instrumentation
    // is safe to enable.
    network: process.env.PM2_NETWORK_METRICS === "true",
  },
  tracing: {
    enabled: process.env.PM2_TRANSACTION_TRACING === "true",
    samplingRate: Number(process.env.PM2_TRACE_SAMPLING_RATE || 10),
  },
});

const requestRate = io.meter({
  name: "HTTP requests/sec",
  id: "urban/http/request-rate",
});
const errorRate = io.meter({
  name: "HTTP errors/sec",
  id: "urban/http/error-rate",
});
const slowRequestRate = io.meter({
  name: "Slow HTTP requests/sec",
  id: "urban/http/slow-request-rate",
});
const activeRequests = io.counter({
  name: "Active HTTP requests",
  id: "urban/http/active-requests",
});
const requestLatency = io.metric({
  name: "HTTP response time p95",
  id: "urban/http/response-time",
  unit: "ms",
  type: "histogram",
  measurement: "p95",
});

function requestStarted() {
  requestRate.mark();
  activeRequests.inc();
}

function requestCompleted({ durationMs, statusCode, slow }) {
  activeRequests.dec();
  requestLatency.set(durationMs);
  if (statusCode >= 500) errorRate.mark();
  if (slow) slowRequestRate.mark();
}

function notifyError(event, error, context = {}) {
  if (process.env.PM2_NOTIFY_ERRORS === "false" || !(error instanceof Error)) return;
  try {
    io.notifyError(error, {
      custom: {
        event,
        requestId: context.requestId,
        errorId: context.errorId,
        statusCode: context.statusCode,
        service: process.env.SERVICE_NAME || "business-listing-backend",
      },
    });
  } catch (_) {
    // Remote telemetry must never interfere with application logging or control flow.
  }
}

module.exports = { notifyError, requestCompleted, requestStarted };

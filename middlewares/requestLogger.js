"use strict";

const { randomUUID } = require("node:crypto");
const logger = require("../utils/logger");
const pm2Telemetry = require("../utils/pm2Telemetry");
const { runWithRequestContext } = require("../utils/requestContext");

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function getRequestId(req) {
  const supplied = req.get("x-request-id");
  return supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID();
}

function getRouteName(req) {
  if (!req.route?.path) return undefined;
  return `${req.baseUrl || ""}${req.route.path}`;
}

function createRequestLogger({ slowRequestMs = Number(process.env.SLOW_REQUEST_MS || 2_000) } = {}) {
  if (!Number.isFinite(slowRequestMs) || slowRequestMs < 0) {
    throw new Error("SLOW_REQUEST_MS must be a non-negative number");
  }

  return function requestLogger(req, res, next) {
    const requestId = getRequestId(req);
    const startedAt = process.hrtime.bigint();
    let logged = false;

    req.requestId = requestId;
    req.log = logger;
    res.setHeader("X-Request-ID", requestId);
    pm2Telemetry.requestStarted();

    runWithRequestContext(
      {
        requestId,
        method: req.method,
        path: req.path,
      },
      () => {
        logger.debug("http.request_started", "HTTP request started", {
          ip: req.ip,
          userAgent: req.get("user-agent"),
          contentLength: req.get("content-length"),
        });

        const logCompletion = (aborted) => {
          if (logged) return;
          logged = true;
          const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
          const statusCode = res.statusCode;
          const details = {
            statusCode,
            durationMs: Number(durationMs.toFixed(2)),
            route: getRouteName(req),
            responseBytes: res.getHeader("content-length"),
            aborted,
          };
          pm2Telemetry.requestCompleted({
            durationMs,
            statusCode,
            slow: durationMs >= slowRequestMs,
          });

          if (aborted || statusCode >= 500) {
            logger.error("http.request_completed", "HTTP request failed", details);
          } else if (statusCode >= 400 || durationMs >= slowRequestMs) {
            logger.warn(
              durationMs >= slowRequestMs ? "http.slow_request" : "http.request_completed",
              durationMs >= slowRequestMs
                ? "HTTP request exceeded the response-time threshold"
                : "HTTP request completed with a client error",
              { ...details, ...(durationMs >= slowRequestMs ? { slowRequestMs } : {}) }
            );
          } else {
            logger.info("http.request_completed", "HTTP request completed", details);
          }
        };

        res.once("finish", () => logCompletion(false));
        res.once("close", () => {
          if (!res.writableFinished) logCompletion(true);
        });
        req.once("error", (error) => {
          logger.error("http.request_stream_error", "HTTP request stream failed", { error });
        });
        res.once("error", (error) => {
          logger.error("http.response_stream_error", "HTTP response stream failed", { error });
        });

        next();
      }
    );
  };
}

module.exports = { createRequestLogger, getRequestId };

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const { getRequestContext } = require("./requestContext");
const pm2Telemetry = require("./pm2Telemetry");
const { version } = require("../package.json");

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, fatal: 50 });
const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 8_000;
const SENSITIVE_KEYS = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|otp|cvv|signature)/i;

const service = process.env.SERVICE_NAME || "business-listing-backend";
const environment = process.env.NODE_ENV || "development";
const configuredLevel = (process.env.LOG_LEVEL || (environment === "production" ? "info" : "debug")).toLowerCase();
const minimumLevel = LEVELS[configuredLevel] || LEVELS.info;
const logFormat = (process.env.LOG_FORMAT || (environment === "production" ? "json" : "pretty")).toLowerCase();

let consoleBridgeInstalled = false;

function truncate(value) {
  if (typeof value !== "string" || value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH)}…[truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}

function serializeError(error, seen = new WeakSet()) {
  if (!(error instanceof Error)) return sanitize(error, 0, seen);
  if (seen.has(error)) return "[Circular Error]";
  seen.add(error);

  const result = {
    name: error.name,
    message: truncate(error.message),
    stack: truncate(error.stack),
  };

  for (const key of Object.keys(error)) {
    result[key] = SENSITIVE_KEYS.test(key) ? REDACTED : sanitize(error[key], 1, seen);
  }
  if (error.cause) result.cause = serializeError(error.cause, seen);
  return result;
}

function sanitize(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) return serializeError(value, seen);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value !== "object") return String(value);
  if (depth >= MAX_DEPTH) return "[Max depth reached]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitize(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return items;
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEYS.test(key) ? REDACTED : sanitize(item, depth + 1, seen);
  }
  return output;
}

function createEntry(level, event, message, details) {
  const context = getRequestContext();
  return {
    ...sanitize(details || {}),
    ...sanitize(context),
    timestamp: new Date().toISOString(),
    level,
    service,
    environment,
    event,
    message,
    pid: process.pid,
    hostname: os.hostname(),
    appVersion: version,
    ...(process.env.pm_id !== undefined ? { pm2Id: process.env.pm_id } : {}),
    ...(process.env.NODE_APP_INSTANCE !== undefined
      ? { instanceId: process.env.NODE_APP_INSTANCE }
      : {}),
  };
}

function formatPretty(entry) {
  const fixedKeys = new Set([
    "timestamp",
    "level",
    "service",
    "environment",
    "event",
    "message",
    "pid",
    "hostname",
    "appVersion",
  ]);
  const details = Object.fromEntries(
    Object.entries(entry).filter(([key, value]) => !fixedKeys.has(key) && value !== undefined)
  );
  const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : "";
  return `${entry.timestamp} ${entry.level.toUpperCase().padEnd(5)} ${entry.event} — ${entry.message}${suffix}\n`;
}

function safeWrite(level, line) {
  const descriptor = LEVELS[level] >= LEVELS.warn ? 2 : 1;
  try {
    if (level === "fatal") fs.writeSync(descriptor, line);
    else if (descriptor === 2) process.stderr.write(line);
    else process.stdout.write(line);
  } catch (error) {
    try {
      fs.writeSync(2, `${new Date().toISOString()} ERROR logger.write_failed — ${error.message}\n`);
    } catch (_) {
      // There is no safe output left. Avoid recursive logger failures.
    }
  }
}

function log(level, event, message, details) {
  if (LEVELS[level] < minimumLevel) return;
  const entry = createEntry(level, event, message, details);
  const line = logFormat === "pretty" ? formatPretty(entry) : `${JSON.stringify(entry)}\n`;
  safeWrite(level, line);
  if (LEVELS[level] >= LEVELS.error) {
    pm2Telemetry.notifyError(event, details?.error, entry);
  }
}

const logger = {
  debug: (event, message, details) => log("debug", event, message, details),
  info: (event, message, details) => log("info", event, message, details),
  warn: (event, message, details) => log("warn", event, message, details),
  error: (event, message, details) => log("error", event, message, details),
  fatal: (event, message, details) => log("fatal", event, message, details),
};

function splitConsoleArguments(args) {
  const messageParts = [];
  const values = [];
  let error;

  for (const argument of args) {
    if (argument instanceof Error && !error) error = argument;
    else if (["string", "number", "boolean", "bigint"].includes(typeof argument)) {
      messageParts.push(String(argument));
    } else {
      values.push(argument);
    }
  }

  return {
    message: truncate(messageParts.join(" ") || "Legacy console event"),
    details: {
      ...(error ? { error } : {}),
      ...(values.length ? { values } : {}),
    },
  };
}

function installConsoleBridge() {
  if (consoleBridgeInstalled) return;
  consoleBridgeInstalled = true;

  console.log = (...args) => {
    const event = splitConsoleArguments(args);
    logger.debug("legacy.console", event.message, event.details);
  };
  console.info = (...args) => {
    const event = splitConsoleArguments(args);
    logger.debug("legacy.console", event.message, event.details);
  };
  console.debug = (...args) => {
    const event = splitConsoleArguments(args);
    logger.debug("legacy.console", event.message, event.details);
  };
  console.warn = (...args) => {
    const event = splitConsoleArguments(args);
    logger.warn("legacy.console", event.message, event.details);
  };
  console.error = (...args) => {
    const event = splitConsoleArguments(args);
    logger.error("legacy.console", event.message, event.details);
  };
}

module.exports = Object.assign(logger, {
  createEntry,
  installConsoleBridge,
  sanitize,
  serializeError,
});

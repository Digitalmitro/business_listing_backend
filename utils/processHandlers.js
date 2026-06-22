"use strict";

function booleanFromEnv(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  return process.env[name].toLowerCase() === "true";
}

function installProcessHandlers({ logger, shutdown }) {
  const exitOnUnhandledRejection = booleanFromEnv("EXIT_ON_UNHANDLED_REJECTION", true);
  const crashShutdownTimeoutMs = Number(process.env.CRASH_SHUTDOWN_TIMEOUT_MS || 15_000);
  let terminating = false;

  async function terminate(reason, exitCode, error) {
    if (terminating) {
      logger.warn("process.termination_duplicate", "Ignoring duplicate termination event", {
        reason,
        exitCode,
      });
      return;
    }
    terminating = true;

    const crash = exitCode !== 0;
    const method = crash ? "fatal" : "info";
    logger[method](
      crash ? "process.crash" : "process.signal",
      crash ? "Process is terminating after a fatal error" : "Process received a shutdown signal",
      { reason, exitCode, ...(error ? { error } : {}) }
    );

    const forceExitTimer = setTimeout(() => {
      logger.fatal("process.forced_exit", "Graceful shutdown exceeded its deadline", {
        reason,
        timeoutMs: crashShutdownTimeoutMs,
      });
      process.exit(exitCode || 1);
    }, crashShutdownTimeoutMs);

    try {
      await shutdown(reason, { crash, error });
      clearTimeout(forceExitTimer);
      process.exit(exitCode);
    } catch (shutdownError) {
      clearTimeout(forceExitTimer);
      logger.fatal("process.shutdown_failed", "Graceful shutdown failed", {
        reason,
        error: shutdownError,
      });
      process.exit(exitCode || 1);
    }
  }

  const onUncaughtException = (error, origin) => {
    void terminate(`uncaughtException:${origin}`, 1, error);
  };
  const onUnhandledRejection = (reason, promise) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error("process.unhandled_rejection", "Unhandled promise rejection detected", {
      error,
      promise: String(promise),
      exitOnUnhandledRejection,
    });
    if (exitOnUnhandledRejection) void terminate("unhandledRejection", 1, error);
  };
  const onWarning = (warning) => {
    logger.warn("process.warning", "Node.js process warning", { warning });
  };
  const onSigterm = () => void terminate("SIGTERM", 0);
  const onSigint = () => void terminate("SIGINT", 0);

  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("warning", onWarning);
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);

  return function removeProcessHandlers() {
    process.off("uncaughtException", onUncaughtException);
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("warning", onWarning);
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
  };
}

module.exports = { installProcessHandlers };

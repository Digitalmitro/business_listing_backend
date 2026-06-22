#!/usr/bin/env node

"use strict";

require("dotenv").config();

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const logger = require("../utils/logger");
const { installProcessHandlers } = require("../utils/processHandlers");

const DEFAULTS = Object.freeze({
  intervalMs: 60_000,
  trackingThreshold: 60,
  warningThreshold: 70,
  restartThreshold: 75,
  sustainedWarningMs: 5 * 60_000,
  restartCooldownMs: 15 * 60_000,
  pm2TimeoutMs: 30_000,
  pm2Command: "pm2",
  stateFile: path.join(os.tmpdir(), "business-listing-cpu-monitor-state.json"),
});

function readNumber(env, name, fallback, { min = 0, max = Infinity } = {}) {
  const rawValue = env[name];
  const value = rawValue === undefined || rawValue === "" ? fallback : Number(rawValue);

  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }

  return value;
}

function readString(env, name, fallback) {
  const value = env[name] === undefined ? fallback : env[name].trim();
  if (!value) {
    throw new Error(`${name} cannot be empty`);
  }
  return value;
}

function loadConfig(env = process.env) {
  const config = {
    intervalMs: readNumber(env, "CPU_MONITOR_INTERVAL_MS", DEFAULTS.intervalMs, {
      min: 1_000,
    }),
    trackingThreshold: readNumber(
      env,
      "CPU_TRACKING_THRESHOLD",
      DEFAULTS.trackingThreshold,
      { max: 100 }
    ),
    warningThreshold: readNumber(
      env,
      "CPU_WARNING_THRESHOLD",
      DEFAULTS.warningThreshold,
      { max: 100 }
    ),
    restartThreshold: readNumber(
      env,
      "CPU_RESTART_THRESHOLD",
      DEFAULTS.restartThreshold,
      { max: 100 }
    ),
    sustainedWarningMs: readNumber(
      env,
      "CPU_SUSTAINED_WARNING_MS",
      DEFAULTS.sustainedWarningMs
    ),
    restartCooldownMs: readNumber(
      env,
      "CPU_RESTART_COOLDOWN_MS",
      DEFAULTS.restartCooldownMs,
      { min: 1_000 }
    ),
    pm2TimeoutMs: readNumber(env, "PM2_RESTART_TIMEOUT_MS", DEFAULTS.pm2TimeoutMs, {
      min: 1_000,
    }),
    pm2Command: readString(env, "PM2_COMMAND", DEFAULTS.pm2Command),
    stateFile: path.resolve(readString(env, "CPU_MONITOR_STATE_FILE", DEFAULTS.stateFile)),
  };

  if (
    !(
      config.trackingThreshold <= config.warningThreshold &&
      config.warningThreshold <= config.restartThreshold
    )
  ) {
    throw new Error(
      "CPU thresholds must satisfy CPU_TRACKING_THRESHOLD <= CPU_WARNING_THRESHOLD <= CPU_RESTART_THRESHOLD"
    );
  }

  if (config.restartCooldownMs < config.intervalMs) {
    throw new Error("CPU_RESTART_COOLDOWN_MS must be at least CPU_MONITOR_INTERVAL_MS");
  }

  return Object.freeze(config);
}

function getCpuSnapshot(cpus = os.cpus()) {
  return cpus.reduce(
    (snapshot, cpu) => {
      const times = Object.values(cpu.times);
      snapshot.idle += cpu.times.idle;
      snapshot.total += times.reduce((total, time) => total + time, 0);
      return snapshot;
    },
    { idle: 0, total: 0 }
  );
}

function calculateCpuUsage(previous, current) {
  const idleDelta = current.idle - previous.idle;
  const totalDelta = current.total - previous.total;

  if (idleDelta < 0 || totalDelta <= 0 || idleDelta > totalDelta) {
    throw new Error("Invalid CPU time delta received from the operating system");
  }

  return Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100));
}

function readRestartState(stateFile, logger) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (!Number.isFinite(state.lastRestartAttemptAt) || state.lastRestartAttemptAt < 0) {
      throw new Error("lastRestartAttemptAt is missing or invalid");
    }
    return { lastRestartAttemptAt: state.lastRestartAttemptAt };
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn("state.read_failed", "Could not read the restart cooldown state", {
        stateFile,
        error: error.message,
      });
    }
    return { lastRestartAttemptAt: 0 };
  }
}

function writeRestartState(stateFile, state) {
  const directory = path.dirname(stateFile);
  const temporaryFile = `${stateFile}.${process.pid}.tmp`;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(temporaryFile, `${JSON.stringify(state)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporaryFile, stateFile);
}

function restartPm2Processes(config) {
  return new Promise((resolve, reject) => {
    execFile(
      config.pm2Command,
      ["restart", "all"],
      {
        timeout: config.pm2TimeoutMs,
        killSignal: "SIGTERM",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function conciseOutput(value) {
  return value ? value.trim().slice(0, 2_000) : undefined;
}

class CpuMonitor {
  constructor({
    config,
    logger: monitorLogger = logger,
    cpuSnapshot = getCpuSnapshot,
    restartProcesses = restartPm2Processes,
    now = Date.now,
  }) {
    this.config = config;
    this.logger = monitorLogger;
    this.cpuSnapshot = cpuSnapshot;
    this.restartProcesses = restartProcesses;
    this.now = now;

    this.previousSnapshot = null;
    this.timer = null;
    this.trackingSince = null;
    this.warningSince = null;
    this.sustainedWarningLogged = false;
    this.restartInProgress = false;
    this.lastRestartAttemptAt = readRestartState(config.stateFile, monitorLogger).lastRestartAttemptAt;
  }

  start() {
    if (this.timer) return;

    this.previousSnapshot = this.cpuSnapshot();
    this.logger.info("monitor.started", "CPU monitor started", {
      intervalMs: this.config.intervalMs,
      trackingThreshold: this.config.trackingThreshold,
      warningThreshold: this.config.warningThreshold,
      sustainedWarningMs: this.config.sustainedWarningMs,
      restartThreshold: this.config.restartThreshold,
      restartCooldownMs: this.config.restartCooldownMs,
      stateFile: this.config.stateFile,
    });

    this.timer = setInterval(() => {
      this.check().catch((error) => {
        this.logger.error("monitor.check_failed", "CPU monitoring check failed", {
          error: error.message,
          stack: error.stack,
        });
      });
    }, this.config.intervalMs);
  }

  stop(reason = "requested") {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info("monitor.stopped", "CPU monitor stopped", { reason });
  }

  async check() {
    const currentSnapshot = this.cpuSnapshot();
    const cpuUsage = calculateCpuUsage(this.previousSnapshot, currentSnapshot);
    this.previousSnapshot = currentSnapshot;
    const checkedAt = this.now();

    this.updateThresholdTracking(cpuUsage, checkedAt);

    this.logger.info("cpu.sample", "CPU usage sampled", {
      cpuUsagePercent: Number(cpuUsage.toFixed(2)),
      elevatedForMs: this.trackingSince === null ? 0 : checkedAt - this.trackingSince,
      warningLevelForMs: this.warningSince === null ? 0 : checkedAt - this.warningSince,
    });

    if (cpuUsage >= this.config.restartThreshold) {
      await this.attemptRestart(cpuUsage, checkedAt);
    }
  }

  updateThresholdTracking(cpuUsage, checkedAt) {
    if (cpuUsage >= this.config.trackingThreshold) {
      if (this.trackingSince === null) {
        this.trackingSince = checkedAt;
        this.logger.warn("cpu.elevated", "CPU usage entered the elevated range", {
          cpuUsagePercent: Number(cpuUsage.toFixed(2)),
          thresholdPercent: this.config.trackingThreshold,
        });
      }
    } else if (this.trackingSince !== null) {
      this.logger.info("cpu.recovered", "CPU usage returned below the tracking threshold", {
        cpuUsagePercent: Number(cpuUsage.toFixed(2)),
        elevatedForMs: checkedAt - this.trackingSince,
      });
      this.trackingSince = null;
    }

    if (cpuUsage >= this.config.warningThreshold) {
      if (this.warningSince === null) {
        this.warningSince = checkedAt;
        this.sustainedWarningLogged = false;
        this.logger.warn("cpu.warning_level", "CPU usage entered the warning range", {
          cpuUsagePercent: Number(cpuUsage.toFixed(2)),
          thresholdPercent: this.config.warningThreshold,
        });
      }

      const warningDuration = checkedAt - this.warningSince;
      if (
        !this.sustainedWarningLogged &&
        warningDuration >= this.config.sustainedWarningMs
      ) {
        this.sustainedWarningLogged = true;
        this.logger.warn("cpu.sustained_high", "CPU usage has remained at warning level", {
          cpuUsagePercent: Number(cpuUsage.toFixed(2)),
          thresholdPercent: this.config.warningThreshold,
          sustainedForMs: warningDuration,
        });
      }
    } else if (this.warningSince !== null) {
      this.logger.info("cpu.warning_recovered", "CPU usage left the warning range", {
        cpuUsagePercent: Number(cpuUsage.toFixed(2)),
        warningLevelForMs: checkedAt - this.warningSince,
      });
      this.warningSince = null;
      this.sustainedWarningLogged = false;
    }
  }

  async attemptRestart(cpuUsage, attemptedAt) {
    if (this.restartInProgress) {
      this.logger.warn("pm2.restart_suppressed", "A PM2 restart is already in progress", {
        cpuUsagePercent: Number(cpuUsage.toFixed(2)),
      });
      return;
    }

    const elapsedSinceAttempt = attemptedAt - this.lastRestartAttemptAt;
    if (this.lastRestartAttemptAt && elapsedSinceAttempt < this.config.restartCooldownMs) {
      this.logger.warn("pm2.restart_suppressed", "PM2 restart suppressed by cooldown", {
        cpuUsagePercent: Number(cpuUsage.toFixed(2)),
        cooldownRemainingMs: this.config.restartCooldownMs - Math.max(0, elapsedSinceAttempt),
      });
      return;
    }

    // Persist before invoking PM2 because `restart all` can restart this monitor too.
    try {
      writeRestartState(this.config.stateFile, { lastRestartAttemptAt: attemptedAt });
    } catch (error) {
      this.logger.error(
        "pm2.restart_blocked",
        "PM2 restart was blocked because the cooldown state could not be persisted",
        { stateFile: this.config.stateFile, error: error.message }
      );
      return;
    }

    this.lastRestartAttemptAt = attemptedAt;
    this.restartInProgress = true;
    this.logger.warn("pm2.restart_started", "Restarting all PM2 processes due to high CPU", {
      cpuUsagePercent: Number(cpuUsage.toFixed(2)),
      thresholdPercent: this.config.restartThreshold,
      command: `${this.config.pm2Command} restart all`,
    });

    try {
      const result = await this.restartProcesses(this.config);
      this.logger.info("pm2.restart_succeeded", "All PM2 processes restarted successfully", {
        stdout: conciseOutput(result.stdout),
        stderr: conciseOutput(result.stderr),
      });
    } catch (error) {
      this.logger.error("pm2.restart_failed", "Failed to restart all PM2 processes", {
        error: error.message,
        code: error.code,
        signal: error.signal,
        stdout: conciseOutput(error.stdout),
        stderr: conciseOutput(error.stderr),
      });
    } finally {
      this.restartInProgress = false;
    }
  }
}

function main() {
  let monitor;

  try {
    monitor = new CpuMonitor({ config: loadConfig() });
    monitor.start();
  } catch (error) {
    logger.fatal("monitor.start_failed", "CPU monitor could not start", {
      error: error.message,
      stack: error.stack,
    });
    process.exitCode = 1;
    return;
  }

  installProcessHandlers({
    logger,
    shutdown: async (reason) => monitor.stop(reason),
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULTS,
  CpuMonitor,
  calculateCpuUsage,
  getCpuSnapshot,
  loadConfig,
  readRestartState,
  writeRestartState,
};

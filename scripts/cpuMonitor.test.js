"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { CpuMonitor, calculateCpuUsage, loadConfig } = require("./cpuMonitor");

function recordingLogger() {
  const entries = [];
  return {
    entries,
    info: (event, message, details) => entries.push({ level: "info", event, message, details }),
    warn: (event, message, details) => entries.push({ level: "warn", event, message, details }),
    error: (event, message, details) => entries.push({ level: "error", event, message, details }),
  };
}

test("calculateCpuUsage calculates average CPU use from time deltas", () => {
  const previous = { idle: 1_000, total: 2_000 };
  const current = { idle: 1_250, total: 3_000 };

  assert.equal(calculateCpuUsage(previous, current), 75);
});

test("calculateCpuUsage rejects invalid operating-system counters", () => {
  assert.throws(
    () => calculateCpuUsage({ idle: 10, total: 20 }, { idle: 10, total: 20 }),
    /Invalid CPU time delta/
  );
});

test("loadConfig validates threshold order", () => {
  assert.throws(
    () =>
      loadConfig({
        CPU_TRACKING_THRESHOLD: "80",
        CPU_WARNING_THRESHOLD: "70",
        CPU_RESTART_THRESHOLD: "75",
      }),
    /CPU thresholds must satisfy/
  );
});

test("loadConfig accepts configurable thresholds and durations", () => {
  const config = loadConfig({
    CPU_MONITOR_INTERVAL_MS: "10000",
    CPU_TRACKING_THRESHOLD: "55",
    CPU_WARNING_THRESHOLD: "65",
    CPU_RESTART_THRESHOLD: "80",
    CPU_SUSTAINED_WARNING_MS: "120000",
    CPU_RESTART_COOLDOWN_MS: "600000",
  });

  assert.equal(config.intervalMs, 10_000);
  assert.equal(config.trackingThreshold, 55);
  assert.equal(config.warningThreshold, 65);
  assert.equal(config.restartThreshold, 80);
  assert.equal(config.sustainedWarningMs, 120_000);
  assert.equal(config.restartCooldownMs, 600_000);
});

test("CpuMonitor logs a sustained warning only after the configured duration", () => {
  const logger = recordingLogger();
  const monitor = new CpuMonitor({
    config: loadConfig({
      CPU_MONITOR_INTERVAL_MS: "1000",
      CPU_SUSTAINED_WARNING_MS: "2000",
      CPU_RESTART_COOLDOWN_MS: "5000",
      CPU_MONITOR_STATE_FILE: path.join(
        os.tmpdir(),
        `missing-cpu-monitor-state-${process.pid}.json`
      ),
    }),
    logger,
  });

  monitor.updateThresholdTracking(72, 1_000);
  monitor.updateThresholdTracking(73, 2_999);
  assert.equal(logger.entries.filter((entry) => entry.event === "cpu.sustained_high").length, 0);

  monitor.updateThresholdTracking(71, 3_000);
  monitor.updateThresholdTracking(74, 4_000);
  assert.equal(logger.entries.filter((entry) => entry.event === "cpu.sustained_high").length, 1);
});

test("restart cooldown persists when the monitor is recreated", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cpu-monitor-test-"));
  const stateFile = path.join(directory, "state.json");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const config = loadConfig({
    CPU_MONITOR_INTERVAL_MS: "1000",
    CPU_RESTART_COOLDOWN_MS: "5000",
    CPU_MONITOR_STATE_FILE: stateFile,
  });
  let restartCount = 0;
  const restartProcesses = async () => {
    restartCount += 1;
    return { stdout: "restarted", stderr: "" };
  };

  const firstMonitor = new CpuMonitor({
    config,
    logger: recordingLogger(),
    restartProcesses,
  });
  await firstMonitor.attemptRestart(80, 1_000);

  const recreatedMonitor = new CpuMonitor({
    config,
    logger: recordingLogger(),
    restartProcesses,
  });
  await recreatedMonitor.attemptRestart(80, 5_999);
  assert.equal(restartCount, 1);

  await recreatedMonitor.attemptRestart(80, 6_000);
  assert.equal(restartCount, 2);
});

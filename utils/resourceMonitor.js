"use strict";

const os = require("node:os");
const { monitorEventLoopDelay } = require("node:perf_hooks");

function readPositiveNumber(env, name, fallback, minimum = 0) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a number greater than or equal to ${minimum}`);
  }
  return value;
}

function bytesToMegabytes(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

function buildResourceSample({ memory, cpuDelta, elapsedMs, eventLoop, coreCount }) {
  const cpuCorePercent = ((cpuDelta.user + cpuDelta.system) / 1_000 / elapsedMs) * 100;
  const systemMemoryUsed = os.totalmem() - os.freemem();

  return {
    processCpuPercent: Number(cpuCorePercent.toFixed(2)),
    normalizedProcessCpuPercent: Number((cpuCorePercent / coreCount).toFixed(2)),
    cpuUserMs: Number((cpuDelta.user / 1_000).toFixed(2)),
    cpuSystemMs: Number((cpuDelta.system / 1_000).toFixed(2)),
    rssMb: bytesToMegabytes(memory.rss),
    heapUsedMb: bytesToMegabytes(memory.heapUsed),
    heapTotalMb: bytesToMegabytes(memory.heapTotal),
    heapUsedPercent: Number(((memory.heapUsed / memory.heapTotal) * 100).toFixed(2)),
    externalMb: bytesToMegabytes(memory.external),
    arrayBuffersMb: bytesToMegabytes(memory.arrayBuffers || 0),
    systemMemoryUsedPercent: Number(((systemMemoryUsed / os.totalmem()) * 100).toFixed(2)),
    eventLoopDelayMeanMs: Number((eventLoop.mean / 1e6).toFixed(2)),
    eventLoopDelayP95Ms: Number((eventLoop.percentile(95) / 1e6).toFixed(2)),
    eventLoopDelayMaxMs: Number((eventLoop.max / 1e6).toFixed(2)),
    uptimeSeconds: Number(process.uptime().toFixed(1)),
  };
}

class ResourceMonitor {
  constructor({ logger, env = process.env }) {
    this.logger = logger;
    this.intervalMs = readPositiveNumber(env, "RESOURCE_LOG_INTERVAL_MS", 60_000, 5_000);
    this.memoryWarningMb = readPositiveNumber(env, "MEMORY_WARNING_MB", 768, 1);
    this.heapWarningPercent = readPositiveNumber(env, "HEAP_WARNING_PERCENT", 85, 1);
    this.eventLoopWarningMs = readPositiveNumber(env, "EVENT_LOOP_WARNING_MS", 1000, 1);
    this.coreCount = Math.max(1, os.cpus().length);
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.previousCpu = process.cpuUsage();
    this.previousTime = process.hrtime.bigint();
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.histogram.enable();
    this.previousCpu = process.cpuUsage();
    this.previousTime = process.hrtime.bigint();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref();
    this.logger.info("resources.monitor_started", "Process resource monitoring started", {
      intervalMs: this.intervalMs,
      memoryWarningMb: this.memoryWarningMb,
      heapWarningPercent: this.heapWarningPercent,
      eventLoopWarningMs: this.eventLoopWarningMs,
    });
  }

  sample() {
    const now = process.hrtime.bigint();
    const elapsedMs = Number(now - this.previousTime) / 1e6;
    const cpuDelta = process.cpuUsage(this.previousCpu);
    const sample = buildResourceSample({
      memory: process.memoryUsage(),
      cpuDelta,
      elapsedMs,
      eventLoop: this.histogram,
      coreCount: this.coreCount,
    });
    this.previousCpu = process.cpuUsage();
    this.previousTime = now;
    this.histogram.reset();

    const warnings = [];
    if (sample.rssMb >= this.memoryWarningMb) warnings.push("rss_memory");
    if (sample.heapUsedPercent >= this.heapWarningPercent) warnings.push("heap_pressure");
    if (sample.eventLoopDelayP95Ms >= this.eventLoopWarningMs) warnings.push("event_loop_delay");

    const level = warnings.length ? "warn" : "info";
    this.logger[level](
      warnings.length ? "resources.warning" : "resources.sample",
      warnings.length ? "Process resource threshold exceeded" : "Process resources sampled",
      { ...sample, warnings }
    );
    return sample;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.histogram.disable();
    this.logger.info("resources.monitor_stopped", "Process resource monitoring stopped");
  }
}

module.exports = { ResourceMonitor, buildResourceSample, bytesToMegabytes };

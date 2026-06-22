"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildResourceSample } = require("./resourceMonitor");

test("buildResourceSample converts process and event-loop metrics", () => {
  const sample = buildResourceSample({
    memory: {
      rss: 256 * 1024 * 1024,
      heapUsed: 50 * 1024 * 1024,
      heapTotal: 100 * 1024 * 1024,
      external: 5 * 1024 * 1024,
      arrayBuffers: 2 * 1024 * 1024,
    },
    cpuDelta: { user: 400_000, system: 100_000 },
    elapsedMs: 1_000,
    eventLoop: {
      mean: 10_000_000,
      max: 40_000_000,
      percentile: () => 25_000_000,
    },
    coreCount: 2,
  });

  assert.equal(sample.processCpuPercent, 50);
  assert.equal(sample.normalizedProcessCpuPercent, 25);
  assert.equal(sample.rssMb, 256);
  assert.equal(sample.heapUsedPercent, 50);
  assert.equal(sample.eventLoopDelayMeanMs, 10);
  assert.equal(sample.eventLoopDelayP95Ms, 25);
  assert.equal(sample.eventLoopDelayMaxMs, 40);
});

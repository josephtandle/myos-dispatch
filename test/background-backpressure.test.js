"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { detectHostBackpressure } = require("../src/background/background-agent-runner");

test("24-core hosts allow load through 18 and report the measured load and limit", () => {
  for (const loadAverage of [12.1, 18]) {
    assert.equal(detectHostBackpressure({ env: {}, cpuCount: 24, loadAverage }), null);
  }
  assert.deepEqual(detectHostBackpressure({ env: {}, cpuCount: 24, loadAverage: 18.1 }), {
    reason: "host_backpressure",
    detail: "1m load average 18.1 exceeds 18",
  });
});

test("8-core hosts use the floor of 8", () => {
  assert.equal(detectHostBackpressure({ env: {}, cpuCount: 8, loadAverage: 8 }), null);
  assert.equal(detectHostBackpressure({ env: {}, cpuCount: 8, loadAverage: 8.1 }).detail,
    "1m load average 8.1 exceeds 8");
});

test("integer environment override wins over the CPU limit", () => {
  const env = { MYOS_BACKGROUND_LOAD_LIMIT: "25" };
  assert.equal(detectHostBackpressure({ env, cpuCount: 24, loadAverage: 25 }), null);
  assert.equal(detectHostBackpressure({ env, cpuCount: 24, loadAverage: 25.1 }).detail,
    "1m load average 25.1 exceeds 25");
  assert.equal(detectHostBackpressure({ env: { MYOS_BACKGROUND_LOAD_LIMIT: "2" }, cpuCount: 24, loadAverage: 3 }).detail,
    "1m load average 3.0 exceeds 2");
});

test("invalid overrides fall back to the computed limit", () => {
  for (const value of ["", "invalid", "18.5", "0", "-1"]) {
    assert.equal(detectHostBackpressure({ env: { MYOS_BACKGROUND_LOAD_LIMIT: value }, cpuCount: 24, loadAverage: 18.1 }).detail,
      "1m load average 18.1 exceeds 18");
  }
});

test("disabled backpressure bypasses even an exceeded override", () => {
  assert.equal(detectHostBackpressure({
    env: { MYOS_BACKGROUND_BACKPRESSURE_ENABLED: "0", MYOS_BACKGROUND_LOAD_LIMIT: "1" },
    cpuCount: 8,
    loadAverage: 100,
  }), null);
});

test("legacy MYOS_BACKGROUND_MAX_LOAD still overrides the limit", () => {
  const result = detectHostBackpressure({ env: { MYOS_BACKGROUND_MAX_LOAD: "2" }, cpuCount: 24, loadAverage: 3 });
  assert.ok(result && /exceeds 2\b/.test(result.detail), result && result.detail);
});

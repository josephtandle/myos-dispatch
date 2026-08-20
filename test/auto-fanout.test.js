"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { handleHookPayload } = require("../bin/myos-dispatch-hook");

function createTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "myos-test-home-"));
}

function cleanupTmpHome(tmpHome) {
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {}
}

function createFixtureScript(tmpHome) {
  const fixturePath = path.join(tmpHome, "fixture-sidecar.js");
  const code = `
    const fs = require("node:fs");
    const argv = process.argv.slice(2);
    let out = "";
    let id = "lane";
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--out") out = argv[++i];
      else if (argv[i] === "--id") id = argv[++i];
    }
    if (out) {
      fs.mkdirSync(require("path").dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({
        status: "completed",
        summary: "Fixture result summary for " + id,
        findings: [{ file: "foo.js", note: "done" }],
        confidence: "high"
      }, null, 2));
    }
  `;
  fs.writeFileSync(fixturePath, code, "utf8");
  return fixturePath;
}

function setupTestEnv(tmpHome, fixtureBin) {
  const saved = {
    MYOS_HOME_ROOT: process.env.MYOS_HOME_ROOT,
    MYOS_SIDECAR_BIN: process.env.MYOS_SIDECAR_BIN,
    MYOS_AUTO_FANOUT: process.env.MYOS_AUTO_FANOUT,
    MYOS_BACKGROUND_AGENTS_ENABLED: process.env.MYOS_BACKGROUND_AGENTS_ENABLED,
    MYOS_BACKGROUND_IS_SIDECAR: process.env.MYOS_BACKGROUND_IS_SIDECAR,
    MYOS_SIDECAR_ORCHESTRATED: process.env.MYOS_SIDECAR_ORCHESTRATED,
  };

  process.env.MYOS_HOME_ROOT = tmpHome;
  if (fixtureBin) process.env.MYOS_SIDECAR_BIN = fixtureBin;
  delete process.env.MYOS_BACKGROUND_IS_SIDECAR;
  delete process.env.MYOS_SIDECAR_ORCHESTRATED;

  return () => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

test("auto-fanout suite", { concurrency: 1 }, async (t) => {
  await t.test("goal 4 route with read-only lanes: spawns up to 3, hook exits fast, manifest records them", () => {
    const tmpHome = createTmpHome();
    const fixtureBin = createFixtureScript(tmpHome);
    const sessionId = "session-g4-" + Date.now();
    const restoreEnv = setupTestEnv(tmpHome, fixtureBin);

    try {
      process.env.MYOS_AUTO_FANOUT = "1";
      process.env.MYOS_BACKGROUND_AGENTS_ENABLED = "1";

      const prompt = "Implement the new report pipeline across all services, verify end-to-end, and update docs";
      const start = Date.now();
      const output = handleHookPayload({
        hook_event_name: "UserPromptSubmit",
        session_id: sessionId,
        cwd: process.cwd(),
        prompt,
      }, "claude", { contextMode: "full" });
      const duration = Date.now() - start;

      assert.ok(duration < 2000, `Hook should exit fast, took ${duration}ms`);
      const context = output?.hookSpecificOutput?.additionalContext || "";
      assert.match(context, /ALREADY RUNNING in the background/);

      const manifestPath = path.join(tmpHome, "state", "sidecar-results", sessionId, "manifest.json");
      assert.ok(fs.existsSync(manifestPath), "Manifest should be created");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      assert.ok(Array.isArray(manifest.dispatched));
      assert.ok(manifest.dispatched.length > 0 && manifest.dispatched.length <= 3, `Expected 1-3 dispatched, got ${manifest.dispatched.length}`);
    } finally {
      restoreEnv();
      cleanupTmpHome(tmpHome);
    }
  });

  await t.test("goal 2 route: spawns nothing (clamped plans stay clamped)", () => {
    const tmpHome = createTmpHome();
    const fixtureBin = createFixtureScript(tmpHome);
    const sessionId = "session-g2-" + Date.now();
    const restoreEnv = setupTestEnv(tmpHome, fixtureBin);

    try {
      process.env.MYOS_AUTO_FANOUT = "1";
      process.env.MYOS_BACKGROUND_AGENTS_ENABLED = "1";

      const output = handleHookPayload({
        hook_event_name: "UserPromptSubmit",
        session_id: sessionId,
        cwd: process.cwd(),
        prompt: "explain how the routing logic works",
      }, "claude", { contextMode: "full" });

      const context = output?.hookSpecificOutput?.additionalContext || "";
      assert.doesNotMatch(context, /ALREADY RUNNING in the background/);

      const manifestPath = path.join(tmpHome, "state", "sidecar-results", sessionId, "manifest.json");
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        assert.equal(manifest.dispatched.length, 0);
      }
    } finally {
      restoreEnv();
      cleanupTmpHome(tmpHome);
    }
  });

  await t.test("MYOS_AUTO_FANOUT=0 and MYOS_BACKGROUND_AGENTS_ENABLED=0: nothing spawns, text falls back to advice", () => {
    const tmpHome = createTmpHome();
    const fixtureBin = createFixtureScript(tmpHome);
    const sessionId = "session-optout-" + Date.now();
    const restoreEnv = setupTestEnv(tmpHome, fixtureBin);

    try {
      // Test MYOS_AUTO_FANOUT=0
      process.env.MYOS_AUTO_FANOUT = "0";
      process.env.MYOS_BACKGROUND_AGENTS_ENABLED = "1";
      const prompt = "Implement the new report pipeline across all services, verify end-to-end, and update docs";

      let output = handleHookPayload({
        hook_event_name: "UserPromptSubmit",
        session_id: sessionId,
        cwd: process.cwd(),
        prompt,
      }, "claude", { contextMode: "full" });

      let context = output?.hookSpecificOutput?.additionalContext || "";
      assert.doesNotMatch(context, /ALREADY RUNNING in the background/);

      // Test MYOS_BACKGROUND_AGENTS_ENABLED=0
      process.env.MYOS_AUTO_FANOUT = "1";
      process.env.MYOS_BACKGROUND_AGENTS_ENABLED = "0";

      output = handleHookPayload({
        hook_event_name: "UserPromptSubmit",
        session_id: sessionId + "-bg",
        cwd: process.cwd(),
        prompt,
      }, "claude", { contextMode: "full" });

      context = output?.hookSpecificOutput?.additionalContext || "";
      assert.doesNotMatch(context, /ALREADY RUNNING in the background/);
      assert.match(context, /Background fan-out is disabled on this machine/);
    } finally {
      restoreEnv();
      cleanupTmpHome(tmpHome);
    }
  });

  await t.test("result file present on next prompt: injected into additionalContext once, never twice", () => {
    const tmpHome = createTmpHome();
    const sessionId = "session-results-inject-" + Date.now();
    const restoreEnv = setupTestEnv(tmpHome);

    try {
      const resDir = path.join(tmpHome, "state", "sidecar-results", sessionId);
      fs.mkdirSync(resDir, { recursive: true });

      const resultFile = path.join(resDir, "context-1.json");
      fs.writeFileSync(resultFile, JSON.stringify({
        status: "completed",
        summary: "Context mapping complete for feature",
        findings: [],
        confidence: "high"
      }), "utf8");

      // First prompt: result file should be injected
      const out1 = handleHookPayload({
        hook_event_name: "UserPromptSubmit",
        session_id: sessionId,
        cwd: process.cwd(),
        prompt: "Next turn user prompt",
      }, "claude", { contextMode: "full" });

      const context1 = out1?.hookSpecificOutput?.additionalContext || "";
      assert.match(context1, /Sidecar results ready \(1\):/);
      assert.match(context1, /context-1: Context mapping complete for feature/);

      // Second prompt: should NOT inject again
      const out2 = handleHookPayload({
        hook_event_name: "UserPromptSubmit",
        session_id: sessionId,
        cwd: process.cwd(),
        prompt: "Another prompt after result delivered",
      }, "claude", { contextMode: "full" });

      const context2 = out2?.hookSpecificOutput?.additionalContext || "";
      assert.doesNotMatch(context2, /Sidecar results ready/);
    } finally {
      restoreEnv();
      cleanupTmpHome(tmpHome);
    }
  });

  await t.test("missing worker CLI: silent skip, route text falls back to the advice form", () => {
    const tmpHome = createTmpHome();
    const sessionId = "session-no-cli-" + Date.now();
    const restoreEnv = setupTestEnv(tmpHome);
    const origWorker = process.env.MYOS_BACKGROUND_PROVIDER;
    const origPath = process.env.PATH;

    try {
      delete process.env.MYOS_SIDECAR_BIN;
      process.env.MYOS_BACKGROUND_PROVIDER = "non_existent_worker_cli_12345";
      process.env.MYOS_AUTO_FANOUT = "1";
      process.env.MYOS_BACKGROUND_AGENTS_ENABLED = "1";

      const prompt = "Implement the new report pipeline across all services, verify end-to-end, and update docs";
      const output = handleHookPayload({
        hook_event_name: "UserPromptSubmit",
        session_id: sessionId,
        cwd: process.cwd(),
        prompt,
      }, "claude", { contextMode: "full" });

      const context = output?.hookSpecificOutput?.additionalContext || "";
      assert.doesNotMatch(context, /ALREADY RUNNING in the background/);
      assert.match(context, /launch the independent lanes as parallel Agent calls/);
    } finally {
      if (origWorker === undefined) delete process.env.MYOS_BACKGROUND_PROVIDER; else process.env.MYOS_BACKGROUND_PROVIDER = origWorker;
      process.env.PATH = origPath;
      restoreEnv();
      cleanupTmpHome(tmpHome);
    }
  });

  await t.test("hourly cap: seventh lane in an hour is not spawned", () => {
    const tmpHome = createTmpHome();
    const fixtureBin = createFixtureScript(tmpHome);
    const sessionId = "session-hourly-cap-" + Date.now();
    const restoreEnv = setupTestEnv(tmpHome, fixtureBin);

    try {
      process.env.MYOS_AUTO_FANOUT = "1";
      process.env.MYOS_BACKGROUND_AGENTS_ENABLED = "1";

      const resDir = path.join(tmpHome, "state", "sidecar-results", sessionId);
      fs.mkdirSync(resDir, { recursive: true });

      // Seed manifest with 6 dispatched lanes in the last hour
      const now = Date.now();
      const manifestPath = path.join(resDir, "manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify({
        delivered: [],
        dispatched: [
          { id: "l1", timestamp: now - 1000 },
          { id: "l2", timestamp: now - 2000 },
          { id: "l3", timestamp: now - 3000 },
          { id: "l4", timestamp: now - 4000 },
          { id: "l5", timestamp: now - 5000 },
          { id: "l6", timestamp: now - 6000 },
        ],
      }), "utf8");

      const prompt = "Implement the new report pipeline across all services, verify end-to-end, and update docs";
      const output = handleHookPayload({
        hook_event_name: "UserPromptSubmit",
        session_id: sessionId,
        cwd: process.cwd(),
        prompt,
      }, "claude", { contextMode: "full" });

      const context = output?.hookSpecificOutput?.additionalContext || "";
      assert.doesNotMatch(context, /ALREADY RUNNING in the background/);

      const manifestAfter = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      assert.equal(manifestAfter.dispatched.length, 6, "Seventh lane should not be dispatched due to hourly cap");
    } finally {
      restoreEnv();
      cleanupTmpHome(tmpHome);
    }
  });
});

"use strict";

// Behavioral tests for bin/myos-rabbithole-hook: state persistence, the
// drift-interval cooldown, the once-per-session lateness nudge, and the
// disable switch. Runs the hook as a real subprocess against a throwaway
// MYOS_HOME_ROOT sandbox (never the real state directory).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOOK = path.join(__dirname, "..", "bin", "myos-rabbithole-hook");
const NODE = process.execPath;

function sandboxHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-hook-home-"));
}

function run(payload, env = {}) {
  const res = spawnSync(NODE, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

function stateFile(home, sessionId) {
  return path.join(home, "state", "rabbit-hole", `${sessionId}.json`);
}

function readState(home, sessionId) {
  return JSON.parse(fs.readFileSync(stateFile(home, sessionId), "utf8"));
}

// A daytime hour, deliberately outside the default late window (23-5), so
// lateness never confounds the drift-only assertions below.
const DAYTIME_ENV = { MYOS_RABBITHOLE_LATE_HOUR_START: "23", MYOS_RABBITHOLE_LATE_HOUR_END: "23" }; // start==end -> isLateHour always false

test("(a) MYOS_RABBITHOLE_DISABLE=1 -> always silent, no state written", () => {
  const home = sandboxHome();
  const r = run({ session_id: "s1" }, { MYOS_HOME_ROOT: home, MYOS_RABBITHOLE_DISABLE: "1" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), "");
  assert.ok(!fs.existsSync(stateFile(home, "s1")), "disabled run must not even write state");
});

test("(b) fresh session, daytime -> silent, state initialized", () => {
  const home = sandboxHome();
  const r = run({ session_id: "s2" }, { MYOS_HOME_ROOT: home, ...DAYTIME_ENV });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), "", "must not nudge on the very first prompt");
  const state = readState(home, "s2");
  assert.ok(state.sessionStartTs > 0);
  assert.strictEqual(state.latenessNudged, false);
});

test("(c) immediate second prompt, daytime -> still silent (interval not elapsed)", () => {
  const home = sandboxHome();
  run({ session_id: "s3" }, { MYOS_HOME_ROOT: home, ...DAYTIME_ENV });
  const r2 = run({ session_id: "s3" }, { MYOS_HOME_ROOT: home, ...DAYTIME_ENV });
  assert.strictEqual(r2.status, 0);
  assert.strictEqual(r2.stdout.trim(), "");
});

test("(d) drift interval elapsed -> nudges exactly once, then cools down", () => {
  const home = sandboxHome();
  run({ session_id: "s4" }, { MYOS_HOME_ROOT: home, ...DAYTIME_ENV });

  // Fast-forward: age the state file past a 1-minute drift interval.
  const f = stateFile(home, "s4");
  const state = JSON.parse(fs.readFileSync(f, "utf8"));
  const twoMinAgo = Date.now() - 2 * 60000;
  state.sessionStartTs = twoMinAgo;
  state.lastNudgeTs = twoMinAgo;
  fs.writeFileSync(f, JSON.stringify(state));

  const env = { MYOS_HOME_ROOT: home, MYOS_RABBITHOLE_DRIFT_INTERVAL_MIN: "1", ...DAYTIME_ENV };
  const r2 = run({ session_id: "s4" }, env);
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /additionalContext/, "must nudge once the interval has elapsed");
  const parsed = JSON.parse(r2.stdout);
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(parsed.hookSpecificOutput.additionalContext, /self-check/i);

  // Immediately after: cooldown must suppress a second nudge.
  const r3 = run({ session_id: "s4" }, env);
  assert.strictEqual(r3.stdout.trim(), "", "must not nudge again immediately after nudging");
});

test("(e) late hour -> nudges once per session, never twice", () => {
  const home = sandboxHome();
  const lateEnv = { MYOS_HOME_ROOT: home, MYOS_RABBITHOLE_LATE_HOUR_START: "0", MYOS_RABBITHOLE_LATE_HOUR_END: "24" };
  // start(0) < end(24) covers every hour, so "late" is guaranteed regardless
  // of the actual wall-clock hour when this test runs.
  const r1 = run({ session_id: "s5" }, lateEnv);
  assert.match(r1.stdout, /additionalContext/, "first prompt during the (forced) late window must nudge");
  assert.match(JSON.parse(r1.stdout).hookSpecificOutput.additionalContext, /late hour/i);

  const r2 = run({ session_id: "s5" }, lateEnv);
  assert.strictEqual(r2.stdout.trim(), "", "lateness must not nudge twice in the same session");

  const state = readState(home, "s5");
  assert.strictEqual(state.latenessNudged, true);
});

test("(f) drift and lateness can both fire in the same context string", () => {
  const home = sandboxHome();
  const env = {
    MYOS_HOME_ROOT: home,
    MYOS_RABBITHOLE_DRIFT_INTERVAL_MIN: "1",
    MYOS_RABBITHOLE_LATE_HOUR_START: "0",
    MYOS_RABBITHOLE_LATE_HOUR_END: "24",
  };
  run({ session_id: "s6" }, env); // seed state, first prompt already nudges lateness

  const f = stateFile(home, "s6");
  const state = JSON.parse(fs.readFileSync(f, "utf8"));
  state.sessionStartTs = Date.now() - 2 * 60000;
  state.lastNudgeTs = Date.now() - 2 * 60000;
  state.latenessNudged = false; // simulate lateness not yet nudged, so both trigger together
  fs.writeFileSync(f, JSON.stringify(state));

  const r = run({ session_id: "s6" }, env);
  const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /self-check/i);
  assert.match(context, /late hour/i);
});

test("(g) unparseable input -> fails open (exit 0, silent), never throws", () => {
  const home = sandboxHome();
  const res = spawnSync(NODE, [HOOK], {
    input: "not json at all {{{",
    encoding: "utf8",
    env: { ...process.env, MYOS_HOME_ROOT: home },
  });
  assert.strictEqual(res.status, 0);
});

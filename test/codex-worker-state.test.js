const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const stateModulePath = require.resolve("../src/background/codex-worker-state");

function withTempHome(fn) {
  const originalHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-worker-state-"));
  process.env.HOME = tempHome;
  delete require.cache[stateModulePath];
  const state = require("../src/background/codex-worker-state");

  try {
    return fn(state, tempHome);
  } finally {
    process.env.HOME = originalHome;
    delete require.cache[stateModulePath];
  }
}

test("detectPauseCondition identifies usage-limit pauses and parses retry delay", () => {
  withTempHome((state) => {
    const result = state.detectPauseCondition({
      parsed: { errorMessage: "Usage limit reached. Try again in 5 hours 30 minutes." },
      stderr: "",
      stdout: "",
      fallbackError: "",
    });

    assert.equal(result.isPaused, true);
    assert.equal(result.reason, "usage_limit");
    assert.equal(result.retryDelayMs, (5 * 60 + 30) * 60 * 1000);
  });
});

test("listDuePausedSessions returns only paused sessions whose retry window has arrived", () => {
  withTempHome((state) => {
    const dueState = state.buildBaseState({ taskId: "due-task" });
    dueState.status = "paused";
    dueState.retry.next_retry_at = "2026-04-05T00:00:00.000Z";
    state.writeSessionState(dueState);

    const futureState = state.buildBaseState({ taskId: "future-task" });
    futureState.status = "paused";
    futureState.retry.next_retry_at = "2026-04-06T00:00:00.000Z";
    state.writeSessionState(futureState);

    const due = state.listDuePausedSessions(new Date("2026-04-05T12:00:00.000Z"));
    assert.equal(due.length, 1);
    assert.equal(due[0].task_id, "due-task");
  });
});

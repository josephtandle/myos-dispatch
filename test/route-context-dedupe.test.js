"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  formatDispatchContext,
  handleHookPayload,
} = require("../bin/myos-dispatch-hook");
const { preferredHomeRoot } = require("../src/myos-compat");

test("footer-once-per-turn", () => {
  const sessionId = `test-footer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const homeRoot = preferredHomeRoot();
  const stateFile = path.join(homeRoot, "state", "route-context", `${sessionId}.json`);

  try {
    // Turn 1: UserPromptSubmit
    const out1 = handleHookPayload(
      {
        session_id: sessionId,
        hook_event_name: "UserPromptSubmit",
        cwd: process.cwd(),
        prompt: "Fix dispatch issue",
      },
      "claude",
      { contextMode: "full", rewrite: false }
    );
    const ctx1 = out1?.hookSpecificOutput?.additionalContext || "";
    assert.match(ctx1, /Mandatory behavior:/);
    assert.match(ctx1, /Treat this route as the first routing pass/);

    // Turn 1: PreToolUse with command changing input hash
    const out2 = handleHookPayload(
      {
        session_id: sessionId,
        hook_event_name: "PreToolUse",
        cwd: process.cwd(),
        tool_name: "Bash",
        tool_input: { command: "git status" },
      },
      "claude",
      { contextMode: "full", rewrite: false }
    );
    const ctx2 = out2?.hookSpecificOutput?.additionalContext || "";
    assert.match(ctx2, /Mandatory behavior: unchanged \(see route block earlier this turn\)/);
    assert.doesNotMatch(ctx2, /Treat this route as the first routing pass/);

    // Turn 2: Next UserPromptSubmit resets turn flags
    const out3 = handleHookPayload(
      {
        session_id: sessionId,
        hook_event_name: "UserPromptSubmit",
        cwd: process.cwd(),
        prompt: "Another task in turn 2",
      },
      "claude",
      { contextMode: "full", rewrite: false }
    );
    const ctx3 = out3?.hookSpecificOutput?.additionalContext || "";
    assert.match(ctx3, /Mandatory behavior:/);
    assert.match(ctx3, /Treat this route as the first routing pass/);
  } finally {
    try {
      if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    } catch {}
  }
});

test("scope dedupe", () => {
  const sharedScope = "/var/myos/repo/shared";
  const planShared = {
    parallelizationPlan: {
      backgroundTasks: [
        { id: "lane-1", role: "search", mode: "read_only", joinPolicy: "optional", scope: sharedScope },
        { id: "lane-2", role: "audit", mode: "read_only", joinPolicy: "optional", scope: sharedScope },
      ],
    },
  };
  const ctxShared = formatDispatchContext({
    surface: "claude",
    hookEventName: "UserPromptSubmit",
    targetKind: "user_prompt",
    text: "analyze repo",
    plan: planShared,
  });

  assert.match(ctxShared, new RegExp(`Lane scope: ${sharedScope}`));
  assert.match(ctxShared, /Lane assignments:\n- lane-1 role=search mode=read_only owner=provider-affine read-only sidecar join=optional\n- lane-2 role=audit mode=read_only owner=provider-affine read-only sidecar join=optional/);

  const planDiff = {
    parallelizationPlan: {
      backgroundTasks: [
        { id: "lane-1", role: "search", mode: "read_only", joinPolicy: "optional", scope: "/path/A" },
        { id: "lane-2", role: "audit", mode: "read_only", joinPolicy: "optional", scope: "/path/B" },
      ],
    },
  };
  const ctxDiff = formatDispatchContext({
    surface: "claude",
    hookEventName: "UserPromptSubmit",
    targetKind: "user_prompt",
    text: "analyze repo",
    plan: planDiff,
  });

  assert.doesNotMatch(ctxDiff, /Lane scope:/);
  assert.match(ctxDiff, /scope=\/path\/A/);
  assert.match(ctxDiff, /scope=\/path\/B/);
});

test("identical-block suppression", () => {
  const sessionId = `test-dedupe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const homeRoot = preferredHomeRoot();
  const stateFile = path.join(homeRoot, "state", "route-context", `${sessionId}.json`);

  try {
    // 1st call in turn: UserPromptSubmit
    handleHookPayload(
      {
        session_id: sessionId,
        hook_event_name: "UserPromptSubmit",
        cwd: process.cwd(),
        prompt: "Run tests",
      },
      "claude",
      { contextMode: "full", rewrite: false }
    );

    // 2nd call in turn: PreToolUse (emits context block for git status)
    const out2 = handleHookPayload(
      {
        session_id: sessionId,
        hook_event_name: "PreToolUse",
        cwd: process.cwd(),
        tool_name: "Bash",
        tool_input: { command: "git status" },
      },
      "claude",
      { contextMode: "full", rewrite: false }
    );
    const ctx2 = out2?.hookSpecificOutput?.additionalContext || "";
    assert.match(ctx2, /\[MyOS Dispatch route\]/);
    assert.match(ctx2, /Mandatory behavior: unchanged/);

    // 3rd call in SAME turn: PreToolUse with exact same command and route
    const out3 = handleHookPayload(
      {
        session_id: sessionId,
        hook_event_name: "PreToolUse",
        cwd: process.cwd(),
        tool_name: "Bash",
        tool_input: { command: "git status" },
      },
      "claude",
      { contextMode: "full", rewrite: false }
    );
    const ctx3 = out3?.hookSpecificOutput?.additionalContext || "";
    assert.equal(
      ctx3,
      "[MyOS Dispatch route] unchanged from previous injection this turn."
    );
  } finally {
    try {
      if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    } catch {}
  }
});

test("corrupt-state fallback", () => {
  const sessionId = `test-corrupt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const homeRoot = preferredHomeRoot();
  const stateDir = path.join(homeRoot, "state", "route-context");
  const stateFile = path.join(stateDir, `${sessionId}.json`);

  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, "{ invalid json content !!!", "utf8");

    const out = handleHookPayload(
      {
        session_id: sessionId,
        hook_event_name: "UserPromptSubmit",
        cwd: process.cwd(),
        prompt: "Do work despite corrupt state",
      },
      "claude",
      { contextMode: "full", rewrite: false }
    );

    const ctx = out?.hookSpecificOutput?.additionalContext || "";
    assert.match(ctx, /\[MyOS Dispatch route\]/);
    assert.match(ctx, /Mandatory behavior:/);
    assert.match(ctx, /Treat this route as the first routing pass/);
  } finally {
    try {
      if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    } catch {}
  }
});

test("missing session_id fallback", () => {
  // Call UserPromptSubmit without session_id
  const out1 = handleHookPayload(
    {
      hook_event_name: "UserPromptSubmit",
      cwd: process.cwd(),
      prompt: "No session ID task",
    },
    "claude",
    { contextMode: "full", rewrite: false }
  );
  const ctx1 = out1?.hookSpecificOutput?.additionalContext || "";
  assert.match(ctx1, /Mandatory behavior:/);
  assert.match(ctx1, /Treat this route as the first routing pass/);

  // Second call without session_id
  const out2 = handleHookPayload(
    {
      hook_event_name: "UserPromptSubmit",
      cwd: process.cwd(),
      prompt: "No session ID task",
    },
    "claude",
    { contextMode: "full", rewrite: false }
  );
  const ctx2 = out2?.hookSpecificOutput?.additionalContext || "";
  // Since session_id is absent, it falls back gracefully to full emission each time.
  assert.match(ctx2, /Mandatory behavior:/);
  assert.match(ctx2, /Treat this route as the first routing pass/);
});

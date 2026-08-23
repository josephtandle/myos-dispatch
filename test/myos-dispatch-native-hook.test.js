"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  compactRoute,
  formatDispatchContext,
  handleHookPayload,
  readCommand,
  readHookEventName,
  readPromptText,
} = require("../bin/myos-dispatch-hook");

test("reads Claude/Codex prompt and tool payload shapes", () => {
  assert.equal(readHookEventName({ prompt: "fix dispatch" }), "UserPromptSubmit");
  assert.equal(readHookEventName({ tool_input: { command: "git status" } }), "PreToolUse");
  assert.equal(readPromptText({ user_prompt: "clean dirty files" }), "clean dirty files");
  assert.equal(readCommand({ tool_input: { command: "git status" } }), "git status");
});

test("normalizes Codex snake_case hook event names", () => {
  assert.equal(readHookEventName({ hook_event_name: "user_prompt_submit", prompt: "x" }), "UserPromptSubmit");
  assert.equal(readHookEventName({ hook_event_name: "pre_tool_use", tool_input: { command: "ls" } }), "PreToolUse");
});

test("UserPromptSubmit (Codex surface) emits full route with fanout mandate and native-thread instruction", () => {
  const output = handleHookPayload({
    hook_event_name: "user_prompt_submit",
    cwd: process.cwd(),
    prompt: "Implement the new report pipeline, verify it end-to-end, and update the docs",
  }, "codex", { contextMode: "full", rewrite: false });

  const context = output?.hookSpecificOutput?.additionalContext || "";
  assert.match(context, /\[MyOS Dispatch route\]/);
  assert.match(context, /Mandatory behavior:/);
  assert.match(context, /Fan out FIRST/);
  assert.match(context, /breadth over depth/i);
  assert.match(context, /native multi-agent threads/);
  assert.match(context, /Lane assignments:/);
  assert.match(context, /myos_code_mapper|myos_lane_lead/);
  assert.match(context, /read-only lane\(s\) listed above/i);
  assert.match(context, /runner-owned writable lane/i);
  assert.match(context, /\[Intent Horizon contract\]/);
});

test("Claude and Codex receive the same Intent Horizon contract for the same actionable request", () => {
  const payload = {
    hook_event_name: "UserPromptSubmit",
    cwd: process.cwd(),
    prompt: "Implement the report pipeline, verify the behavior, and update its documentation",
  };
  const getContract = (surface) => {
    const output = handleHookPayload(payload, surface, { contextMode: "full", rewrite: false });
    const context = output?.hookSpecificOutput?.additionalContext || "";
    return context.match(/\[Intent Horizon contract\][^\n]*/)?.[0] || null;
  };

  assert.equal(getContract("claude"), getContract("codex"));
  assert.match(getContract("codex") || "", /sweep=required-once candidates=8 auto_apply=4 causal_depth=2/);
});

test("Claude and Codex receive the same Intent Fidelity contract for a correction", () => {
  const payload = {
    hook_event_name: "UserPromptSubmit",
    cwd: process.cwd(),
    prompt: "No, I said keep the current design and finish the implementation",
  };
  const getContract = (surface) => {
    const output = handleHookPayload(payload, surface, { contextMode: "full", rewrite: false });
    const context = output?.hookSpecificOutput?.additionalContext || "";
    return context.match(/\[Intent Fidelity contract\][^\n]*/)?.[0] || null;
  };

  assert.equal(getContract("claude"), getContract("codex"));
  assert.match(getContract("codex") || "", /precedence=latest_explicit_instruction/);
  assert.match(getContract("codex") || "", /correction=yes/);
});

test("Intent Horizon stays off for trivial and hard-gated requests", () => {
  for (const prompt of ["What is the version?", "Send this email to the client"]) {
    const output = handleHookPayload({
      hook_event_name: "UserPromptSubmit",
      cwd: process.cwd(),
      prompt,
    }, "codex", { contextMode: "full", rewrite: false });
    assert.doesNotMatch(output?.hookSpecificOutput?.additionalContext || "", /\[Intent Horizon contract\]/);
  }
});

test("UserPromptSubmit emits compact MyOS Dispatch route context", () => {
  const output = handleHookPayload({
    hook_event_name: "UserPromptSubmit",
    cwd: process.cwd(),
    prompt: "Fix the dispatch hook and verify it works",
  }, "test");

  const context = output?.hookSpecificOutput?.additionalContext || "";
  assert.equal(output?.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
  assert.match(context, /\[MyOS Dispatch route\]/);
  assert.match(context, /Surface: test/);
  assert.match(context, /Fanout:/);
  assert.match(context, /Mandatory behavior:/);
});

test("UserPromptSubmit blocks uppercase H ping", () => {
  const output = handleHookPayload({
    hook_event_name: "UserPromptSubmit",
    cwd: process.cwd(),
    prompt: "H",
  }, "test");

  assert.equal(output.decision, "block");
  assert.equal(output.reason, "ping");
  assert.equal(output.hookSpecificOutput, undefined);
});

test("UserPromptSubmit blocks lowercase h ping", () => {
  const output = handleHookPayload({
    hook_event_name: "UserPromptSubmit",
    cwd: process.cwd(),
    prompt: "h",
  }, "test");

  assert.equal(output.decision, "block");
  assert.equal(output.reason, "ping");
  assert.equal(output.hookSpecificOutput, undefined);
});

test("UserPromptSubmit does not over-match ordinary prompts", () => {
  const output = handleHookPayload({
    hook_event_name: "UserPromptSubmit",
    cwd: process.cwd(),
    prompt: "Hello",
  }, "test");

  assert.notEqual(output.decision, "block");
  assert.ok(output.hookSpecificOutput?.additionalContext);
});

test("UserPromptSubmit blocks whitespace-padded H ping", () => {
  const output = handleHookPayload({
    hook_event_name: "UserPromptSubmit",
    cwd: process.cwd(),
    prompt: " H ",
  }, "test");

  assert.equal(output.decision, "block");
  assert.equal(output.reason, "ping");
  assert.equal(output.hookSpecificOutput, undefined);
});

test("PreToolUse (Claude surface) routes Bash commands and preserves RTK rewrite", () => {
  const output = handleHookPayload({
    hook_event_name: "PreToolUse",
    cwd: process.cwd(),
    tool_name: "Bash",
    tool_input: { command: "git status" },
  }, "claude", { contextMode: "full", rewrite: true });

  const hook = output?.hookSpecificOutput || {};
  assert.equal(hook.hookEventName, "PreToolUse");
  assert.match(hook.additionalContext || "", /Target: bash_command/);
  assert.match(hook.additionalContext || "", /Execution lane:/);
  assert.equal(hook.updatedInput?.command, "rtk git status");
});

test("PreToolUse (Codex surface) emits compact context and never rewrites", () => {
  const output = handleHookPayload({
    hook_event_name: "PreToolUse",
    cwd: process.cwd(),
    tool_name: "Bash",
    tool_input: { command: "git status" },
  }, "codex", { contextMode: "compact", rewrite: false });

  const hook = output?.hookSpecificOutput || {};
  assert.equal(hook.hookEventName, "PreToolUse");
  assert.match(hook.additionalContext || "", /^\[MyOS Dispatch\] surface=codex/);
  assert.doesNotMatch(hook.additionalContext || "", /Mandatory behavior:/);
  assert.equal(hook.updatedInput, undefined);
  assert.equal(hook.permissionDecision, undefined);
  assert.equal(hook.permissionDecisionReason, undefined);
});

test("PreToolUse (Claude surface) rejects RTK grep rewrites when grep reads stdin or is in a pipe", () => {
  function getRewrite(cmd) {
    const output = handleHookPayload(
      {
        hook_event_name: "PreToolUse",
        cwd: process.cwd(),
        tool_name: "Bash",
        tool_input: { command: cmd },
      },
      "claude",
      { contextMode: "full", rewrite: true }
    );
    return output?.hookSpecificOutput?.updatedInput?.command;
  }

  // Bare grep without path operand (reads stdin) -> NOT rewritten
  assert.equal(getRewrite("grep illy"), undefined);

  // Grep on right-hand side of pipe -> NOT converted to rtk grep
  assert.equal(getRewrite("ps aux | grep illy"), undefined);
  assert.equal(getRewrite("lsof -i | grep LISTEN"), undefined);

  // Genuine file searches with explicit path operands -> IS rtk-wrapped
  assert.equal(getRewrite("grep -rn pattern ./src"), "rtk grep -rn pattern ./src");
  assert.equal(getRewrite("grep -n foo file.txt"), "rtk grep -n foo file.txt");

  // Non-grep commands -> still rewrites as expected
  assert.equal(getRewrite("git status"), "rtk git status");

  // Malformed/ambiguous command -> falls back to original, does not throw, emits valid JSON
  const malformedOutput = handleHookPayload(
    {
      hook_event_name: "PreToolUse",
      cwd: process.cwd(),
      tool_name: "Bash",
      tool_input: { command: "grep $(echo illy)" },
    },
    "claude",
    { contextMode: "full", rewrite: true }
  );
  assert.ok(malformedOutput);
  assert.equal(malformedOutput.hookSpecificOutput?.hookEventName, "PreToolUse");
  assert.equal(malformedOutput.hookSpecificOutput?.updatedInput, undefined);
});

test("compactRoute extracts matched fastpaths up to max 5, prioritizing capability_id over intent", () => {
  const planWithMatches = {
    branch: "fastpath",
    fastpathMatches: [
      { fastpath: { capability_id: "cap-1", intent: "intent-1" } },
      { fastpath: { intent: "intent-2" } },
      { fastpath: { capability_id: "cap-3" } },
      { fastpath: { capability_id: "cap-4", intent: "intent-4" } },
      { fastpath: { intent: "intent-5" } },
      { fastpath: { capability_id: "cap-6" } },
    ],
  };

  const route = compactRoute(planWithMatches);
  assert.deepEqual(route.fastpaths, ["cap-1", "intent-2", "cap-3", "cap-4", "intent-5"]);
});

test("compactRoute omits fastpaths field when fastpathMatches is missing, empty, or malformed", () => {
  assert.equal(compactRoute({}).fastpaths, undefined);
  assert.equal(compactRoute(null).fastpaths, undefined);
  assert.equal(compactRoute({ fastpathMatches: [] }).fastpaths, undefined);
  assert.equal(compactRoute({ fastpathMatches: "invalid" }).fastpaths, undefined);
  assert.equal(compactRoute({ fastpathMatches: [{}, null, { fastpath: {} }] }).fastpaths, undefined);
});

test("compactRoute preserves the machine-consumable Intent Horizon contract", () => {
  const intentHorizon = {
    version: "intent-horizon-v1",
    enabled: true,
    sweep: { maxCandidates: 8, maxAutoApply: 4, maxCausalDepth: 2, maxRuns: 1 },
  };
  const route = compactRoute({
    parallelizationPlan: {
      executionEnvelope: { level: "gold", features: { intentHorizon } },
    },
  });

  assert.deepEqual(route.parallelization.intentHorizon, intentHorizon);
});

test("compactRoute preserves the machine-consumable Intent Fidelity contract", () => {
  const intentFidelity = {
    version: "intent-fidelity-v1",
    enabled: true,
    correctionDetected: true,
    precedence: ["latest_explicit_instruction"],
    defaultDecision: "execute_next_safe_step",
  };
  const route = compactRoute({
    parallelizationPlan: {
      executionEnvelope: { level: "gold", features: { intentFidelity } },
    },
  });

  assert.deepEqual(route.parallelization.intentFidelity, intentFidelity);
});

test("UserPromptSubmit and PreToolUse route logs carry the Intent Fidelity contract", () => {
  const tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "myos-dispatch-hook-intent-fidelity-"));
  const origLogDir = process.env.MYOS_DISPATCH_HOOK_LOG_DIR;
  process.env.MYOS_DISPATCH_HOOK_LOG_DIR = tmpLogDir;

  try {
    handleHookPayload({
      hook_event_name: "UserPromptSubmit",
      cwd: process.cwd(),
      prompt: "Actually, use the current design and finish it",
    }, "codex");

    handleHookPayload({
      hook_event_name: "PreToolUse",
      cwd: process.cwd(),
      tool_name: "Bash",
      tool_input: { command: "git status" },
    }, "codex", { contextMode: "compact", rewrite: false });

    const logFile = path.join(tmpLogDir, "myos-dispatch-hooks.jsonl");
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    const userPromptRecord = JSON.parse(lines[0]);
    const preToolRecord = JSON.parse(lines[1]);

    assert.equal(userPromptRecord.intentFidelity?.version, "intent-fidelity-v1");
    assert.equal(userPromptRecord.intentFidelity?.correctionDetected, true);
    assert.equal(preToolRecord.intentFidelity?.version, "intent-fidelity-v1");
    assert.equal(preToolRecord.intentFidelity?.enabled, true);
  } finally {
    if (origLogDir !== undefined) {
      process.env.MYOS_DISPATCH_HOOK_LOG_DIR = origLogDir;
    } else {
      delete process.env.MYOS_DISPATCH_HOOK_LOG_DIR;
    }
  }
});

test("formatDispatchContext injected context text is byte-identical whether fastpaths are present or omitted", () => {
  const basePlan = {
    branch: "fastpath",
    intentType: "directive",
    actionType: "read",
    route: { lane: "worker_skill", reason: "fastpath" },
  };

  const planWithFastpaths = {
    ...basePlan,
    fastpathMatches: [
      { fastpath: { capability_id: "cap-1" } },
    ],
  };

  const ctxWithout = formatDispatchContext({
    surface: "claude",
    hookEventName: "UserPromptSubmit",
    targetKind: "user_prompt",
    text: "test prompt",
    plan: basePlan,
  });

  const ctxWith = formatDispatchContext({
    surface: "claude",
    hookEventName: "UserPromptSubmit",
    targetKind: "user_prompt",
    text: "test prompt",
    plan: planWithFastpaths,
  });

  assert.equal(ctxWith, ctxWithout);
});

test("appendRouteLog records fastpaths on UserPromptSubmit and PreToolUse callsites", () => {
  const tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "myos-dispatch-hook-log-test-"));
  const origLogDir = process.env.MYOS_DISPATCH_HOOK_LOG_DIR;
  process.env.MYOS_DISPATCH_HOOK_LOG_DIR = tmpLogDir;

  try {
    // 1. UserPromptSubmit test
    const userPromptPayload = {
      hook_event_name: "UserPromptSubmit",
      cwd: process.cwd(),
      prompt: "Show system health status",
    };
    handleHookPayload(userPromptPayload, "claude");

    // 2. PreToolUse test
    const preToolPayload = {
      hook_event_name: "PreToolUse",
      cwd: process.cwd(),
      tool_name: "Bash",
      tool_input: { command: "git status" },
    };
    handleHookPayload(preToolPayload, "claude", { contextMode: "full", rewrite: false });

    const logFile = path.join(tmpLogDir, "myos-dispatch-hooks.jsonl");
    assert.ok(fs.existsSync(logFile));

    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);

    const userPromptRecord = JSON.parse(lines[0]);
    assert.equal(userPromptRecord.hookEventName, "UserPromptSubmit");
    // Verify fastpaths is either array or omitted depending on whether query matched fastpath fixture
    if (userPromptRecord.fastpaths) {
      assert.ok(Array.isArray(userPromptRecord.fastpaths));
      assert.ok(userPromptRecord.fastpaths.length <= 5);
    }
    assert.equal(userPromptRecord.intentHorizon?.version, "intent-horizon-v1");
    assert.equal(userPromptRecord.intentFidelity?.version, "intent-fidelity-v1");

    const preToolRecord = JSON.parse(lines[1]);
    assert.equal(preToolRecord.hookEventName, "PreToolUse");
    if (preToolRecord.fastpaths) {
      assert.ok(Array.isArray(preToolRecord.fastpaths));
      assert.ok(preToolRecord.fastpaths.length <= 5);
    }
  } finally {
    if (origLogDir !== undefined) {
      process.env.MYOS_DISPATCH_HOOK_LOG_DIR = origLogDir;
    } else {
      delete process.env.MYOS_DISPATCH_HOOK_LOG_DIR;
    }
  }
});

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
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


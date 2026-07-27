"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  compileScheduleSpec,
  validateScheduleSpec,
} = require("../src/orchestration/schedule-spec");

const SAFE_SPEC = {
  scheduleId: "weekly-dispatch-audit",
  owner: "myos",
  cadence: "0 9 * * 1",
  timezone: "Asia/Singapore",
  substrate: "codex_scheduled",
  action: "report",
  prompt: "Audit MyOS Dispatch health and report findings",
  repository: "/tmp/myos-dispatch",
};

test("gold scheduled dispatch compiles only report-or-propose work", () => {
  const compiled = compileScheduleSpec(SAFE_SPEC, { env: {} });
  assert.equal(compiled.status, "ready");
  assert.equal(compiled.execution.initiator, "unattended");
  assert.equal(compiled.execution.mutationPolicy, "report_or_propose_only");
  assert.equal(compiled.execution.environment.MYOS_BACKGROUND_AGENTS_ENABLED, "0");
  assert.equal(compiled.execution.envelope.features.scheduledTasks.selected, true);
});

test("scheduled mutation and external effects fail closed", () => {
  const invalid = validateScheduleSpec({
    ...SAFE_SPEC,
    action: "act",
    externalMutation: true,
  });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.includes("gold_canary_allows_report_or_propose_only"));
  assert.ok(invalid.errors.includes("external_mutation_forbidden"));
  assert.equal(compileScheduleSpec({ ...SAFE_SPEC, action: "act" }).status, "rejected");
});

test("scheduled dispatch kill switch prevents compilation", () => {
  const compiled = compileScheduleSpec(SAFE_SPEC, {
    env: { MYOS_SCHEDULED_DISPATCH_ENABLED: "0" },
  });
  assert.equal(compiled.status, "disabled");
  assert.equal(compiled.execution, null);
});

test("disabled specs, global rollback, unsafe prompts, and invalid cadence fail closed", () => {
  assert.equal(compileScheduleSpec({ ...SAFE_SPEC, enabled: false }).execution, null);
  assert.equal(compileScheduleSpec(SAFE_SPEC, {
    env: { MYOS_ORCHESTRATION_GOLD_ENABLED: "0" },
  }).status, "disabled");
  const unsafe = validateScheduleSpec({
    ...SAFE_SPEC,
    prompt: "Send the audit to everyone and deploy the fix",
  });
  assert.ok(unsafe.errors.includes("scheduled_prompt_mutation_or_send_forbidden"));
  const nonsense = validateScheduleSpec({ ...SAFE_SPEC, cadence: "whenever bananas happen" });
  assert.ok(nonsense.errors.includes("cadence_unrecognized"));
  const invalidRange = validateScheduleSpec({ ...SAFE_SPEC, cadence: "99 25 * * 9" });
  assert.ok(invalidRange.errors.includes("cadence_unrecognized"));
  const unscreenedVerb = validateScheduleSpec({ ...SAFE_SPEC, prompt: "Upload and share the report" });
  assert.ok(unscreenedVerb.errors.includes("scheduled_prompt_mutation_or_send_forbidden"));
});

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.MYOS_MODEL_CATALOG_LOCAL = process.env.MYOS_MODEL_CATALOG_LOCAL || "/nonexistent/model-catalog.local.json";
const {
  readLaneState,
  writeLaneState,
} = require("../src/myos-lane");
const {
  myosRun,
  myOSrunOauth,
  resolveAuthMode,
  resolveCodexOauthModel,
  resolveExecutionPlan,
  resolveProvider,
  resetCodexExecRunnerForTest,
  setCodexExecRunnerForTest,
  validateExecutionCandidate,
} = require("../src/runtime/llm-call");

test("lane state falls back to workspace defaults when file is absent", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "myos-lane-default-"));
  process.env.MYOS_LANE_STATE_PATH = path.join(tempDir, "lane.json");
  delete process.env.MYOS_AUTH_MODE;
  delete process.env.MYOS_API_PROVIDER;
  delete process.env.MYOS_LLM_PROVIDER;
  delete process.env.MYOS_INTERNAL_AUTOMATION_PROVIDER;
  delete process.env.OPENCLAW_LLM_PROVIDER;

  const lane = readLaneState();

  assert.equal(lane.authMode, "api");
  assert.equal(lane.apiProvider, "openai");
  assert.deepEqual(lane.routeOverrides, {});

  delete process.env.MYOS_LANE_STATE_PATH;
});

test("lane state writes and resolves shared defaults", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "myos-lane-write-"));
  process.env.MYOS_LANE_STATE_PATH = path.join(tempDir, "lane.json");
  delete process.env.MYOS_AUTH_MODE;
  delete process.env.MYOS_API_PROVIDER;
  delete process.env.MYOS_LLM_PROVIDER;
  delete process.env.MYOS_INTERNAL_AUTOMATION_PROVIDER;
  delete process.env.OPENCLAW_LLM_PROVIDER;

  writeLaneState(
    {
      authMode: "api",
      apiProvider: "openai",
      routeOverrides: {
        audio_transcription: {
          unattended_local: {
            deterministicOptions: [{ type: "deterministic", tool: "mlx_whisper_local" }],
          },
        },
      },
    },
    { updatedBy: "test" }
  );

  assert.equal(resolveAuthMode(), "api");
  assert.equal(resolveProvider(), "openai");
  assert.deepEqual(readLaneState().routeOverrides.audio_transcription.unattended_local.deterministicOptions, [
    { type: "deterministic", tool: "mlx_whisper_local" },
  ]);

  delete process.env.MYOS_LANE_STATE_PATH;
});

test("automation hard-fails when lane auth mode is oauth", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "myos-lane-oauth-"));
  process.env.MYOS_LANE_STATE_PATH = path.join(tempDir, "lane.json");
  delete process.env.MYOS_AUTH_MODE;
  delete process.env.MYOS_API_PROVIDER;
  writeLaneState({ authMode: "oauth", apiProvider: "openai" }, { updatedBy: "test" });

  await assert.rejects(
    () => myosRun({ prompt: "noop", executionPolicy: "internal_automation" }),
    /MyOS automation cannot run with compliance_lane=interactive_oauth/
  );

  delete process.env.MYOS_LANE_STATE_PATH;
});

test("planning evaluation routes to GPT 5.5 only in interactive OAuth", () => {
  const oauthPlan = resolveExecutionPlan({
    taskClass: "planning",
    intent: "planning_evaluation",
    complianceLane: "interactive_oauth",
    executionPolicy: "interactive_session",
    authMode: "oauth",
  });
  const apiPlan = resolveExecutionPlan({
    taskClass: "planning",
    intent: "planning_evaluation",
    complianceLane: "unattended_api",
    executionPolicy: "internal_automation",
    authMode: "api",
  });

  assert.equal(oauthPlan.routingSource, "intent");
  assert.equal(oauthPlan.candidates[0].model, "gpt-5.5");
  assert.notEqual(apiPlan.candidates[0].model, "gpt-5.5");
  assert.equal(resolveCodexOauthModel("gpt-5.5"), "gpt-5.4");
  assert.equal(resolveCodexOauthModel("gpt-5.5", { allowGpt55: true }), "gpt-5.5");
});

test("advisory strategy routes Fable only in interactive OAuth", () => {
  const oauthPlan = resolveExecutionPlan({
    taskClass: "planning",
    intent: "advisory_strategy",
    complianceLane: "interactive_oauth",
    executionPolicy: "interactive_session",
    authMode: "oauth",
  });
  const apiPlan = resolveExecutionPlan({
    taskClass: "planning",
    intent: "advisory_strategy",
    complianceLane: "unattended_api",
    executionPolicy: "internal_automation",
    authMode: "api",
  });

  assert.equal(oauthPlan.routingSource, "intent");
  assert.equal(oauthPlan.candidates[0].provider, "anthropic");
  assert.equal(oauthPlan.candidates[0].profile, "anthropic_advisor");
  assert.equal(oauthPlan.candidates[0].authMode, "oauth");
  assert.ok(apiPlan.candidates.every((candidate) => candidate.provider !== "anthropic"));
  assert.ok(apiPlan.candidates.every((candidate) => candidate.profile !== "anthropic_advisor"));
});

test("advisory strategy OAuth route is policy-only until Anthropic OAuth is implemented", () => {
  const oauthPlan = resolveExecutionPlan({
    taskClass: "planning",
    intent: "advisory_strategy",
    complianceLane: "interactive_oauth",
    executionPolicy: "interactive_session",
    authMode: "oauth",
  });

  assert.throws(
    () => validateExecutionCandidate(oauthPlan, oauthPlan.candidates[0], { authMode: "oauth" }),
    /Anthropic OAuth execution is not implemented/
  );
});

test("Fable advisory candidates are blocked from API auth even when explicit", () => {
  const plan = {
    routeKey: "advisory_strategy",
    complianceLane: "unattended_api",
    taskClass: "planning",
  };

  assert.throws(
    () =>
      validateExecutionCandidate(
        plan,
        {
          type: "llm",
          provider: "anthropic",
          profile: "anthropic_advisor",
          model: null,
          authMode: "api",
        },
        { authMode: "api" }
      ),
    /OAuth-only/
  );
});

test("explicit Fable model IDs are blocked from API auth outside the advisory profile", () => {
  const plan = {
    routeKey: "explicit_override",
    complianceLane: "unattended_api",
    taskClass: "planning",
  };

  for (const provider of ["anthropic", "openrouter", "openai"]) {
    for (const model of ["claude-fable-5", "anthropic.claude-fable-5"]) {
      assert.throws(
        () =>
          validateExecutionCandidate(
            plan,
            {
              type: "llm",
              provider,
              profile: "planning",
              model,
              authMode: "api",
            },
            { authMode: "api" }
          ),
        /OAuth-only/
      );
    }
  }
});

test("myosRun preserves GPT 5.5 for foreground planning evaluation OAuth calls", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "myos-lane-ledgers-"));
  const previousEnv = {
    MYOS_USAGE_LEDGER_DIR: process.env.MYOS_USAGE_LEDGER_DIR,
    MYOS_ACTIVITY_LEDGER_DIR: process.env.MYOS_ACTIVITY_LEDGER_DIR,
    MYOS_DISPATCH_HEALTH_STATE_FILE: process.env.MYOS_DISPATCH_HEALTH_STATE_FILE,
  };
  process.env.MYOS_USAGE_LEDGER_DIR = path.join(tempRoot, "usage");
  process.env.MYOS_ACTIVITY_LEDGER_DIR = path.join(tempRoot, "activity");
  process.env.MYOS_DISPATCH_HEALTH_STATE_FILE = path.join(tempRoot, "health.json");
  setCodexExecRunnerForTest(({ model, allowGpt55 }) => {
    assert.equal(model, "gpt-5.5");
    assert.equal(allowGpt55, true);
    return "plan evaluation ok";
  });

  try {
    const result = await myOSrunOauth({
      prompt: "Evaluate this dispatch plan",
      taskClass: "planning",
      intent: "planning_evaluation",
      humanVisible: true,
      includeMetadata: true,
      caller: {
        agentId: "test",
        project: "test",
        surface: "test",
      },
    });

    assert.equal(result.text, "plan evaluation ok");
    assert.equal(result.resolvedModelOrEngine, "gpt-5.5");
    assert.equal(result.raw.model, "gpt-5.5");
    assert.equal(result.goalScale, 3);
    assert.equal(result.goalMode, "ralph");
  } finally {
    resetCodexExecRunnerForTest();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const { buildParallelizationPlan, compactParallelizationPlan, resolveMaxSidecars } = require("../src/parallelization-planner");
const { getParallelizationStage, recordParallelizationRun } = require("../src/promotion/parallelization-version-policy");
const {
  ANTHROPIC_ENV_KEYS,
  assertGeminiOauthOnly,
  assertNoAnthropicKeysInChildEnv,
  buildCodexApiKeyEnv,
  buildCodexOauthEnv,
  buildBackgroundWorkerInvocation,
  buildReadOnlyPrompt,
  buildWritablePrompt,
  extractBackgroundSummary,
  isUnattendedContext,
  resolveOptionalSidecarGraceMs,
  runBackgroundTasks,
} = require("../src/background/background-agent-runner");

function tempStateFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "parallel-runner-health-")), "state.json");
}

function cleanStage(env = {}) {
  return getParallelizationStage({
    stateFile: tempStateFile(),
    env,
  });
}

test("parallelization planner records no-op decision for direct lightweight asks", () => {
  const plan = buildParallelizationPlan("are you awake?", {
    branch: "fallback",
    actionType: "read",
    route: { lane: "worker_skill" },
  });

  assert.equal(plan.mode, "none");
  assert.equal(plan.backgroundTasks.length, 0);
  assert.equal(plan.joinPolicy, "none");
});

test("parallelization planner fans out short research complaints but not status pings", () => {
  const researchPlan = buildParallelizationPlan("what's going on with dispatch fanout", {
    branch: "fallback",
    intentType: "exploratory",
    actionType: "read",
    route: { lane: "worker_skill" },
  }, {
    parallelizationStage: cleanStage(),
  });
  const statusPlan = buildParallelizationPlan("status", {
    branch: "fallback",
    intentType: "exploratory",
    actionType: "read",
    route: { lane: "worker_skill" },
  }, {
    parallelizationStage: cleanStage(),
  });

  assert.equal(researchPlan.mode, "read_only");
  assert.equal(researchPlan.aggression, "deep");
  assert.ok(researchPlan.backgroundTasks.length >= 4);
  assert.ok(researchPlan.backgroundTasks.some((task) => task.id === "decompose-1"));
  assert.equal(statusPlan.mode, "none");
  assert.equal(statusPlan.backgroundTasks.length, 0);
});

test("optional sidecar grace uses a bounded env-backed default", () => {
  assert.equal(resolveOptionalSidecarGraceMs({}), 1000);
  assert.equal(resolveOptionalSidecarGraceMs({ MYOS_OPTIONAL_SIDECAR_GRACE_MS: "250" }), 250);
  assert.equal(resolveOptionalSidecarGraceMs({ MYOS_OPTIONAL_SIDECAR_GRACE_MS: "-50" }), 0);
  assert.equal(resolveOptionalSidecarGraceMs({ MYOS_OPTIONAL_SIDECAR_GRACE_MS: "99999" }), 5000);
  assert.equal(resolveOptionalSidecarGraceMs({ MYOS_OPTIONAL_SIDECAR_GRACE_MS: "not-a-number" }), 1000);
});

test("parallelization planner creates provider-affine sidecars for complex implementation work", () => {
  const plan = buildParallelizationPlan("Fix the dispatch runtime, verify the tests, and review the rollout risk", {
    branch: "fallback",
    actionType: "write",
    route: { lane: "worker_skill" },
    searchScope: "<workspace>/agents/shared",
  }, {
    parallelizationStage: cleanStage(),
  });

  assert.equal(plan.mode, "provider_affine_git_worktrees");
  assert.equal(plan.promotion.activeStage, "writable_sidecars_v1");
  assert.equal(plan.promotion.nextStage, null);
  assert.equal(plan.promotion.autoPromote, false);
  assert.ok(plan.backgroundTasks.length >= 2);
  assert.ok(plan.backgroundTasks.some((task) => task.mode === "workspace_write"));
  assert.ok(plan.backgroundTasks.some((task) => task.modelProfile === "default_automation"));
  assert.ok(plan.backgroundTasks.some((task) => task.modelProfile === "default_automation"));
});

test("parallelization planner supports a configurable 20-sidecar cap", () => {
  const plan = buildParallelizationPlan("Research the dispatch architecture, implement the runtime fix, verify tests, review rollout risk, and document rollback", {
    branch: "fallback",
    intentType: "exploratory",
    actionType: "write",
    route: { lane: "worker_skill" },
    searchScope: "<workspace>/agents/shared",
  }, {
    env: { MYOS_PARALLELIZATION_MAX_AGENTS: "24" },
    parallelizationStage: cleanStage(),
  });

  assert.equal(resolveMaxSidecars({ MYOS_PARALLELIZATION_MAX_SIDECARS: "99" }), 20);
  assert.ok(plan.backgroundTasks.length >= 6);
  assert.ok(plan.backgroundTasks.length <= 20);
  assert.equal(plan.budget.maxAgents, plan.backgroundTasks.length);
  // Lanes must be distinct work, never padded copies of the same prompt.
  const prompts = plan.backgroundTasks.map((task) => task.prompt);
  assert.equal(new Set(prompts).size, prompts.length);
});

test("parallelization planner fans out command creation with human-driven OAuth policy", () => {
  const plan = buildParallelizationPlan("When creating commands, invite more background agents, make sure they are running OAuth for human driven work, use the lowest model that can get the job done, and ask infra PM and the review council", {
    branch: "fallback",
    intentType: "exploratory",
    actionType: "write",
    route: { lane: "worker_skill" },
    searchScope: "<workspace>/agents/shared",
  }, {
    env: { MYOS_PARALLELIZATION_MAX_AGENTS: "24" },
    parallelizationStage: cleanStage(),
  });

  assert.equal(plan.mode, "provider_affine_git_worktrees");
  assert.equal(plan.blockedReasons.includes("auth_sensitive"), false);
  assert.ok(plan.backgroundTasks.length >= 8);
  assert.equal(plan.budget.tokenStrategy, "provider_affine_lowest_cost_reliable_model");
  assert.equal(plan.modelPolicy.defaultProfile, "openai_cheap_extraction");
  assert.equal(plan.authPolicy.humanDrivenMode, "oauth");
  assert.equal(plan.authPolicy.backgroundAuthMode, "provider_human_oauth_only");
  assert.equal(plan.authPolicy.allowedRunner, "caller_provider");
});

test("parallelization planner blocks user-visible and payment-sensitive work", () => {
  const sendPlan = buildParallelizationPlan("send the WhatsApp link to Sam", {
    branch: "fastpath",
    actionType: "write",
    route: { lane: "recipe_dispatcher" },
  });
  const paymentPlan = buildParallelizationPlan("fix the Stripe checkout payment link", {
    branch: "project",
    actionType: "write",
    route: { lane: "worker_skill" },
  });

  assert.equal(sendPlan.mode, "none");
  assert.match(sendPlan.blockedReasons.join(","), /user_visible_send/);
  assert.equal(paymentPlan.backgroundTasks.length, 0);
  assert.match(paymentPlan.blockedReasons.join(","), /payment_or_account_mutation/);
});

test("parallelization planner still blocks secret material and interactive auth actions", () => {
  const secretPlan = buildParallelizationPlan("read the API key token and fix auth", {
    branch: "fallback",
    actionType: "write",
    route: { lane: "worker_skill" },
  });
  const loginPlan = buildParallelizationPlan("log in to the Google OAuth console and authorize the account", {
    branch: "fallback",
    actionType: "write",
    route: { lane: "worker_skill" },
  });

  assert.equal(secretPlan.mode, "none");
  assert.match(secretPlan.blockedReasons.join(","), /auth_sensitive/);
  assert.equal(loginPlan.mode, "none");
  assert.match(loginPlan.blockedReasons.join(","), /interactive_auth_action/);
});

test("compact parallelization metadata omits heavy prompts", () => {
  const plan = buildParallelizationPlan("help me understand acme onboarding and verify risks", {
    branch: "project",
    intentType: "exploratory",
    actionType: "read",
    projectSlug: "acme",
    searchScope: "/tmp/acme",
    route: { lane: "worker_skill" },
  }, {
    parallelizationStage: cleanStage(),
  });
  const compact = compactParallelizationPlan(plan);

  assert.equal(compact.backgroundTaskCount, plan.backgroundTasks.length);
  assert.equal(compact.backgroundTasks[0].prompt, undefined);
  assert.equal(compact.promotion.activeStage, "writable_sidecars_v1");
  assert.equal(compact.promotion.nextStage, null);
  assert.equal(compact.execution.enabledByDefault, true);
  assert.equal(compact.execution.autoPromotionDisableEnv, "MYOS_PARALLELIZATION_AUTO_PROMOTE=0");
  assert.equal(compact.authPolicy.backgroundAuthMode, "provider_human_oauth_only");
});

test("parallelization planner skips task kinds quarantined by health loop", () => {
  const stage = cleanStage({ MYOS_PARALLELIZATION_VERSION: "v2" });
  const plan = buildParallelizationPlan("Fix the dispatch runtime, verify the tests, and review rollout risk", {
    branch: "fallback",
    actionType: "write",
    route: { lane: "worker_skill" },
  }, {
    parallelizationStage: {
      ...stage,
      state: {
        ...stage.state,
        health: {
          status: "degraded",
          activeQuarantines: [
            { type: "taskKind", value: "risk_review", reason: "timeout" },
          ],
          openRepairActions: [],
        },
      },
    },
  });

  assert.equal(plan.health.status, "degraded");
  assert.equal(plan.backgroundTasks.some((task) => task.kind === "risk_review"), false);
  assert.ok(plan.backgroundTasks.some((task) => task.kind === "verify"));
});

test("background runner returns planned results when execution is not enabled", async () => {
  const plan = buildParallelizationPlan("Fix the dispatch runtime, verify the tests, and review the rollout risk", {
    branch: "fallback",
    actionType: "write",
    route: { lane: "worker_skill" },
  }, {
    parallelizationStage: cleanStage({ MYOS_PARALLELIZATION_VERSION: "v2" }),
  });

  const results = await runBackgroundTasks(plan, { enabled: false });

  assert.equal(results.length, plan.backgroundTasks.length);
  assert.equal(results.every((result) => result.status === "planned"), true);
});

test("background runner executes V2 read-only tasks when execution is enabled", async () => {
  const stateFile = tempStateFile();
  const plan = buildParallelizationPlan("Fix the dispatch runtime, verify the tests, and review the rollout risk", {
    branch: "fallback",
    actionType: "write",
    route: { lane: "worker_skill" },
  }, {
    parallelizationStage: getParallelizationStage({
      stateFile,
      env: { MYOS_PARALLELIZATION_VERSION: "v2" },
    }),
  });

  const results = await runBackgroundTasks(plan, {
    enabled: true,
    command: "codex",
    stateFile,
    async runCommand({ invocation }) {
      assert.equal(invocation.kind, "codex");
      assert.ok(invocation.args.includes("--ephemeral"));
      assert.ok(invocation.args.includes("read-only"));
      return {
        code: 0,
        signal: null,
        stdout: JSON.stringify({
          type: "item.completed",
          item: {
            type: "assistant_message",
            content: [{ type: "output_text", text: "read-only finding" }],
          },
        }),
        stderr: "",
      };
    },
  });

  assert.equal(plan.mode, "read_only");
  assert.equal(results.length, plan.backgroundTasks.length);
  assert.equal(results.every((result) => result.status === "completed"), true);
  assert.equal(results[0].runner, "codex");
  assert.match(results[0].summary, /read-only finding/);
});

test("background runner keeps legacy observe mode metadata-only even when execution is enabled", async () => {
  const plan = {
    mode: "observe",
    backgroundTasks: [
      { id: "context-map", prompt: "read only", writeScope: [] },
    ],
    budget: { maxAgents: 1 },
  };

  const results = await runBackgroundTasks(plan, {
    enabled: true,
    async runCommand() {
      throw new Error("observe mode should not execute");
    },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "planned");
});

test("background runner rejects non-Codex workers before provider quarantine checks", async () => {
  const stateFile = tempStateFile();
  const plan = buildParallelizationPlan("Fix the dispatch runtime, verify the tests, and review the rollout risk", {
    branch: "fallback",
    actionType: "write",
    route: { lane: "worker_skill" },
  }, {
    parallelizationStage: cleanStage({ MYOS_PARALLELIZATION_VERSION: "v2" }),
  });
  const failed = {
    taskId: "impact-scan",
    taskKind: "risk_review",
    status: "failed",
    runner: "gemini",
    summary: "Timed out after 90000ms",
  };
  recordParallelizationRun(plan, [failed], {
    stateFile,
    healthFailureThreshold: 1,
    env: {},
  });

  const results = await runBackgroundTasks(plan, {
    enabled: true,
    command: "gemini",
    stateFile,
    async runCommand() {
      throw new Error("non-Codex worker should not execute");
    },
  });

  assert.equal(results.length, plan.backgroundTasks.length);
  assert.equal(results.every((result) => result.status === "skipped"), true);
  assert.match(results[0].summary, /quarantined|human OAuth support is not enabled/);
});

test("background runner builds read-only Codex invocation and scrubs API-key env", async () => {
  const task = {
    id: "context-map",
    prompt: "inspect only",
    writeScope: [],
    modelProfile: "cheap_routing",
  };
  const codex = buildBackgroundWorkerInvocation({
    ...task,
    model: "gpt-5.5",
  }, { command: "codex", provider: "openai", cwd: "/tmp" });

  assert.deepEqual(codex.args.slice(0, 2), ["exec", "--json"]);
  assert.ok(codex.args.includes("--ephemeral"));
  assert.ok(codex.args.includes("read-only"));
  assert.equal(codex.model, "gpt-5.4");

  const prompt = buildReadOnlyPrompt(task);
  assert.match(prompt, /OAuth\/auth lane work is human-driven/);
  assert.match(prompt, /Do not spawn background agents/);
  assert.match(buildWritablePrompt(task), /All fan-out is owned by the parent MyOS Dispatch orchestrator/);

  const env = buildCodexOauthEnv({
    OPENAI_API_KEY: "test-openai",
    CODEX_API_KEY: "test-codex",
    ANTHROPIC_API_KEY: "test-anthropic",
    CLAUDE_API_KEY: "test-claude",
    GEMINI_API_KEY: "test-gemini",
    PATH: "/bin",
  });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_API_KEY, undefined);
  assert.equal(env.GEMINI_API_KEY, "test-gemini");
  assert.equal(env.MYOS_AUTH_MODE, "oauth");

  const results = await runBackgroundTasks({
    mode: "read_only",
    budget: { maxAgents: 1 },
    backgroundTasks: [task],
  }, {
    enabled: true,
    command: "codex",
    stateFile: tempStateFile(),
    env: {
      OPENAI_API_KEY: "test-openai",
      CODEX_API_KEY: "test-codex",
      PATH: "/bin",
    },
    async runCommand({ env: childEnv, invocation }) {
      assert.equal(invocation.kind, "codex");
      assert.equal(childEnv.OPENAI_API_KEY, undefined);
      assert.equal(childEnv.CODEX_API_KEY, undefined);
      assert.equal(childEnv.MYOS_BACKGROUND_AUTH_LABEL, "codex-oauth");
      assert.equal(childEnv.MYOS_BACKGROUND_IS_SIDECAR, "1");
      assert.equal(childEnv.MYOS_SIDECAR_ORCHESTRATED, "1");
      assert.match(childEnv.MYOS_SIDECAR_RUN_ID, /^sidecar-run-/);
      assert.match(childEnv.MYOS_SIDECAR_ORCHESTRATOR_TOKEN, /^sidecar-token-/);
      assert.equal(childEnv.MYOS_SIDECAR_TASK_ID, "context-map");
      assert.equal(childEnv.MYOS_BACKGROUND_AGENTS_ENABLED, "0");
      return {
        code: 0,
        signal: null,
        stdout: JSON.stringify({
          type: "item.completed",
          item: {
            type: "assistant_message",
            content: [{ type: "output_text", text: "oauth sidecar" }],
          },
        }),
        stderr: "",
      };
    },
  });

  assert.equal(results[0].status, "completed");
  assert.equal(results[0].orchestrator, "myos-dispatch");
  assert.match(results[0].sidecarRunId, /^sidecar-run-/);
  assert.equal(results[0].parentTaskId, "root");
});

test("background runner blocks nested fan-out from sidecar processes", async () => {
  const results = await runBackgroundTasks({
    mode: "read_only",
    budget: { maxAgents: 1 },
    backgroundTasks: [
      { id: "nested-context", kind: "context", prompt: "inspect", writeScope: [] },
    ],
  }, {
    enabled: true,
    command: "codex",
    stateFile: tempStateFile(),
    env: {
      PATH: "/bin",
      MYOS_BACKGROUND_IS_SIDECAR: "1",
      MYOS_SIDECAR_ORCHESTRATED: "1",
    },
    async runCommand() {
      throw new Error("nested sidecar launch must not execute");
    },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "skipped");
  assert.match(results[0].summary, /nested background fan-out is blocked/);
});

test("myos-sidecar CLI refuses direct and nested launches", () => {
  const cliPath = path.join(__dirname, "..", "bin", "myos-sidecar.js");
  const direct = spawnSync(process.execPath, [cliPath, "inspect routing"], {
    cwd: path.join(__dirname, "..", "..", ".."),
    env: { PATH: process.env.PATH || "/bin" },
    encoding: "utf8",
  });
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /Refusing direct sidecar launch/);

  const nested = spawnSync(process.execPath, [cliPath, "inspect routing"], {
    cwd: path.join(__dirname, "..", "..", ".."),
    env: {
      PATH: process.env.PATH || "/bin",
      MYOS_BACKGROUND_IS_SIDECAR: "1",
      MYOS_SIDECAR_CLI_ALLOWED: "1",
      MYOS_SIDECAR_RUN_ID: "sidecar-run-test",
      MYOS_SIDECAR_ORCHESTRATOR_TOKEN: "sidecar-token-test",
    },
    encoding: "utf8",
  });
  assert.notEqual(nested.status, 0);
  assert.match(nested.stderr, /Refusing nested sidecar launch/);
});

test("background runner uses API-key env for autonomous/cron callers (MYOS_INITIATOR=unattended)", async () => {
  const task = { id: "cron-sidecar", kind: "source_index_scan", prompt: "read only", writeScope: [] };

  assert.equal(isUnattendedContext({ MYOS_INITIATOR: "unattended" }), true);
  assert.equal(isUnattendedContext({ MYOS_INITIATOR: "UNATTENDED" }), true);
  assert.equal(isUnattendedContext({ MYOS_INITIATOR: "human" }), false);
  assert.equal(isUnattendedContext({}), false);
  // Kill-switch: MYOS_INITIATOR_OAUTH_DISABLED=1 forces API mode regardless of MYOS_INITIATOR (mirrors llm-call.js)
  assert.equal(isUnattendedContext({ MYOS_INITIATOR_OAUTH_DISABLED: "1" }), true);
  assert.equal(isUnattendedContext({ MYOS_INITIATOR_OAUTH_DISABLED: "1", MYOS_INITIATOR: "" }), true);
  assert.equal(isUnattendedContext({ MYOS_INITIATOR_OAUTH_DISABLED: "0" }), false);

  const apiEnv = buildCodexApiKeyEnv({
    OPENAI_API_KEY: "test-openai",
    CODEX_API_KEY: "test-codex",
    ANTHROPIC_API_KEY: "test-anthropic",
    CLAUDE_CODE_API_KEY: "test-claude-code",
    PATH: "/bin",
    MYOS_INITIATOR: "unattended",
  });
  assert.equal(apiEnv.OPENAI_API_KEY, "test-openai");
  assert.equal(apiEnv.CODEX_API_KEY, "test-codex");
  assert.equal(apiEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(apiEnv.CLAUDE_CODE_API_KEY, undefined);
  assert.equal(apiEnv.MYOS_AUTH_MODE, "api");
  assert.equal(apiEnv.MYOS_BACKGROUND_AUTH_LABEL, "codex-api");

  const results = await runBackgroundTasks({
    mode: "read_only",
    budget: { maxAgents: 1 },
    backgroundTasks: [task],
  }, {
    enabled: true,
    command: "codex",
    stateFile: tempStateFile(),
    env: {
      OPENAI_API_KEY: "test-openai",
      CODEX_API_KEY: "test-codex",
      PATH: "/bin",
      MYOS_INITIATOR: "unattended",
    },
    async runCommand({ env: childEnv, invocation }) {
      assert.equal(invocation.kind, "codex");
      assert.equal(childEnv.OPENAI_API_KEY, "test-openai");
      assert.equal(childEnv.CODEX_API_KEY, "test-codex");
      assert.equal(childEnv.MYOS_BACKGROUND_AUTH_LABEL, "codex-api");
      return {
        code: 0,
        signal: null,
        stdout: JSON.stringify({
          type: "item.completed",
          item: {
            type: "assistant_message",
            content: [{ type: "output_text", text: "api sidecar" }],
          },
        }),
        stderr: "",
      };
    },
  });

  assert.equal(results[0].status, "completed");
});

test("parallelization plan backgroundAuthMode reflects human vs autonomous context", () => {
  const humanPlan = buildParallelizationPlan("analyze the dispatch routes", {
    branch: "fallback",
    actionType: "read",
    route: { lane: "worker_skill" },
  }, { env: { MYOS_INITIATOR: "human", MYOS_PARALLELIZATION_VERSION: "v2" }, parallelizationStage: cleanStage({ MYOS_PARALLELIZATION_VERSION: "v2" }) });

  const cronPlan = buildParallelizationPlan("analyze the dispatch routes", {
    branch: "fallback",
    actionType: "read",
    route: { lane: "worker_skill" },
  }, { env: { MYOS_INITIATOR: "unattended", MYOS_PARALLELIZATION_VERSION: "v2" }, parallelizationStage: cleanStage({ MYOS_PARALLELIZATION_VERSION: "v2" }) });

  assert.equal(humanPlan.authPolicy.backgroundAuthMode, "provider_human_oauth_only");
  assert.equal(cronPlan.authPolicy.backgroundAuthMode, "api_key");
});

test("background runner refuses Gemini sidecars when API-key env is visible", async () => {
  assert.throws(
    () => assertGeminiOauthOnly({ env: { GEMINI_API_KEY: "test" } }),
    /OAuth-only auth/,
  );

  const results = await runBackgroundTasks({
    mode: "read_only",
    budget: { maxAgents: 1 },
    backgroundTasks: [
      { id: "context-map", kind: "source_index_scan", prompt: "inspect only", writeScope: [] },
    ],
  }, {
    enabled: true,
    command: "gemini",
    env: { GEMINI_API_KEY: "test" },
    async runCommand() {
      throw new Error("Gemini API-key sidecar should not execute");
    },
  });

  assert.equal(results[0].status, "skipped");
  assert.match(results[0].summary, /human OAuth support is not enabled|OAuth-only auth/);
});

test("ANTHROPIC_ENV_KEYS is exported and covers all known Anthropic credential names", () => {
  const expected = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_API_KEY",
    "CLAUDE_CODE_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ];
  for (const key of expected) {
    assert.ok(ANTHROPIC_ENV_KEYS.includes(key), `ANTHROPIC_ENV_KEYS must include ${key}`);
  }
  assert.ok(Object.isFrozen(ANTHROPIC_ENV_KEYS));
});

test("assertNoAnthropicKeysInChildEnv throws on any Anthropic credential including unknown ANTHROPIC_* names", () => {
  assert.doesNotThrow(() => assertNoAnthropicKeysInChildEnv({ OPENAI_API_KEY: "x", PATH: "/bin" }));
  for (const key of ANTHROPIC_ENV_KEYS) {
    assert.throws(
      () => assertNoAnthropicKeysInChildEnv({ [key]: "secret", PATH: "/bin" }, "test-task"),
      /Security.*must not appear/,
      `assertNoAnthropicKeysInChildEnv must throw for ${key}`,
    );
  }
  // Pattern-based catch-all: novel ANTHROPIC_* key not yet in the explicit list
  assert.throws(
    () => assertNoAnthropicKeysInChildEnv({ ANTHROPIC_BETA_API_KEY: "secret" }, "test-task"),
    /Security.*potential Anthropic credential/,
    "must throw for unknown ANTHROPIC_* key",
  );
  assert.throws(
    () => assertNoAnthropicKeysInChildEnv({ ANTHROPIC_ORG_TOKEN: "secret" }),
    /Security.*must not appear|potential Anthropic credential/,
  );
});

test("background runner strips all Anthropic keys from child env in both OAuth and API-key modes", async () => {
  const task = { id: "context-map", kind: "source_index_scan", prompt: "read only", writeScope: [] };
  const dirtyEnv = {
    OPENAI_API_KEY: "test-openai",
    ANTHROPIC_API_KEY: "test-anthropic",
    ANTHROPIC_AUTH_TOKEN: "test-token",
    ANTHROPIC_BETA_API_KEY: "test-beta",       // novel key not in explicit list
    ANTHROPIC_ORG_TOKEN: "test-org",           // another hypothetical future key
    CLAUDE_API_KEY: "test-claude",
    CLAUDE_CODE_API_KEY: "test-claude-code",
    CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token",
    PATH: "/bin",
  };

  const capturedOauth = {};
  await runBackgroundTasks(
    { mode: "read_only", budget: { maxAgents: 1 }, backgroundTasks: [task] },
    {
      enabled: true,
      command: "codex",
      stateFile: tempStateFile(),
      env: { ...dirtyEnv },
      async runCommand({ env: childEnv }) {
        Object.assign(capturedOauth, childEnv);
        return { code: 0, signal: null, stdout: "{}", stderr: "" };
      },
    },
  );
  const allAnthropicKeys = [...ANTHROPIC_ENV_KEYS, "ANTHROPIC_BETA_API_KEY", "ANTHROPIC_ORG_TOKEN"];
  for (const key of allAnthropicKeys) {
    assert.equal(capturedOauth[key], undefined, `${key} must be absent in OAuth child env`);
  }
  assert.equal(capturedOauth.MYOS_BACKGROUND_AUTH_LABEL, "codex-oauth");

  const capturedApi = {};
  await runBackgroundTasks(
    { mode: "read_only", budget: { maxAgents: 1 }, backgroundTasks: [task] },
    {
      enabled: true,
      command: "codex",
      stateFile: tempStateFile(),
      env: { ...dirtyEnv, MYOS_INITIATOR: "unattended" },
      async runCommand({ env: childEnv }) {
        Object.assign(capturedApi, childEnv);
        return { code: 0, signal: null, stdout: "{}", stderr: "" };
      },
    },
  );
  for (const key of allAnthropicKeys) {
    assert.equal(capturedApi[key], undefined, `${key} must be absent in API-key child env`);
  }
  assert.equal(capturedApi.OPENAI_API_KEY, "test-openai");
  assert.equal(capturedApi.MYOS_BACKGROUND_AUTH_LABEL, "codex-api");
});

test("background summary parser handles JSON outputs from provider CLIs", () => {
  assert.equal(extractBackgroundSummary(JSON.stringify({ result: "claude summary" }), "claude"), "claude summary");
  assert.equal(extractBackgroundSummary(JSON.stringify({ response: "gemini summary" }), "gemini"), "gemini summary");
});

test("parallelization planner skips fan-out on deterministic routes with no consumer", () => {
  const recipePlan = buildParallelizationPlan("generate the weekly report for the project", {
    branch: "fastpath",
    actionType: "write",
    stopAfterMatch: true,
    route: { lane: "recipe_dispatcher" },
  }, { parallelizationStage: cleanStage() });
  const dataPlan = buildParallelizationPlan("look up the contact details for the supplier list", {
    branch: "data",
    actionType: "read",
    route: { lane: "data_lookup" },
  }, { parallelizationStage: cleanStage() });

  assert.equal(recipePlan.mode, "none");
  assert.equal(recipePlan.reason, "deterministic_route_no_consumer");
  assert.equal(dataPlan.mode, "none");
  assert.equal(dataPlan.backgroundTasks.length, 0);
});

test("parallelization planner allows read-only fan-out for deterministic command-handler work", () => {
  const commandPlan = buildParallelizationPlan("update the slash command handler and verify command routing", {
    branch: "fastpath",
    actionType: "write",
    stopAfterMatch: true,
    route: { lane: "recipe_dispatcher" },
  }, { parallelizationStage: cleanStage({ MYOS_PARALLELIZATION_VERSION: "v2" }) });
  const dataPlan = buildParallelizationPlan("look up the contact details for the supplier list", {
    branch: "data",
    actionType: "read",
    route: { lane: "data_lookup" },
  }, { parallelizationStage: cleanStage({ MYOS_PARALLELIZATION_VERSION: "v2" }) });

  assert.equal(commandPlan.mode, "read_only");
  assert.equal(commandPlan.reason, "provider_affine_read_only_background_work_identified");
  assert.ok(commandPlan.backgroundTasks.length >= 4);
  assert.equal(commandPlan.backgroundTasks.every((task) => task.mode === "read_only"), true);
  assert.equal(dataPlan.mode, "none");
  assert.equal(dataPlan.reason, "deterministic_route_no_consumer");
});

test("parallelization planner grounds lanes in dispatch evidence (capability + clause scouts)", () => {
  const plan = buildParallelizationPlan("Investigate the webhook retries and document the failure modes", {
    branch: "project",
    actionType: "read",
    projectSlug: "acme",
    searchScope: "/tmp/acme",
    route: {
      lane: "worker_skill",
      candidates: [{ id: "agent:webhook-monitor" }, { id: "recipe:retry-audit" }],
    },
  }, { parallelizationStage: cleanStage({ MYOS_PARALLELIZATION_VERSION: "v2" }) });

  const kinds = plan.backgroundTasks.map((task) => task.kind);
  assert.ok(kinds.includes("context"), "expects a context-mapping lane when a scope resolves");
  assert.ok(kinds.includes("capability"), "expects capability-evaluation lanes for route candidates");
  assert.ok(plan.backgroundTasks.some((task) => task.prompt.includes("agent:webhook-monitor")));
  const prompts = plan.backgroundTasks.map((task) => task.prompt);
  assert.equal(new Set(prompts).size, prompts.length);
  assert.equal(plan.backgroundTasks.every((task) => task.timeoutMs >= 180000), true,
    "read-only lanes get the 180s budget, not 90s");
});

test("background runner does not block on optional-only plans", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const plan = {
    mode: "read_only",
    budget: { maxAgents: 2 },
    backgroundTasks: [
      { id: "context-1", kind: "context", prompt: "a", writeScope: [], required: false },
      { id: "scout-1", kind: "implement", prompt: "b", writeScope: [], required: false },
    ],
  };

  const { startBackgroundTasks } = require("../src/background/background-agent-runner");
  const controller = startBackgroundTasks(plan, {
    enabled: true,
    command: "codex",
    stateFile: tempStateFile(),
    async runCommand() {
      await gate;
      return { code: 0, signal: null, stdout: "{}", stderr: "" };
    },
  });

  const required = await controller.requiredPromise;
  assert.deepEqual(required, [], "optional-only plans must not block the caller");
  release();
  const all = await controller.allPromise;
  assert.equal(all.length, 2);
});

test("background runner is provider-affine: claude caller spawns claude sidecars without env flags", async () => {
  const { runBackgroundTasks: runTasks } = require("../src/background/background-agent-runner");
  const results = await runTasks({
    mode: "read_only",
    budget: { maxAgents: 1 },
    backgroundTasks: [{ id: "context-1", kind: "context", prompt: "inspect", writeScope: [] }],
  }, {
    enabled: true,
    command: "claude",
    callerProvider: "claude",
    stateFile: tempStateFile(),
    env: { PATH: "/bin" },
    async runCommand({ invocation }) {
      assert.equal(invocation.kind, "claude");
      assert.ok(invocation.args.includes("plan"));
      return { code: 0, signal: null, stdout: JSON.stringify({ result: "claude finding" }), stderr: "" };
    },
  });

  assert.equal(results[0].status, "completed");
  assert.equal(results[0].runner, "claude");
});

test("background runner refuses cross-provider mixing when a caller provider is declared", async () => {
  const { runBackgroundTasks: runTasks } = require("../src/background/background-agent-runner");
  const results = await runTasks({
    mode: "read_only",
    budget: { maxAgents: 1 },
    backgroundTasks: [{ id: "context-1", kind: "context", prompt: "inspect", writeScope: [] }],
  }, {
    enabled: true,
    command: "codex",
    callerProvider: "claude",
    stateFile: tempStateFile(),
    env: { PATH: "/bin" },
    async runCommand() {
      throw new Error("cross-provider sidecar must not execute");
    },
  });

  assert.equal(results[0].status, "skipped");
  assert.match(results[0].summary, /cross-provider mixing is disabled/);
});

test("structured findings contract is parsed from sidecar output", () => {
  const { parseStructuredFindings, buildReadOnlyPrompt: readOnlyPrompt } = require("../src/background/background-agent-runner");

  assert.match(readOnlyPrompt({ prompt: "x" }), /"findings"/);

  const parsed = parseStructuredFindings([
    "Some prose about the investigation.",
    '{"findings":[{"file":"agents/shared/bot-runtime.js","note":"runBotTask awaits required sidecars"}],"risks":["state pin"],"checks":["node --test"],"confidence":"high"}',
  ].join("\n"));
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].file, "agents/shared/bot-runtime.js");
  assert.deepEqual(parsed.risks, ["state pin"]);
  assert.equal(parsed.confidence, "high");
  assert.equal(parseStructuredFindings("no json here"), null);
});

test("background digest includes findings and an artifact pointer", () => {
  const { buildBackgroundDigest: digest } = require("../src/background/background-agent-runner");
  const text = digest([
    {
      taskId: "context-1",
      runner: "codex",
      mode: "read_only",
      status: "completed",
      summary: "mapped the surface",
      findings: [{ file: "a.js", note: "entry point" }],
    },
  ], { artifactPath: "/tmp/sidecar-results/run.json" });

  assert.match(text, /a\.js: entry point/);
  assert.match(text, /Full sidecar results: \/tmp\/sidecar-results\/run\.json/);
});

test("parallelization budget is decoupled from goal scale", () => {
  const base = {
    branch: "fallback",
    actionType: "write",
    route: { lane: "worker_skill" },
    searchScope: "/tmp/scope",
  };
  const scale3 = buildParallelizationPlan("fix the runtime and verify the tests", { ...base, goalScale: 3 }, { parallelizationStage: cleanStage() });
  const scale4 = buildParallelizationPlan("fix the runtime and verify the tests", { ...base, goalScale: 4 }, { parallelizationStage: cleanStage() });

  assert.equal(scale3.backgroundTasks.length, scale4.backgroundTasks.length);
});

test("MYOS_BACKGROUND_AGENTS_ENABLED=0 disables planner fan-out entirely", () => {
  const plan = buildParallelizationPlan("Fix the dispatch runtime, verify the tests, and review the rollout risk", {
    branch: "fallback",
    actionType: "write",
    route: { lane: "worker_skill" },
  }, {
    parallelizationStage: cleanStage(),
    env: { MYOS_BACKGROUND_AGENTS_ENABLED: "0" },
  });

  assert.equal(plan.mode, "none");
  assert.equal(plan.reason, "background_agents_disabled_by_env");
  assert.equal(plan.backgroundTasks.length, 0);
  assert.ok(plan.blockedReasons.includes("background_agents_disabled"));
  assert.equal(plan.execution.enabledByDefault, false);
  assert.equal(compactParallelizationPlan(plan).execution.enabledByDefault, false);
});

test("background runner enforces MYOS_BACKGROUND_AGENTS_ENABLED=0 even when caller passes enabled=true", async () => {
  const plan = buildParallelizationPlan("Fix the dispatch runtime, verify the tests, and review the rollout risk", {
    branch: "fallback",
    actionType: "write",
    route: { lane: "worker_skill" },
  }, {
    parallelizationStage: cleanStage({ MYOS_PARALLELIZATION_VERSION: "v2" }),
  });

  assert.ok(plan.backgroundTasks.length > 0);
  let spawned = 0;
  const results = await runBackgroundTasks(plan, {
    enabled: true,
    command: "codex",
    env: { MYOS_BACKGROUND_AGENTS_ENABLED: "0" },
    async runCommand() {
      spawned += 1;
      return { code: 0, signal: null, stdout: "", stderr: "" };
    },
  });

  assert.equal(spawned, 0);
  assert.equal(results.length, plan.backgroundTasks.length);
  assert.equal(results.every((result) => result.status === "planned"), true);
  assert.match(results[0].summary, /MYOS_BACKGROUND_AGENTS_ENABLED=0/);
});

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.MYOS_MODEL_CATALOG_LOCAL = process.env.MYOS_MODEL_CATALOG_LOCAL || "/nonexistent/model-catalog.local.json";
const routing = require("../src/myos-routing");

function tempLaneStatePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "myos-routing-lane-")), "lane.json");
}

function writeLaneStateFile(state) {
  const target = tempLaneStatePath();
  fs.writeFileSync(target, JSON.stringify(state, null, 2), "utf8");
  return target;
}

function withEnv(env, fn) {
  const previous = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(env)) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    });
}

test("normalizes task classes and falls back unknown values to default automation", () => {
  assert.ok(routing.CANONICAL_TASK_CLASSES.includes("cheap_routing"));
  assert.deepEqual(routing.COMPLIANCE_LANES, [
    "interactive_oauth",
    "unattended_api",
    "unattended_local",
  ]);

  assert.equal(routing.normalizeTaskClass(" planning "), "planning");
  assert.equal(routing.normalizeTaskClass("HEAVY_SYNTHESIS"), "heavy_synthesis");
  assert.equal(routing.normalizeTaskClass("missing_task_class"), "default_automation");
  assert.equal(routing.normalizeTaskClass(null), "default_automation");
  assert.equal(routing.isCanonicalTaskClass("audio_transcription"), true);
  assert.equal(routing.isCanonicalTaskClass("unknown"), false);
});

test("derives compliance lanes from explicit lane, auth mode, execution policy, audio, and defaults", () => {
  assert.equal(
    routing.deriveComplianceLane({ complianceLane: " unattended_local " }),
    "unattended_local",
  );
  assert.equal(
    routing.deriveComplianceLane({ executionPolicy: "interactive_session" }),
    "interactive_oauth",
  );
  assert.equal(routing.deriveComplianceLane({ authMode: "oauth" }), "interactive_oauth");
  assert.equal(
    routing.deriveComplianceLane({ taskClass: "audio_transcription", audio: { filePath: "/tmp/a.wav" } }),
    "unattended_local",
  );
  assert.equal(routing.deriveComplianceLane({ taskClass: "planning" }), "unattended_api");
  assert.throws(
    () => routing.deriveComplianceLane({ complianceLane: "side_channel" }),
    /Unsupported MyOS compliance lane/,
  );
});

test("resolves representative task-class execution plans without lane overrides", () =>
  withEnv({ MYOS_LANE_STATE_PATH: tempLaneStatePath() }, () => {
    const planning = routing.resolveExecutionPlan({
      taskClass: "planning",
      complianceLane: "unattended_api",
    });

    assert.equal(planning.taskClass, "planning");
    assert.equal(planning.complianceLane, "unattended_api");
    assert.equal(planning.routeKey, "planning");
    assert.equal(planning.routingSource, "taskClass");
    assert.equal(planning.deterministicBypassReason, null);
    assert.deepEqual(
      planning.candidates.map((candidate) => [candidate.type, candidate.provider, candidate.profile, candidate.authMode]),
      [
        ["llm", "google", "google_heavy_reasoning", "api"],
        ["llm", "openai", "heavy_synthesis", "api"],
        ["llm", "openai", "default_automation", "api"],
      ],
    );

    const cheapJson = routing.resolveExecutionPlan({
      taskClass: "cheap_routing",
      complianceLane: "unattended_api",
      responseMode: "json",
    });
    assert.equal(cheapJson.candidates[0].provider, "openai");
    assert.equal(cheapJson.candidates[0].model, "gpt-5-mini");

    const fallback = routing.resolveExecutionPlan({
      taskClass: "planning",
      intent: "planning_evaluation",
      complianceLane: "unattended_api",
    });
    assert.equal(fallback.routingSource, "taskClass_fallback");
    assert.equal(fallback.routeKey, "planning");
  }));

test("resolves audio transcription deterministic candidates only when audio is present", () =>
  withEnv({ MYOS_LANE_STATE_PATH: tempLaneStatePath() }, () => {
    const missingAudio = routing.resolveExecutionPlan({
      taskClass: "audio_transcription",
      complianceLane: "unattended_local",
    });
    assert.equal(missingAudio.deterministicBypassReason, "audio_input_missing");
    assert.deepEqual(missingAudio.candidates, []);

    const withAudio = routing.resolveExecutionPlan({
      taskClass: "audio_transcription",
      complianceLane: "unattended_local",
      audio: { buffer: Buffer.from("stub audio") },
    });
    assert.equal(withAudio.deterministicBypassReason, null);
    assert.deepEqual(withAudio.candidates, [{ type: "deterministic", tool: "mlx_whisper_local" }]);
  }));

test("explicit provider overrides produce a single LLM candidate", () => {
  const plan = routing.resolveExecutionPlan({
    taskClass: "heavy_synthesis",
    complianceLane: "interactive_oauth",
    pinnedProvider: "OpenAI",
    model: "gpt-5.4",
    profile: "custom_profile",
  });

  assert.equal(plan.routingSource, "explicit_override");
  assert.equal(plan.routeKey, "heavy_synthesis");
  assert.deepEqual(plan.candidates, [
    {
      type: "llm",
      provider: "openai",
      profile: "custom_profile",
      model: "gpt-5.4",
      authMode: "oauth",
    },
  ]);
});

test("intent routes can select interactive OAuth planning evaluation candidates", () =>
  withEnv({ MYOS_LANE_STATE_PATH: tempLaneStatePath() }, () => {
    const plan = routing.resolveExecutionPlan({
      taskClass: "planning",
      intent: "planning_evaluation",
      complianceLane: "interactive_oauth",
      executionPolicy: "interactive_session",
      authMode: "oauth",
    });

    assert.equal(plan.routingSource, "intent");
    assert.equal(plan.routeKey, "planning_evaluation");
    assert.deepEqual(plan.candidates, [
      {
        type: "llm",
        provider: "openai",
        profile: "heavy_synthesis",
        model: "gpt-5.5",
        authMode: "oauth",
      },
    ]);
  }));

test("lane state route overrides replace configured task-class candidates", () =>
  withEnv(
    {
      MYOS_LANE_STATE_PATH: writeLaneStateFile({
        authMode: "api",
        apiProvider: "openai",
        routeOverrides: {
          planning: {
            unattended_api: {
              llmTargets: [
                {
                  type: "llm",
                  provider: "openai",
                  profile: "override_planning",
                  model: "gpt-override",
                  authMode: "api",
                },
              ],
              acceptanceThreshold: "override_threshold",
            },
          },
        },
      }),
    },
    () => {
      const plan = routing.resolveExecutionPlan({
        taskClass: "planning",
        complianceLane: "unattended_api",
      });

      assert.equal(plan.routingSource, "taskClass");
      assert.deepEqual(plan.candidates, [
        {
          type: "llm",
          provider: "openai",
          profile: "override_planning",
          model: "gpt-override",
          authMode: "api",
        },
      ]);
    },
  ));

test("validates accepted and rejected execution candidates", () =>
  withEnv({ MYOS_LANE_STATE_PATH: tempLaneStatePath() }, () => {
    const plan = routing.resolveExecutionPlan({
      taskClass: "cheap_routing",
      complianceLane: "unattended_api",
    });

    assert.doesNotThrow(() => routing.validateExecutionCandidate(plan, plan.candidates[0], { authMode: "api" }));
    assert.throws(
      () => routing.validateExecutionCandidate(plan, plan.candidates[0], { authMode: "oauth" }),
      /unattended work cannot run with oauth/,
    );
    assert.throws(
      () => routing.validateExecutionCandidate(plan, { type: "llm", provider: "claude" }, { authMode: "api" }),
      /Legacy Claude providers/,
    );
    assert.throws(
      () =>
        routing.validateExecutionCandidate(
          plan,
          { type: "llm", provider: "anthropic", profile: "anthropic_advisor" },
          { authMode: "api" },
        ),
      /Fable advisory routing is OAuth-only/,
    );
    assert.throws(
      () =>
        routing.validateExecutionCandidate(
          { routeKey: "empty", complianceLane: "unattended_api" },
          null,
          { authMode: "api" },
        ),
      /No MyOS candidates available/,
    );
  }));

test("validates deterministic candidate approval and audio requirements", () =>
  withEnv({ MYOS_LANE_STATE_PATH: tempLaneStatePath() }, () => {
    const plan = routing.resolveExecutionPlan({
      taskClass: "audio_transcription",
      complianceLane: "unattended_local",
      audio: { filePath: "/tmp/sample.wav" },
    });

    assert.doesNotThrow(() =>
      routing.validateExecutionCandidate(plan, plan.candidates[0], {
        authMode: "api",
        audio: { buffer: Buffer.from("audio") },
      }),
    );
    assert.throws(
      () => routing.validateExecutionCandidate(plan, plan.candidates[0], { authMode: "api" }),
      /requires audio input/,
    );
    assert.throws(
      () =>
        routing.validateExecutionCandidate(
          { ...plan, taskClass: "planning" },
          plan.candidates[0],
          { authMode: "api", audio: { buffer: Buffer.from("audio") } },
        ),
      /not approved for planning/,
    );
  }));

test("validates OAuth, auth mismatch, provider, type, and deterministic lane rejections", () =>
  withEnv({ MYOS_LANE_STATE_PATH: tempLaneStatePath() }, () => {
    const oauthPlan = routing.resolveExecutionPlan({
      taskClass: "planning",
      intent: "planning_evaluation",
      complianceLane: "interactive_oauth",
      executionPolicy: "interactive_session",
      authMode: "oauth",
    });
    assert.throws(
      () => routing.validateExecutionCandidate(oauthPlan, oauthPlan.candidates[0], { authMode: "api" }),
      /interactive_oauth routes require oauth auth mode/,
    );

    const apiPlan = routing.resolveExecutionPlan({
      taskClass: "cheap_routing",
      complianceLane: "unattended_api",
    });
    assert.throws(
      () =>
        routing.validateExecutionCandidate(
          apiPlan,
          { type: "llm", provider: "openai", profile: "cheap_routing", authMode: "oauth" },
          { authMode: "api" },
        ),
      /requires auth_mode=oauth, got api/,
    );
    assert.throws(
      () =>
        routing.validateExecutionCandidate(
          oauthPlan,
          { type: "llm", provider: "anthropic", profile: "anthropic_advisor", authMode: "oauth" },
          { authMode: "oauth" },
        ),
      /Anthropic OAuth execution is not implemented/,
    );
    assert.throws(
      () => routing.validateExecutionCandidate(apiPlan, { type: "worker", name: "not-supported" }, { authMode: "api" }),
      /Unsupported MyOS candidate type: worker/,
    );

    const deterministicPlan = routing.resolveExecutionPlan({
      taskClass: "audio_transcription",
      complianceLane: "unattended_local",
      audio: { buffer: Buffer.from("audio") },
    });
    assert.throws(
      () =>
        routing.validateExecutionCandidate(
          { ...deterministicPlan, complianceLane: "unattended_api" },
          deterministicPlan.candidates[0],
          { authMode: "api", audio: { buffer: Buffer.from("audio") } },
        ),
      /not approved for unattended_api/,
    );
  }));

test("deterministic transcription path uses test stub and rejects unsupported tools", async () => {
  await withEnv({ MYOS_TEST_AUDIO_TRANSCRIPTION_TEXT: "stub transcript" }, async () => {
    const result = await routing.executeDeterministicCandidate(
      { type: "deterministic", tool: "mlx_whisper_local" },
      { audio: { buffer: Buffer.from("audio") } },
    );

    assert.deepEqual(result, {
      text: "stub transcript",
      raw: { tool: "mlx_whisper_local", stubbed: true },
      usage: { inputTokens: 0, outputTokens: 0 },
      meta: { id: "mlx_whisper_local", type: "deterministic" },
    });
  });

  await assert.rejects(
    () => routing.executeDeterministicCandidate({ type: "deterministic", tool: "not_real" }),
    /Unsupported deterministic tool/,
  );
});

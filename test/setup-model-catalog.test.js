const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const setup = require("../scripts/setup-model-catalog");
const routing = require("../src/myos-routing");
const { resolveModelCatalogLocalPath } = require("../src/myos-compat");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeProbes({
  cli = [],
  envKeys = [],
  ollama = false,
  ollamaModels = [],
  mlxWhisper = false,
  now = new Date("2026-07-21T00:00:00.000Z"),
} = {}) {
  const cliSet = new Set(cli);
  const envSet = new Set(envKeys);
  return {
    cliAvailable(command) {
      if (command === "ollama") return ollama;
      return cliSet.has(command);
    },
    envHas(key) {
      return envSet.has(key);
    },
    ollamaModels() {
      return ollama ? ollamaModels : [];
    },
    mlxWhisperAvailable() {
      return mlxWhisper;
    },
    now() {
      return now;
    },
  };
}

test("detection covers oauth-only, api-only, both, nothing, and ollama-only", () => {
  const oauthOnly = setup.buildModelCatalog({
    homeRoot: "/tmp/myos",
    probes: fakeProbes({ cli: ["codex"] }),
  });
  assert.deepEqual(oauthOnly.providers.openai, {
    oauthCli: "codex",
    oauth: true,
    apiKey: false,
  });
  assert.strictEqual(oauthOnly.providers.google, undefined);

  const apiOnly = setup.buildModelCatalog({
    homeRoot: "/tmp/myos",
    probes: fakeProbes({ envKeys: ["OPENAI_API_KEY"] }),
  });
  assert.deepEqual(apiOnly.providers.openai, {
    oauthCli: undefined,
    oauth: false,
    apiKey: true,
  });

  const both = setup.buildModelCatalog({
    homeRoot: "/tmp/myos",
    probes: fakeProbes({ cli: ["codex"], envKeys: ["OPENAI_API_KEY"] }),
  });
  assert.deepEqual(both.providers.openai, {
    oauthCli: "codex",
    oauth: true,
    apiKey: true,
  });

  const nothing = setup.buildModelCatalog({
    homeRoot: "/tmp/myos",
    probes: fakeProbes(),
  });
  assert.deepEqual(nothing.providers, {});
  assert.equal(nothing.local.ollama.available, false);
  assert.equal(nothing.local.mlxWhisper.available, false);

  const ollamaOnly = setup.buildModelCatalog({
    homeRoot: "/tmp/myos",
    probes: fakeProbes({ ollama: true, ollamaModels: ["llama3.2", "mistral"], mlxWhisper: true }),
  });
  assert.equal(ollamaOnly.local.ollama.available, true);
  assert.deepEqual(ollamaOnly.local.ollama.models, ["llama3.2", "mistral"]);
  assert.equal(ollamaOnly.local.mlxWhisper.available, true);
});

test("assignment prefers oauth lane before api lane when both exist", () => {
  const catalog = setup.buildModelCatalog({
    homeRoot: "/tmp/myos",
    probes: fakeProbes({ cli: ["codex"], envKeys: ["OPENAI_API_KEY"] }),
  });

  assert.equal(catalog.assignments.cheap_routing.lane, "interactive_oauth");
  assert.equal(catalog.assignments.cheap_routing.authMode, "oauth");
  assert.equal(catalog.assignments.cheap_routing.provider, "openai");
  assert.equal(catalog.assignments.default_automation.lane, "interactive_oauth");
});

test("every canonical task class gets either an assignment or an unassigned hint", () => {
  const catalog = setup.buildModelCatalog({
    homeRoot: "/tmp/myos",
    probes: fakeProbes(),
  });

  for (const taskClass of routing.CANONICAL_TASK_CLASSES) {
    const entry = catalog.assignments[taskClass];
    assert.ok(entry, `missing assignment for ${taskClass}`);
    if (entry.unassigned) {
      assert.equal(typeof entry.reason, "string");
      assert.equal(typeof entry.enableWith, "string");
      assert.notEqual(entry.enableWith.trim(), "");
    } else {
      assert.equal(typeof entry.provider, "string");
      assert.equal(typeof entry.model, "string");
      assert.equal(typeof entry.profile, "string");
      assert.equal(typeof entry.authMode, "string");
      assert.equal(typeof entry.lane, "string");
      assert.equal(entry.source, "auto");
    }
  }
});

test("overrides are preserved verbatim across re-runs", () => {
  const homeRoot = tempDir("myos-catalog-home-");
  const targetPath = resolveModelCatalogLocalPath(homeRoot);
  const overrides = {
    planning: {
      llmTargets: [
        {
          type: "llm",
          provider: "openai",
          profile: "heavy_synthesis",
          model: "openai.gpt-5.4",
          authMode: "api",
        },
      ],
    },
  };

  const first = {
    version: 1,
    generatedAt: "2026-07-20T00:00:00.000Z",
    providers: {},
    local: {
      ollama: { available: false, models: [] },
      mlxWhisper: { available: false },
    },
    assignments: {},
    overrides,
  };

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(first, null, 2)}\n`, "utf8");

  const existing = JSON.parse(fs.readFileSync(targetPath, "utf8"));
  const next = setup.buildModelCatalog({
    homeRoot,
    probes: fakeProbes({ cli: ["codex"] }),
    existing,
  });
  assert.deepEqual(next.overrides, overrides);

  setup.writeModelCatalog(targetPath, next);
  const reread = JSON.parse(fs.readFileSync(targetPath, "utf8"));
  assert.deepEqual(reread.overrides, overrides);
});

test("report contains the exact closing sentence and no em dash", () => {
  const catalog = setup.buildModelCatalog({
    homeRoot: "/tmp/myos",
    probes: fakeProbes({ cli: ["codex"], envKeys: ["OPENAI_API_KEY"] }),
  });

  const report = setup.renderReport(catalog);
  const closing = "Here are the task classes. I've assigned them to these models. Let me know if you would like to change any of them.";

  assert.ok(report.includes(closing));
  assert.ok(report.includes("These are the models I identified as available on this machine:"));
  assert.ok(report.includes("I've made my best guess assigning the eight task classes to them:"));
  assert.ok(report.includes("- openai: codex CLI signed in on this machine, plus an API key in your environment"));
  assert.ok(!report.includes("—"));
});

test("report names local runtimes and handles the nothing-detected case", () => {
  const nothing = setup.renderReport(setup.buildModelCatalog({
    homeRoot: "/tmp/myos",
    probes: fakeProbes(),
  }));
  assert.ok(nothing.includes("- none yet: no provider CLIs, API keys, or local runtimes were detected"));

  const localOnly = setup.renderReport(setup.buildModelCatalog({
    homeRoot: "/tmp/myos",
    probes: fakeProbes({ ollama: true, ollamaModels: ["llama3.2"], mlxWhisper: true }),
  }));
  assert.ok(localOnly.includes("- local: ollama (llama3.2)"));
  assert.ok(localOnly.includes("- local: mlx_whisper for on-device transcription"));
});

test("routing honors overrides, ignores invalid overrides, and falls back when the file is absent or corrupt", () => {
  const homeRoot = tempDir("myos-routing-home-");
  const localPath = path.join(homeRoot, "catalog.json");
  const lanePath = path.join(homeRoot, "lane.json");
  const baseEnv = {
    MYOS_MODEL_CATALOG_LOCAL: localPath,
    MYOS_LANE_STATE_PATH: lanePath,
  };

  function resolvePlanning() {
    return routing.resolveExecutionPlan({
      taskClass: "planning",
      complianceLane: "unattended_api",
    });
  }

  routing.clearLocalAssignmentsCache();
  process.env.MYOS_MODEL_CATALOG_LOCAL = localPath;
  process.env.MYOS_LANE_STATE_PATH = baseEnv.MYOS_LANE_STATE_PATH;
  const expectedBase = resolvePlanning();

  const overrideFile = {
    version: 1,
    generatedAt: "2026-07-21T00:00:00.000Z",
    providers: {},
    local: { ollama: { available: false, models: [] }, mlxWhisper: { available: false } },
    assignments: {},
    overrides: {
      planning: {
        llmTargets: [
          {
            type: "llm",
            provider: "openai",
            profile: "heavy_synthesis",
            model: "openai.gpt-5.4",
            authMode: "api",
          },
        ],
      },
    },
  };
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, `${JSON.stringify(overrideFile, null, 2)}\n`, "utf8");
  routing.clearLocalAssignmentsCache();
  const overridePlan = resolvePlanning();
  assert.equal(overridePlan.candidates.length, 1);
  assert.equal(overridePlan.candidates[0].provider, "openai");
  assert.equal(overridePlan.candidates[0].profile, "heavy_synthesis");
  assert.equal(overridePlan.candidates[0].model, "openai.gpt-5.4");

  fs.writeFileSync(
    localPath,
    `${JSON.stringify({
      ...overrideFile,
      overrides: {
        planning: {
          llmTargets: [
            {
              type: "llm",
              provider: "not-a-provider",
              profile: "missing",
              model: "missing",
              authMode: "api",
            },
          ],
        },
      },
    }, null, 2)}\n`,
    "utf8"
  );
  routing.clearLocalAssignmentsCache();
  const invalidPlan = resolvePlanning();
  assert.deepEqual(invalidPlan.candidates, expectedBase.candidates);

  fs.rmSync(localPath);
  routing.clearLocalAssignmentsCache();
  const absentPlan = resolvePlanning();
  assert.deepEqual(absentPlan.candidates, expectedBase.candidates);

  fs.writeFileSync(localPath, "{ this is not valid json", "utf8");
  routing.clearLocalAssignmentsCache();
  const corruptPlan = resolvePlanning();
  assert.deepEqual(corruptPlan.candidates, expectedBase.candidates);

  routing.clearLocalAssignmentsCache();
  delete process.env.MYOS_MODEL_CATALOG_LOCAL;
  delete process.env.MYOS_LANE_STATE_PATH;
});

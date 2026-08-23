const test = require("node:test");
// Isolate live telemetry: tests must never append to the real dispatcher events ledger or health state.
process.env.MYOS_DISPATCHER_EVENTS_FILE = process.env.MYOS_DISPATCHER_EVENTS_FILE || require("node:path").join(require("node:os").tmpdir(), `dispatcher-events-test-${process.pid}.jsonl`);
process.env.MYOS_DISPATCH_HEALTH_STATE_FILE = process.env.MYOS_DISPATCH_HEALTH_STATE_FILE || require("node:path").join(require("node:os").tmpdir(), `dispatch-health-test-${process.pid}.json`);
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Build a fully self-contained fixture workspace with generic recipes so this
// suite never depends on ~/.myos/workspace or any private recipe ids.
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "task-dispatcher-fixture-"));
const WORKSPACE_ROOT = path.join(FIXTURE_ROOT, "workspace");
const CORE_RECIPES_DIR = path.join(WORKSPACE_ROOT, "agents", "shared", "recipes", "core");
const PROJECT_RECIPES_DIR = path.join(WORKSPACE_ROOT, "projects", "acme", "recipes");
fs.mkdirSync(CORE_RECIPES_DIR, { recursive: true });
fs.mkdirSync(PROJECT_RECIPES_DIR, { recursive: true });

fs.writeFileSync(
  path.join(WORKSPACE_ROOT, "projects", "_index.json"),
  JSON.stringify({ projects: { acme: { path: "acme", name: "Acme", aliases: ["acme"] } } }),
  "utf8",
);

// Generic core recipe: freeform note.
fs.writeFileSync(
  path.join(CORE_RECIPES_DIR, "make-note.js"),
  "module.exports.runRecipe = async (input) => ({ reply: `note: ${input.text || ''}` });\n",
  "utf8",
);
fs.writeFileSync(
  path.join(CORE_RECIPES_DIR, "make-note.recipe.json"),
  JSON.stringify({
    id: "core/make-note",
    layer: "core",
    owner: "shared",
    title: "Make Note",
    tags: ["note"],
    phrases: ["make a note", "note"],
    inputMode: "freeform",
    outputMode: "text",
    handler: "./make-note.js",
  }),
  "utf8",
);

// Generic project recipe: structured, create-only.
fs.writeFileSync(
  path.join(PROJECT_RECIPES_DIR, "acme-note.js"),
  "module.exports.runRecipe = async () => ({ reply: 'acme note created' });\n",
  "utf8",
);
fs.writeFileSync(
  path.join(PROJECT_RECIPES_DIR, "acme-note.recipe.json"),
  JSON.stringify({
    id: "project/acme/acme-note",
    layer: "project",
    owner: "acme",
    title: "Acme Note",
    tags: ["note"],
    phrases: ["acme note"],
    objects: ["note"],
    actions: ["create"],
    inputMode: "structured",
    outputMode: "text",
    requiredTextPatterns: ["acme note"],
    handler: "./acme-note.js",
  }),
  "utf8",
);

process.env.MYOS_WORKSPACE = WORKSPACE_ROOT;

const {
  dispatchTask,
  dispatchTaskWithBackground,
  getRecipeRegistry,
  inferRequestIntent,
  listCandidateRecipes,
  pickRecipe,
  refreshRecipeRegistry,
  runRecipe,
  scoreRecipe,
  validateRecipeCandidate,
} = require("../src/task-dispatcher");

test("registry loads core and project recipes from the configured workspace", () => {
  const registry = getRecipeRegistry();
  assert.ok(registry.byId.has("core/make-note"));
  assert.ok(registry.byId.has("project/acme/acme-note"));
});

test("project recipe outranks core recipe when project context is present", () => {
  const registry = getRecipeRegistry();
  const projectRecipe = registry.byId.get("project/acme/acme-note");
  const coreRecipe = registry.byId.get("core/make-note");
  const request = { text: "make an acme note that says hello" };

  const chosen = pickRecipe(request);
  assert.equal(chosen.recipe.id, "project/acme/acme-note");
  assert.ok(scoreRecipe(projectRecipe, request, "acme") > scoreRecipe(coreRecipe, request, "acme"));
});

test("core recipe matches generic requests without project context", () => {
  const chosen = pickRecipe({ text: "make a note that says hello world" });
  assert.equal(chosen.recipe.id, "core/make-note");
});

test("intent inference distinguishes create from retrieve", () => {
  const createIntent = inferRequestIntent({ text: "create a note that says hello world" });
  const retrieveIntent = inferRequestIntent({
    text: "I created a note yesterday and need to get the URL from it",
  });

  assert.equal(createIntent.primaryAction, "create");
  assert.equal(createIntent.confidence, "high");
  assert.equal(retrieveIntent.primaryAction, "retrieve");
  assert.notEqual(retrieveIntent.confidence, "low");
});

test("create-only project recipe is rejected for retrieval-style requests", () => {
  const registry = getRecipeRegistry();
  const recipe = registry.byId.get("project/acme/acme-note");
  const candidate = { recipe, inferredProject: "acme", score: 63, evidenceScore: 30, directEvidenceScore: 18 };

  const validation = validateRecipeCandidate(candidate, {
    text: "I created an acme note yesterday and need to get the URL from it",
  });

  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "action_mismatch");
});

test("structured project recipes require recipe-specific evidence beyond project context", () => {
  const registry = getRecipeRegistry();
  const recipe = registry.byId.get("project/acme/acme-note");
  const candidate = { recipe, inferredProject: "acme", score: 58, evidenceScore: 3 };

  const validation = validateRecipeCandidate(candidate, {
    text: "can you help with the acme website",
  });

  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "weak_project_match");
});

test("registry skips malformed manifests during refresh", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-registry-"));
  const validDir = path.join(tempRoot, "valid");
  const invalidDir = path.join(tempRoot, "invalid");
  fs.mkdirSync(validDir, { recursive: true });
  fs.mkdirSync(invalidDir, { recursive: true });

  fs.writeFileSync(
    path.join(validDir, "hello.js"),
    "module.exports.runRecipe = async () => ({ reply: 'ok' });\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(validDir, "hello.recipe.json"),
    JSON.stringify({
      id: "core/test-valid",
      layer: "core",
      owner: "shared",
      title: "Valid recipe",
      tags: ["test"],
      phrases: ["valid recipe"],
      inputMode: "freeform",
      outputMode: "text",
      handler: "./hello.js",
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(invalidDir, "broken.recipe.json"),
    JSON.stringify({
      id: "core/test-invalid",
      layer: "core",
      owner: "shared",
      title: "Broken recipe",
      phrases: "not-an-array",
      handler: "./missing.js",
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(invalidDir, "missing-actions.js"),
    "module.exports.runRecipe = async () => ({ reply: 'ok' });\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(invalidDir, "missing-actions.recipe.json"),
    JSON.stringify({
      id: "project/test-structured-no-actions",
      layer: "project",
      owner: "test",
      title: "Broken structured recipe",
      tags: ["test"],
      inputMode: "structured",
      outputMode: "text",
      handler: "./missing-actions.js",
    }),
    "utf8",
  );

  const registry = refreshRecipeRegistry({ roots: [tempRoot] });
  assert.ok(registry.byId.has("core/test-valid"));
  assert.ok(!registry.byId.has("core/test-invalid"));
  assert.ok(!registry.byId.has("project/test-structured-no-actions"));
});

test("runRecipe normalizes route metadata for a core recipe", async () => {
  const result = await runRecipe("core/make-note", {
    chatId: "test-chat",
    text: "make a note that says hello world",
  });

  assert.equal(result.status, "ok");
  assert.equal(result.recipeId, "core/make-note");
  assert.equal(result.metadata.route.recipeId, "core/make-note");
  assert.equal(result.metadata.route.layer, "core");
  assert.equal(result.metadata.route.owner, "shared");
});

test("dispatchTask persists compact capability adoption evidence", async () => {
  const chatId = `capability-adoption-${Date.now()}`;

  await dispatchTask({
    chatId,
    text: "make a note that says hello world",
    dispatchPlan: {
      branch: "capability",
      capabilityId: "agent:example",
      route: { lane: "recipe_dispatcher" },
    },
  });

  const events = fs.readFileSync(process.env.MYOS_DISPATCHER_EVENTS_FILE, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const event = events.find((candidate) => candidate.chatId === chatId);

  assert.deepEqual(event.outcome.dispatchPlan, {
    branch: "capability",
    route: {
      lane: "recipe_dispatcher",
      capabilityId: "agent:example",
    },
  });
});

test("dispatchTask executes deterministic data lookup lanes without worker fallback", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-dispatcher-data-"));
  const workspaceRoot = path.join(homeDir, ".myos", "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "projects"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({ fastpaths: [] }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "projects", "_index.json"), JSON.stringify({ projects: {} }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");
  const dataSourcesConfig = path.join(workspaceRoot, "data-sources.json");
  fs.writeFileSync(
    dataSourcesConfig,
    JSON.stringify({
      version: 1,
      dataSources: [
        {
          id: "entities",
          label: "entities.md",
          mode: "content",
          path: path.join(workspaceRoot, "data", "entities.md"),
          matchTerms: ["ein", "entity info"],
        },
      ],
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(workspaceRoot, "data", "entities.md"), "# Entities\nExample Holdings LLC\nEIN: 12-3456789\n", "utf8");

  const previousHome = process.env.HOME;
  const previousHomeRoot = process.env.MYOS_HOME_ROOT;
  const previousDataSourcesConfig = process.env.MYOS_DATA_SOURCES_CONFIG;
  process.env.HOME = homeDir;
  process.env.MYOS_HOME_ROOT = homeDir;
  process.env.MYOS_DATA_SOURCES_CONFIG = dataSourcesConfig;
  const dispatcherModulePath = require.resolve("../src/task-dispatcher");
  const workspaceContextPath = require.resolve("../src/workspace-context");
  const dataLookupPath = require.resolve("../src/data-lookup");
  delete require.cache[dispatcherModulePath];
  delete require.cache[workspaceContextPath];
  delete require.cache[dataLookupPath];
  delete require.cache[require.resolve("../src/data-source-registry")];
  delete require.cache[require.resolve("../src/myos-compat")];
  const freshDispatcher = require("../src/task-dispatcher");

  try {
    const result = await freshDispatcher.dispatchTask({
      text: "what's the Example Holdings EIN number",
      dispatchPlan: {
        branch: "data",
        actionType: "read",
        route: { lane: "data_lookup" },
        dataSources: ["entities"],
        searchScope: path.join(workspaceRoot, "data", "entities.md"),
        dataLookupCanary: {
          eligible: true,
          enabled: true,
          reason: "allowlisted_read_only",
          mode: "read_only_allowlist_v1",
          allowedSources: ["entities"],
          blockedSources: [],
        },
      },
    });

    assert.equal(result.recipeId, "data/lookup");
    assert.equal(result.metadata.route.lane, "data_lookup");
    assert.equal(result.metadata.dataLookup.canary.reason, "allowlisted_read_only");
    assert.ok(Number.isInteger(result.metadata.dataLookup.latencyMs));
    assert.match(result.reply, /Example Holdings LLC/);
    assert.match(result.reply, /EIN: 12-3456789/);
  } finally {
    process.env.HOME = previousHome;
    if (previousHomeRoot === undefined) delete process.env.MYOS_HOME_ROOT;
    else process.env.MYOS_HOME_ROOT = previousHomeRoot;
    if (previousDataSourcesConfig === undefined) delete process.env.MYOS_DATA_SOURCES_CONFIG;
    else process.env.MYOS_DATA_SOURCES_CONFIG = previousDataSourcesConfig;
    delete require.cache[dispatcherModulePath];
    delete require.cache[workspaceContextPath];
    delete require.cache[dataLookupPath];
  }
});

test("dispatchTaskWithBackground starts sidecars before direct dispatch", async () => {
  const events = [];
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "task-dispatcher-bg-")), "state.json");
  const result = await dispatchTaskWithBackground({
    text: "what is the safest dispatch route for command creation",
    dispatchPlan: {
      branch: "data",
      actionType: "read",
      route: { lane: "data_lookup" },
      dataSources: [],
      searchScope: "/tmp",
      dataLookupCanary: {
        eligible: true,
        enabled: true,
        reason: "allowlisted_read_only",
        mode: "read_only_allowlist_v1",
        allowedSources: [],
        blockedSources: [],
      },
      parallelizationPlan: {
        mode: "read_only",
        budget: { maxAgents: 1 },
        backgroundTasks: [
          {
            id: "context-map",
            kind: "source_index_scan",
            prompt: "Inspect command creation routing. Do not edit anything.",
            writeScope: [],
            modelProfile: "cheap_routing",
          },
        ],
        modelPolicy: {
          defaultProfile: "cheap_routing",
          rule: "use_lowest_cost_model_that_can_reliably_complete_each_bounded_subtask",
        },
        authPolicy: {
          humanDrivenMode: "oauth",
          backgroundAuthMode: "oauth_only",
          allowedV2Runner: "codex",
        },
      },
    },
  }, {
    backgroundWorkerCommand: "codex",
    parallelizationStateFile: stateFile,
    async backgroundRunCommand() {
      events.push("background");
      return {
        code: 0,
        signal: null,
        stdout: JSON.stringify({
          type: "item.completed",
          item: {
            type: "assistant_message",
            content: [{ type: "output_text", text: "sidecar finding" }],
          },
        }),
        stderr: "",
      };
    },
  });

  events.push("after-dispatch");
  assert.deepEqual(events, ["background", "after-dispatch"]);
  assert.equal(result.recipeId, "data/lookup");
  assert.equal(result.metadata.parallelization.plan.mode, "read_only");
  assert.equal(result.metadata.parallelization.plan.backgroundTasks[0].prompt, undefined);
  assert.equal(result.metadata.parallelization.results[0].status, "completed");
  assert.equal(result.metadata.parallelization.results[0].runner, "codex");
});

test("dispatchTask skips data lookup execution when canary is not enabled", async () => {
  await assert.rejects(
    dispatchTask({
      text: "add the payment link to a contact profile",
      dispatchPlan: {
        branch: "data",
        actionType: "write",
        route: { lane: "worker_skill" },
        dataSources: ["crm_contacts"],
        dataLookupCanary: {
          eligible: false,
          enabled: false,
          reason: "non_read_action",
          mode: "read_only_allowlist_v1",
          allowedSources: [],
          blockedSources: ["crm_contacts"],
        },
      },
    }),
    /No matching recipe and no fallback configured/,
  );
});

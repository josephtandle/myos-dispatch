const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function loadWorkspaceContextWithHome(homeDir) {
  process.env.HOME = homeDir;
  const dataSourcesConfig = path.join(homeDir, ".myos", "workspace", "data-sources.json");
  if (fs.existsSync(dataSourcesConfig)) {
    process.env.MYOS_DATA_SOURCES_CONFIG = dataSourcesConfig;
  } else {
    delete process.env.MYOS_DATA_SOURCES_CONFIG;
  }
  const modulePath = require.resolve("../src/workspace-context");
  const registryPath = require.resolve("../src/data-source-registry");
  delete require.cache[modulePath];
  delete require.cache[registryPath];
  return require("../src/workspace-context");
}

// A generic, config-driven data-source registry. The taxonomy (which query
// patterns select which source ids) lives entirely in `matchTerms` here, not in
// the router. No personal source ids, schemas, or queries.
function writeDefaultDataSourcesConfig(workspaceRoot) {
  const IDENTITY_TERMS = [
    "your name", "who are you", "my name", "phone number", "email address",
    "my address", "where do i live", "my office",
  ];
  const STATUS_EXCLUDE = ["are you awake", "are you there", "your status", "whats your status"];
  fs.writeFileSync(
    path.join(workspaceRoot, "data-sources.json"),
    JSON.stringify({
      version: 1,
      dataSources: [
        { id: "user_profile", label: "user-profile.md", mode: "content", path: "USER.md", readOnly: true, matchTerms: IDENTITY_TERMS, excludeTerms: STATUS_EXCLUDE },
        { id: "profile", label: "profile.md", mode: "content", path: "data/profile.md", readOnly: true, matchTerms: IDENTITY_TERMS, excludeTerms: STATUS_EXCLUDE },
        { id: "tax_records", label: "tax-records.md", mode: "content", path: "data/tax-records.md", readOnly: true, matchTerms: ["ein", "tax id", "ssn", "rfc", "bpjs", "ny dos id", "tax number"] },
        { id: "entities", label: "entities.md", mode: "content", path: "data/entities.md", readOnly: true, matchTerms: ["ein", "tax id", "tax number", "entity info", "business entity", "llc", "company info", "business info", "incorporated", "ein number", "company entity info"] },
        { id: "websites", label: "websites.db", mode: "sqlite", path: "data/websites.db", readOnly: true, matchTerms: ["website", "url", "domain", "subdomain", "homepage", "hosting", "vercel"] },
        {
          id: "participants",
          label: "participants.db",
          mode: "sqlite",
          path: "data/participants.db",
          readOnly: true,
          preferOverProject: true,
          matchTerms: ["cohort", "participant", "participants", "signed up", "signups", "signup", "rsvp", "participant database"],
          workerFollowupTerms: ["didn't receive", "did not receive", "not received", "never received", "missing", "problem", "issue", "cannot access", "follow up", "forward", "notify"],
          sqlite: { query: "select * from participants;" },
        },
        { id: "computer_info", label: "computer.md", mode: "content", path: "data/computer.md", readOnly: true, matchTerms: ["monitor", "monitors", "macbook", "computer info", "computer specs", "specs", "serial number", "laptop", "monitor sizes"] },
        {
          id: "crm_contacts",
          label: "crm-contacts.db",
          mode: "sqlite",
          path: "data/crm-contacts.db",
          readOnly: true,
          matchTerms: ["affiliate", "referral", "payment link", "payment method", "payout", "commission", "payment record", "wire instructions"],
          sqlite: { query: "select * from crm_contacts;" },
        },
        {
          id: "payout_methods",
          label: "payout-methods.db",
          mode: "sqlite",
          path: "data/payout-methods.db",
          readOnly: true,
          matchTerms: ["payout", "payment method", "wire instructions", "bank account", "payment link"],
          sqlite: { query: "select * from accounts;" },
        },
        { id: "files", label: "files-index.md", mode: "pointer", path: "data/files-index.md", readOnly: true, matchTerms: ["passport", "document", "file copy", "personal file", "passport copy"] },
      ],
    }),
    "utf8",
  );
}

test("empty data-source config selects no data sources and leaves routing unaffected", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-empty-data-config-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "projects"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });

  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({ fastpaths: [] }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "projects", "_index.json"), JSON.stringify({ projects: {} }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");

  const { buildWorkspaceContextBundle, resolveDispatchPlan } = loadWorkspaceContextWithHome(tmpDir);
  const plan = resolveDispatchPlan("what is my tax ID?");
  const bundle = buildWorkspaceContextBundle("what is my tax ID?");

  assert.deepEqual(plan.dataSources, []);
  assert.notEqual(plan.branch, "data");
  assert.equal(plan.searchScope, "");
  assert.doesNotMatch(bundle, /Data Match:/);
});

test("buildWorkspaceContextBundle surfaces fast paths before deeper lookup", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-fastpath-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "projects"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(
    path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"),
    JSON.stringify({
      fastpaths: [
        {
          intent: "gmail message search or send",
          match_terms: ["send email", "gmail"],
          stop_rule: "Use gog gmail first.",
          reference_path: "TOOLS.md",
          tool_hint: "gog gmail",
        },
      ],
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(workspaceRoot, "projects", "_index.json"), JSON.stringify({ projects: {} }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");

  const { buildWorkspaceContextBundle } = loadWorkspaceContextWithHome(tmpDir);
  const bundle = buildWorkspaceContextBundle("send email to Sam");

  assert.match(bundle, /Dispatch Plan/);
  assert.match(bundle, /Branch: fastpath/);
  assert.match(bundle, /Goal scale: 3 \(ralph\)/);
  assert.match(bundle, /Allow broad search: no/);
  assert.match(bundle, /Dispatch Fast Path: gmail message search or send/);
  assert.match(bundle, /Tool hint: gog gmail/);
  assert.match(bundle, /Stop rule: Use gog gmail first\./);
});

test("shadow dispatch treats recipe fastpaths as evidence without changing legacy authority", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-shadow-recipe-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  const projectDir = path.join(workspaceRoot, "projects", "acme");
  fs.mkdirSync(path.join(projectDir, "recipes", "stripe"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(
    path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"),
    JSON.stringify({
      fastpaths: [
        {
          intent: "acme promo link recipe",
          match_terms: ["promo link", "acme hq"],
          recipe_path: "projects/acme/recipes/stripe/send-promo-link.recipe.json",
        },
      ],
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(workspaceRoot, "projects", "_index.json"),
    JSON.stringify({
      projects: {
        acme: {
          path: "acme",
          name: "Acme HQ",
          aliases: ["acme hq", "acme"],
        },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(projectDir, "recipes", "stripe", "send-promo-link.recipe.json"),
    JSON.stringify({ id: "project/acme/stripe/send-promo-link", actions: ["create"] }),
    "utf8",
  );
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");

  const { resolveDispatchPlan } = loadWorkspaceContextWithHome(tmpDir);
  const plan = resolveDispatchPlan("create the promo link for acme hq");

  assert.equal(plan.branch, "fastpath");
  assert.equal(plan.shadowDispatch.authoritative, false);
  assert.equal(plan.shadowDispatch.plan.branch, "project");
  assert.equal(plan.shadowDispatch.plan.executionLane, "recipe_dispatcher");
  assert.equal(plan.shadowDispatch.plan.evidence.fastpaths[0].targetType, "recipe");
  assert.equal(plan.shadowDispatch.comparison.same, false);
});

test("shadow dispatch comparison keeps simple status prompts lightweight", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-shadow-status-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "projects"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({ fastpaths: [] }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "projects", "_index.json"), JSON.stringify({ projects: {} }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");

  const { formatDispatchShadowComparison, resolveDispatchPlan } = loadWorkspaceContextWithHome(tmpDir);
  const plan = resolveDispatchPlan("are you awake?");
  const report = formatDispatchShadowComparison("are you awake?");

  assert.equal(plan.shadowDispatch.plan.goalScale, 1);
  assert.equal(plan.shadowDispatch.comparison.same, true);
  assert.match(report, /Same: yes/);
  assert.match(report, /Legacy: branch=fallback/);
});

test("promoted typed-evidence shadow can authoritatively fix safe data routes", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-shadow-authority-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "projects"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);
  fs.mkdirSync(path.join(workspaceRoot, "agents", "shared", "data"), { recursive: true });

  fs.writeFileSync(
    path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"),
    JSON.stringify({
      fastpaths: [
        {
          intent: "legacy tax id helper",
          match_terms: ["tax id"],
          tool_hint: "manual worker lookup",
        },
      ],
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(workspaceRoot, "projects", "_index.json"), JSON.stringify({ projects: {} }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "data", "tax-records.md"), "# Tax IDs\n", "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "data", "entities.md"), "# Entities\n", "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "data", "profile.md"), "# Profile\n", "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");
  fs.writeFileSync(
    path.join(workspaceRoot, "agents", "shared", "data", "typed-evidence-shadow-state.json"),
    JSON.stringify({ activeStage: "v2" }),
    "utf8",
  );

  const { resolveDispatchPlan } = loadWorkspaceContextWithHome(tmpDir);
  const plan = resolveDispatchPlan("what is my tax ID?");

  assert.equal(plan.branch, "data");
  assert.equal(plan.route.lane, "data_lookup");
  assert.equal(plan.shadowDispatch.authoritative, true);
  assert.equal(plan.shadowDispatch.authorityDecision.useShadow, true);
  assert.equal(plan.shadowDispatch.comparison.legacy.branch, "fastpath");
});

test("buildProjectSections avoids broad search hits when a direct project match exists", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-project-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  const projectDir = path.join(workspaceRoot, "projects", "acme");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({ fastpaths: [] }), "utf8");
  fs.writeFileSync(
    path.join(workspaceRoot, "projects", "_index.json"),
    JSON.stringify({
      projects: {
        acme: {
          path: "acme",
          name: "Acme HQ",
          aliases: ["acme", "acme hq"],
          agents: ["stripe", "wix"],
        },
      },
    }),
    "utf8",
  );
  fs.mkdirSync(path.join(projectDir, "recipes", "stripe"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "CONTEXT.md"), "# Acme Context\nCanonical site details here.\n", "utf8");
  fs.writeFileSync(path.join(projectDir, "README.md"), "broad search bait\n", "utf8");
  fs.writeFileSync(
    path.join(projectDir, "recipes", "stripe", "send-promo-link.recipe.json"),
    JSON.stringify({
      id: "project/acme/stripe/send-promo-link",
      title: "Send promo link",
      actions: ["create", "retrieve"],
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");

  const { buildWorkspaceContextBundle, resolveDispatchPlan } = loadWorkspaceContextWithHome(tmpDir);
  const plan = resolveDispatchPlan("what is the website for acme hq");
  const bundle = buildWorkspaceContextBundle("what is the website for acme hq");

  assert.equal(plan.branch, "project");
  assert.equal(plan.intentType, "directive");
  assert.equal(plan.allowBroadSearch, false);
  assert.equal(plan.projectRecipeFirst, true);
  assert.match(plan.searchScope, /projects\/acme$/);
  assert.match(bundle, /Branch: project/);
  assert.match(bundle, /Intent type: directive/);
  assert.match(bundle, /Project recipe first: yes/);
  assert.match(bundle, /Project Recipes: Acme HQ \(acme\)/);
  assert.match(bundle, /project\/acme\/stripe\/send-promo-link/);
  assert.match(bundle, /Project Service Agents: Acme HQ \(acme\)/);
  assert.match(bundle, /- stripe/);
  assert.match(bundle, /Project Match: Acme HQ \(acme\)/);
  assert.doesNotMatch(bundle, /CONTEXT\.md:/);
  assert.doesNotMatch(bundle, /Project Search Hit/);
});

test("exploratory project asks load context instead of recipe-first hints", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-exploratory-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  const projectDir = path.join(workspaceRoot, "projects", "acme");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({ fastpaths: [] }), "utf8");
  fs.writeFileSync(
    path.join(workspaceRoot, "projects", "_index.json"),
    JSON.stringify({
      projects: {
        acme: {
          path: "acme",
          name: "Acme HQ",
          aliases: ["acme", "acme hq"],
        },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(projectDir, "CONTEXT.md"), "# Acme Context\nOnboarding flow details.\n", "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");

  const { buildWorkspaceContextBundle, resolveDispatchPlan } = loadWorkspaceContextWithHome(tmpDir);
  const plan = resolveDispatchPlan("help me understand acme onboarding");
  const bundle = buildWorkspaceContextBundle("help me understand acme onboarding");

  assert.equal(plan.branch, "project");
  assert.equal(plan.intentType, "exploratory");
  assert.equal(plan.projectRecipeFirst, false);
  assert.equal(plan.parallelizationPlan.mode, "read_only");
  assert.ok(plan.parallelizationPlan.backgroundTasks.length >= 1);
  assert.match(bundle, /Intent type: exploratory/);
  assert.match(bundle, /Project recipe first: no/);
  assert.match(bundle, /Parallelization: myos-parallelization-(writable-v1|v\d) read_only/);
  assert.match(bundle, /CONTEXT\.md:/);
});

test("factual project lookups count as directives", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-factual-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  const projectDir = path.join(workspaceRoot, "projects", "acme");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({ fastpaths: [] }), "utf8");
  fs.writeFileSync(
    path.join(workspaceRoot, "projects", "_index.json"),
    JSON.stringify({
      projects: {
        acme: {
          path: "acme",
          name: "Acme HQ",
          aliases: ["acme hq", "acme"],
        },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(projectDir, "CONTEXT.md"), "# Acme Context\nGiveaway page details.\n", "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");

  const { resolveDispatchPlan } = loadWorkspaceContextWithHome(tmpDir);
  const plan = resolveDispatchPlan("what's the giveaways page for acme hq");

  assert.equal(plan.branch, "project");
  assert.equal(plan.intentType, "directive");
  assert.equal(plan.projectRecipeFirst, true);
});

test("entity tax ID lookups route to the data branch", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-data-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "projects"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({ fastpaths: [] }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "projects", "_index.json"), JSON.stringify({ projects: {} }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "USER.md"), "# User\n", "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "data", "tax-records.md"), "# Tax IDs\n", "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "data", "entities.md"), "# Entities\n- Example Holdings LLC\n- EIN: 12-3456789\n", "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "data", "profile.md"), "# Profile\n", "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");

  const { resolveDispatchPlan, buildWorkspaceContextBundle } = loadWorkspaceContextWithHome(tmpDir);
  const plan = resolveDispatchPlan("what's the Example Holdings EIN number");
  const bundle = buildWorkspaceContextBundle("what's the Example Holdings EIN number");

  assert.equal(plan.branch, "data");
  assert.equal(plan.intentType, "directive");
  assert.equal(plan.route.lane, "data_lookup");
  assert.equal(plan.allowBroadSearch, false);
  assert.deepEqual(plan.dataSources, ["tax_records", "entities"]);
  assert.match(plan.searchScope, /entities\.md/);
  assert.match(bundle, /Branch: data/);
  assert.match(bundle, /Data Match: entities\.md/);
  assert.doesNotMatch(bundle, /Capability Route/);
});

test("website lookups route to the data branch and surface websites db", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-websites-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "projects"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({ fastpaths: [] }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "projects", "_index.json"), JSON.stringify({ projects: {} }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "USER.md"), "# User\n", "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");

  const schemaSql = [
    "create table websites (domain text primary key, name text not null, hosting text default '', base_url text default '', entity text default '', notes text default '');",
    "insert into websites(domain, name, hosting, base_url, entity, notes) values ('example.test', 'Acme HQ', 'vercel', 'https://www.example.test', 'Example Holdings LLC', 'Primary marketing site');",
  ].join(" ");
  require("node:child_process").execFileSync("sqlite3", [path.join(workspaceRoot, "data", "websites.db"), schemaSql], { encoding: "utf8" });

  const { resolveDispatchPlan, buildWorkspaceContextBundle } = loadWorkspaceContextWithHome(tmpDir);
  const plan = resolveDispatchPlan("what is the website for acme hq");
  const bundle = buildWorkspaceContextBundle("what is the website for acme hq");

  assert.equal(plan.branch, "data");
  assert.equal(plan.intentType, "directive");
  assert.equal(plan.route.lane, "data_lookup");
  assert.match(plan.searchScope, /websites\.db/);
  assert.match(bundle, /Data Match: websites\.db/);
  assert.match(bundle, /Domain: example\.test/);
  assert.match(bundle, /Base URL: https:\/\/www\.example\.test/);
});

test("weak substring aliases do not steal unrelated short messages", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-noise-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "projects"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({ fastpaths: [] }), "utf8");
  fs.writeFileSync(
    path.join(workspaceRoot, "projects", "_index.json"),
    JSON.stringify({
      projects: {
        whatsapp: {
          path: "whatsapp",
          name: "WhatsApp",
          aliases: ["wa", "whatsapp"],
        },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");

  const { resolveDispatchPlan } = loadWorkspaceContextWithHome(tmpDir);
  const plan = resolveDispatchPlan("are you awake?");

  assert.notEqual(plan.branch, "project");
  assert.equal(plan.projectSlug, null);
  assert.equal(plan.parallelizationPlan.mode, "none");
});

test("generic project words do not hijack person-reference messages", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-person-reference-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "projects"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({ fastpaths: [] }), "utf8");
  fs.writeFileSync(
    path.join(workspaceRoot, "projects", "_index.json"),
    JSON.stringify({
      projects: {
        made: {
          path: "made",
          name: "Made Task Tracker",
          aliases: ["task-tracker", "household", "logistics", "made tasks"],
        },
        "connection-map": {
          path: "connection-map",
          name: "The Connection Map",
          aliases: ["book", "speaking", "workshops", "podcasts", "networking", "connection map"],
        },
        "ai-operating-system-book": {
          path: "ai-operating-system-book",
          name: "AI Operating System Book",
          aliases: ["ai operating system book", "ai os book", "os book"],
        },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");

  const { resolveDispatchPlan } = loadWorkspaceContextWithHome(tmpDir);
  const personLookup = resolveDispatchPlan("look for a Jordan code we made today");
  const bookPlan = resolveDispatchPlan("I need the Branding manager to prepare a report for my how to build AI OS book");

  assert.equal(personLookup.branch, "fallback");
  assert.equal(personLookup.projectSlug, null);
  assert.equal(bookPlan.branch, "project");
  assert.equal(bookPlan.projectSlug, "ai-operating-system-book");
  assert.deepEqual(bookPlan.projectMatches.map((project) => project.slug), ["ai-operating-system-book"]);
});

test("cohort person references route to participant data before project context", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-cohort-person-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "projects"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({ fastpaths: [] }), "utf8");
  fs.writeFileSync(
    path.join(workspaceRoot, "projects", "_index.json"),
    JSON.stringify({
      projects: {
        acme: {
          path: "acme",
          name: "Acme HQ",
          aliases: ["acme", "acme hq"],
        },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");

  const { resolveDispatchPlan } = loadWorkspaceContextWithHome(tmpDir);
  const forwardPlan = resolveDispatchPlan("can you forward this to Riley Chen from Cohort 1 of Acme");
  const emailPlan = resolveDispatchPlan("Jordan from Cohort three of Acme said she didn't receive the email that went out today");

  assert.equal(forwardPlan.branch, "data");
  assert.equal(forwardPlan.projectSlug, null);
  assert.equal(forwardPlan.route.lane, "worker_skill");
  assert.deepEqual(forwardPlan.dataSources, ["participants"]);
  assert.equal(emailPlan.branch, "data");
  assert.equal(emailPlan.projectSlug, null);
  assert.equal(emailPlan.route.lane, "worker_skill");
  assert.equal(emailPlan.dataLookupCanary.reason, "participant_issue_requires_worker");
  assert.deepEqual(emailPlan.dataSources, ["participants"]);
});

test("identity and address lookups route to the data branch", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-identity-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "projects"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({ fastpaths: [] }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "projects", "_index.json"), JSON.stringify({ projects: {} }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "USER.md"), "# User\n", "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "data", "profile.md"), "# Profile\nHome: Example City\nOffice: Example District\n", "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");

  const { resolveDispatchPlan, buildWorkspaceContextBundle } = loadWorkspaceContextWithHome(tmpDir);
  const plan = resolveDispatchPlan("what's your name and where do I live");
  const bundle = buildWorkspaceContextBundle("what's your name and where do I live");

  assert.equal(plan.branch, "data");
  assert.equal(plan.actionType, "read");
  assert.equal(plan.route.lane, "data_lookup");
  assert.match(plan.searchScope, /profile\.md/);
  assert.match(bundle, /Action type: read/);
  assert.match(bundle, /Data Match: profile\.md/);
});

test("computer info lookups route to the data branch", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-computer-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "projects"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({ fastpaths: [] }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "projects", "_index.json"), JSON.stringify({ projects: {} }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "data", "computer.md"), "# Computer Info\nExample Laptop 2024\n", "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");

  const { resolveDispatchPlan, buildWorkspaceContextBundle } = loadWorkspaceContextWithHome(tmpDir);
  const plan = resolveDispatchPlan("what are my monitor sizes and computer specs");
  const bundle = buildWorkspaceContextBundle("what are my monitor sizes and computer specs");

  assert.equal(plan.branch, "data");
  assert.equal(plan.route.lane, "data_lookup");
  assert.match(plan.searchScope, /computer\.md/);
  assert.match(bundle, /Data Match: computer\.md/);
});

test("participant lookups route straight to the participant database", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-participants-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "projects"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({ fastpaths: [] }), "utf8");
  fs.writeFileSync(
    path.join(workspaceRoot, "projects", "_index.json"),
    JSON.stringify({
      projects: {
        acme: {
          path: "acme",
          name: "Acme HQ",
          aliases: ["acme", "acme hq"],
        },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");
  const schemaSql = [
    "create table participants (id integer primary key, role text, cohort_number integer);",
    "insert into participants(role, cohort_number) values ('participant', 2), ('participant', 2), ('participant', 3);",
  ].join(" ");
  require("node:child_process").execFileSync("sqlite3", [path.join(workspaceRoot, "data", "participants.db"), schemaSql], { encoding: "utf8" });

  const { resolveDispatchPlan, buildWorkspaceContextBundle } = loadWorkspaceContextWithHome(tmpDir);
  const plan = resolveDispatchPlan("how many people have signed up for acme cohort 2");
  const bundle = buildWorkspaceContextBundle("how many people have signed up for acme cohort 2");

  assert.equal(plan.branch, "data");
  assert.equal(plan.route.lane, "data_lookup");
  assert.match(plan.searchScope, /participants\.db/);
  assert.match(bundle, /Data Match: participants\.db/);
});

test("participant name lookups render row-level matches generically", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-participant-handle-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "projects"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({ fastpaths: [] }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "projects", "_index.json"), JSON.stringify({ projects: {} }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");
  const schemaSql = [
    "create table participants (id integer primary key, role text, full_name text, instagram text, cohort_number integer);",
    "insert into participants(role, full_name, instagram, cohort_number) values ('participant', 'Casey Rivera', null, 2);",
  ].join(" ");
  require("node:child_process").execFileSync("sqlite3", [path.join(workspaceRoot, "data", "participants.db"), schemaSql], { encoding: "utf8" });

  const { buildWorkspaceContextBundle } = loadWorkspaceContextWithHome(tmpDir);
  const bundle = buildWorkspaceContextBundle("what participants are in cohort 2");

  assert.match(bundle, /Data Match: participants\.db/);
  assert.match(bundle, /Casey Rivera/);
  assert.match(bundle, /```text/);
});

test("payment record updates route to data ownership first", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-affiliates-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "projects"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({ fastpaths: [] }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "projects", "_index.json"), JSON.stringify({ projects: {} }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");
  require("node:child_process").execFileSync(
    "sqlite3",
    [
      path.join(workspaceRoot, "data", "crm-contacts.db"),
      "create table crm_contacts (id text primary key, name text, email text, payment_url text, preferred_method text, updated_at text);",
    ],
    { encoding: "utf8" },
  );
  require("node:child_process").execFileSync(
    "sqlite3",
    [
      path.join(workspaceRoot, "data", "payout-methods.db"),
      "create table accounts (id integer primary key, account_name text, currency text, entity text, status text);",
    ],
    { encoding: "utf8" },
  );

  const { resolveDispatchPlan, buildWorkspaceContextBundle } = loadWorkspaceContextWithHome(tmpDir);
  const plan = resolveDispatchPlan("add the payment link to Morgan's affiliate profile");
  const bundle = buildWorkspaceContextBundle("add the payment link to Morgan's affiliate profile");

  assert.equal(plan.branch, "data");
  assert.equal(plan.actionType, "write");
  assert.equal(plan.route.lane, "worker_skill");
  assert.equal(plan.dataLookupCanary.enabled, false);
  assert.equal(plan.dataLookupCanary.reason, "non_read_action");
  assert.match(plan.searchScope, /crm-contacts\.db/);
  assert.match(bundle, /Data Match: crm-contacts\.db/);
});

test("tax-id lookups stay off unrelated project branches", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-tax-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "projects"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({ fastpaths: [] }), "utf8");
  fs.writeFileSync(
    path.join(workspaceRoot, "projects", "_index.json"),
    JSON.stringify({
      projects: {
        business: {
          path: "business",
          name: "Example Holdings",
          aliases: ["iron amethyst", "business"],
        },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");

  const { resolveDispatchPlan } = loadWorkspaceContextWithHome(tmpDir);
  const plan = resolveDispatchPlan("what's my iron amethyst ein");

  assert.notEqual(plan.branch, "project");
  assert.equal(plan.projectSlug, null);
  assert.equal(plan.intentType, "directive");
});

test("short follow-ups can reuse the previous project branch", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-followup-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  const projectDir = path.join(workspaceRoot, "projects", "birthday");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({ fastpaths: [] }), "utf8");
  fs.writeFileSync(
    path.join(workspaceRoot, "projects", "_index.json"),
    JSON.stringify({
      projects: {
        birthday: {
          path: "birthday",
          name: "50th Birthday",
          aliases: ["birthday party", "50th birthday"],
        },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(projectDir, "CONTEXT.md"), "# Birthday Context\n", "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");

  const { resolveDispatchPlan } = loadWorkspaceContextWithHome(tmpDir);
  const plan = resolveDispatchPlan("it's a subdomain", {
    lastDispatchHint: {
      branch: "project",
      projectSlug: "birthday",
    },
  });

  assert.equal(plan.branch, "project");
  assert.equal(plan.projectSlug, "birthday");
  assert.equal(plan.usedLastDispatchHint, true);
});

test("fastpath matching requires phrase boundaries for directive shortcuts", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-fastpath-boundary-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  const projectDir = path.join(workspaceRoot, "projects", "acme");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(
    path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"),
    JSON.stringify({
      fastpaths: [
        {
          intent: "acme pre-payment onboarding",
          match_terms: ["acme onboard", "acme promo link"],
          recipe_path: "projects/acme/recipes/stripe/send-promo-link.recipe.json",
        },
      ],
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(workspaceRoot, "projects", "_index.json"),
    JSON.stringify({
      projects: {
        acme: {
          path: "acme",
          name: "Acme HQ",
          aliases: ["acme"],
        },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(projectDir, "CONTEXT.md"), "# Acme Context\nOnboarding flow details.\n", "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");

  const { resolveDispatchPlan } = loadWorkspaceContextWithHome(tmpDir);
  const plan = resolveDispatchPlan("help me understand acme onboarding");

  assert.equal(plan.branch, "project");
  assert.equal(plan.intentType, "exploratory");
  assert.equal(plan.projectRecipeFirst, false);
});

test("routing complaint prompts do not get hijacked by project aliases", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-routing-complaint-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  const projectDir = path.join(workspaceRoot, "projects", "acme");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({ fastpaths: [] }), "utf8");
  fs.writeFileSync(
    path.join(workspaceRoot, "projects", "_index.json"),
    JSON.stringify({
      projects: {
        acme: {
          path: "acme",
          name: "Acme HQ",
          aliases: ["acme hq", "acme"],
        },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(projectDir, "CONTEXT.md"), "# Acme Context\nTestimonials and onboarding.\n", "utf8");
  fs.writeFileSync(
    path.join(workspaceRoot, "capabilities-index.json"),
    JSON.stringify({
      capabilities: [
        {
          id: "agent:participant-records",
          execution_lane: "worker_skill",
          aliases: ["participant-records", "acme", "airtable"],
          use_when: ["Local DB sync for acme participants from Airtable", "Direct command need: sync"],
          avoid_when: [],
          description: "Local DB sync for acme participants from Airtable",
          priority: 50,
        },
        {
          id: "skill:acme-testimonial-questions",
          execution_lane: "worker_skill",
          aliases: ["acme-testimonial-questions"],
          use_when: [],
          avoid_when: [],
          description: "Use when a user asks for the acme testimonial questions.",
          priority: 40,
        },
      ],
      lanes: {},
    }),
    "utf8",
  );

  const { resolveDispatchPlan } = loadWorkspaceContextWithHome(tmpDir);
  const plan = resolveDispatchPlan(
    "same bad routing error. I understand why it's happening it sees the context very quickly that it has a acme in the word testimonial it's not reading the whole context of the request. need to fix this in the routing",
  );

  assert.equal(plan.branch, "fallback");
  assert.equal(plan.projectSlug, null);
  assert.equal(plan.route.lane, "worker_skill");
  assert.deepEqual(plan.route.candidates, []);
});

test("dispatch plans expose automatic scale 4 metadata for durable multi-system work", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-goal-scale-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "projects"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({ fastpaths: [] }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "projects", "_index.json"), JSON.stringify({ projects: {} }), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");

  const { resolveDispatchPlan, buildWorkspaceContextBundle } = loadWorkspaceContextWithHome(tmpDir);
  const prompt = "Fix the db sync, add one-command reconciliation, and audit current live sports exposure";
  const plan = resolveDispatchPlan(prompt);
  const bundle = buildWorkspaceContextBundle(prompt);

  assert.equal(plan.goalScale, 4);
  assert.equal(plan.goalMode, "ultragoal");
  assert.equal(plan.requiresPlan, true);
  assert.equal(plan.parallelizationPlan.mode, "read_only");
  assert.equal(plan.parallelizationPlan.repositoryRouting.writableSafe, false);
  assert.ok(plan.parallelizationPlan.backgroundTasks.length >= 2);
  assert.match(bundle, /Goal scale: 4 \(ultragoal\)/);
  assert.match(bundle, /Parallelization: myos-parallelization-(writable-v1|v\d) (provider_affine_git_worktrees|read_only)/);
  assert.match(bundle, /Requires plan: yes/);
  assert.match(bundle, /Stop rules: done_verified/);
});

test("shortlistCapabilities propagates scan_dir through candidates and resolves relative source_path", () => {
  const { shortlistCapabilities } = require("../src/capability-router.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-scan-"));
  const indexPath = path.join(tmpDir, "capabilities-index.json");
  const externalScanDir = path.join(tmpDir, "external-repo");
  fs.writeFileSync(
    indexPath,
    JSON.stringify({
      schema_version: 1,
      scan_dir: externalScanDir,
      lanes: {},
      capabilities: [
        {
          id: "recipe:external-deploy",
          execution_lane: "recipe_dispatcher",
          aliases: ["external deploy"],
          use_when: ["external deploy"],
          source_path: "recipes/deploy.recipe.json",
          priority: 50,
        },
      ],
    }),
    "utf8"
  );

  const results = shortlistCapabilities("external deploy", "recipe_dispatcher", 5, { indexPath });
  assert.equal(results.length, 1);
  assert.equal(results[0].scan_dir, externalScanDir);
  assert.equal(results[0].capability.scan_dir, externalScanDir);
  assert.equal(results[0].capability.source_path, "recipes/deploy.recipe.json");
});

test("relative scan directory routes external Git repo correctly after process cwd changes", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-cwd-"));
  const origCwd = process.cwd();
  try {
    const extRepoDir = path.join(tmpDir, "external-git-repo");
    fs.mkdirSync(path.join(extRepoDir, "recipes"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: extRepoDir });

    const recipePath = path.join(extRepoDir, "recipes", "deploy.recipe.json");
    fs.writeFileSync(
      recipePath,
      JSON.stringify({
        id: "external-git-deploy",
        title: "External Git Deploy",
        phrases: ["external git deploy"],
      }),
      "utf8"
    );

    const indexPath = path.join(tmpDir, "capabilities-index.json");

    process.chdir(tmpDir);
    const { run: runGenIndex } = require("../scripts/generate-index.js");
    runGenIndex({ dir: "./external-git-repo", out: indexPath, quiet: true });

    const anotherDir = fs.mkdtempSync(path.join(os.tmpdir(), "other-cwd-"));
    process.chdir(anotherDir);

    const { resolveDispatchPlan } = loadWorkspaceContextWithHome(tmpDir);
    const plan = resolveDispatchPlan("external git deploy", { indexPath });

    assert.equal(plan.branch, "capability");
    assert.equal(fs.realpathSync(plan.searchScope), fs.realpathSync(recipePath));

    fs.rmSync(anotherDir, { recursive: true, force: true });
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("suppresses generic single-word alumni project capture while preserving explicit Alumni Circle", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-context-alumni-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "projects"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  writeDefaultDataSourcesConfig(workspaceRoot);

  fs.writeFileSync(path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"), JSON.stringify({ fastpaths: [] }), "utf8");
  fs.writeFileSync(
    path.join(workspaceRoot, "projects", "_index.json"),
    JSON.stringify({
      projects: {
        alumni: {
          slug: "alumni",
          name: "Alumni Circle",
          aliases: ["alumni", "alumni circle"],
          path: "alumni",
        },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(workspaceRoot, "capabilities-index.json"), JSON.stringify({ capabilities: [], lanes: {} }), "utf8");

  const { resolveDispatchPlan } = loadWorkspaceContextWithHome(tmpDir);

  const genericPlan = resolveDispatchPlan("I am an alumni of Stanford");
  assert.notEqual(genericPlan.projectSlug, "alumni");

  const explicitPlan = resolveDispatchPlan("Tell me about Alumni Circle");
  assert.equal(explicitPlan.projectSlug, "alumni");
});

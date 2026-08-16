"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { run, buildIndex } = require("../scripts/generate-index.js");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("builds an index from a fixture recipe", () => {
  const scanDir = tmpDir("mdx-scan-");
  const recipeDir = path.join(scanDir, "agents", "demo", "recipes");
  fs.mkdirSync(recipeDir, { recursive: true });
  fs.writeFileSync(
    path.join(recipeDir, "check-status.recipe.json"),
    JSON.stringify({
      id: "demo/check-status",
      owner: "demo",
      title: "Check demo status",
      phrases: ["check demo status", "demo health"],
      tags: ["status"],
      handler: "check-status.js",
      command: "node check-status.js",
      layer: "agent",
    }),
    "utf8"
  );

  const { index, counts } = buildIndex(scanDir);
  assert.strictEqual(counts.recipes, 1);
  assert.strictEqual(index.capabilities.length, 1);
  const cap = index.capabilities[0];
  assert.strictEqual(cap.id, "recipe:demo/check-status");
  assert.strictEqual(cap.execution_lane, "recipe_dispatcher");
  assert.ok(cap.use_when.includes("check demo status"));
  assert.strictEqual(cap.runtime_requirements.command, "node check-status.js");
  assert.ok(Array.isArray(index.capabilities));
  fs.rmSync(scanDir, { recursive: true, force: true });
});

test("exports complete agent commands and relationship metadata", () => {
  const scanDir = tmpDir("mdx-agents-");
  const registryDir = path.join(scanDir, "agents");
  fs.mkdirSync(registryDir, { recursive: true });
  const commands = Array.from({ length: 12 }, (_, index) => `command-${index + 1}`);
  fs.writeFileSync(
    path.join(registryDir, "agent-registry.json"),
    JSON.stringify([{
      id: "gtm-manager",
      name: "GTM Manager",
      commands,
      reports_to: [],
      manages: ["marketing-pm", "outreach-director"],
      coordinates_with: ["revenue-manager"],
      serves: ["product-pm"],
    }]),
    "utf8"
  );

  const { index } = buildIndex(scanDir);
  const capability = index.capabilities.find((item) => item.id === "agent:gtm-manager");
  assert.deepStrictEqual(capability.runtime_requirements.commands, commands);
  assert.deepStrictEqual(capability.relationships, {
    reports_to: [],
    manages: ["marketing-pm", "outreach-director"],
    coordinates_with: ["revenue-manager"],
    serves: ["product-pm"],
  });
  fs.rmSync(scanDir, { recursive: true, force: true });
});

test("scans skills and workflows too", () => {
  const scanDir = tmpDir("mdx-scan2-");
  const skillDir = path.join(scanDir, "skills", "my-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: my-skill\ndescription: Does a thing\nread_when:\n  - user wants a thing\n---\nbody\n",
    "utf8"
  );
  fs.mkdirSync(path.join(scanDir, "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(scanDir, "workflows", "council.workflow.json"),
    JSON.stringify({ id: "workflow:council", description: "A council pattern" }),
    "utf8"
  );

  const { index, counts } = buildIndex(scanDir);
  assert.strictEqual(counts.skills, 1);
  assert.strictEqual(counts.workflows, 1);
  const ids = index.capabilities.map((c) => c.id);
  assert.ok(ids.includes("skill:my-skill"));
  assert.ok(ids.includes("workflow:council"));
  fs.rmSync(scanDir, { recursive: true, force: true });
});

test("adds enabled Codex plugins as advisory worker capabilities", () => {
  const scanDir = tmpDir("mdx-plugin-");
  const plugin = {
    pluginId: "github@openai-curated",
    name: "github",
    description: "GitHub integration",
    manifestPath: "/tmp/github/.codex-plugin/plugin.json",
    sourcePath: "/tmp/github",
    keywords: ["pull requests"],
    defaultPrompts: ["Review a pull request"],
    components: { skills: true, apps: true, mcpServers: false, hooks: false, commands: false },
    routingPolicy: { authority: "myos", route: "connector_or_cli", mutation: "approval_gated" },
  };

  const { index, counts } = buildIndex(scanDir, { plugins: [plugin] });
  assert.strictEqual(counts.plugins, 1);
  const capability = index.capabilities.find((item) => item.id === "plugin:github@openai-curated");
  assert.ok(capability);
  assert.strictEqual(capability.priority, 35);
  assert.strictEqual(capability.runtime_requirements.advisory_only, true);
  assert.strictEqual(capability.runtime_requirements.routing_policy.authority, "myos");
  fs.rmSync(scanDir, { recursive: true, force: true });
});

test("empty/absent target yields a valid empty index (never throws)", () => {
  const scanDir = tmpDir("mdx-empty-");
  const outPath = path.join(scanDir, "out", "capabilities-index.json");
  const result = run({ dir: scanDir, out: outPath });
  assert.strictEqual(result.counts.capabilities, 0);
  assert.ok(fs.existsSync(outPath));
  const written = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.ok(Array.isArray(written.capabilities));
  assert.strictEqual(written.capabilities.length, 0);
  assert.ok(written.lanes && written.lanes.recipe_dispatcher);

  // Absent directory also must not throw.
  const absent = path.join(scanDir, "does-not-exist");
  const r2 = run({ dir: absent, out: outPath });
  assert.strictEqual(r2.counts.capabilities, 0);
  fs.rmSync(scanDir, { recursive: true, force: true });
});

test("output index is consumable by capability-router loadCapabilityIndex", () => {
  const scanDir = tmpDir("mdx-router-");
  const recipeDir = path.join(scanDir, "recipes");
  fs.mkdirSync(recipeDir, { recursive: true });
  fs.writeFileSync(
    path.join(recipeDir, "deploy.recipe.json"),
    JSON.stringify({ id: "deploy-site", owner: "web", title: "Deploy the site", phrases: ["deploy the site"] }),
    "utf8"
  );
  const outPath = path.join(scanDir, "capabilities-index.json");
  run({ dir: scanDir, out: outPath });

  const { loadCapabilityIndex } = require("../src/capability-router.js");
  const loaded = loadCapabilityIndex({ indexPath: outPath });
  assert.ok(Array.isArray(loaded.capabilities));
  assert.strictEqual(loaded.capabilities.length, 1);
  assert.strictEqual(loaded.capabilities[0].id, "recipe:deploy-site");
  fs.rmSync(scanDir, { recursive: true, force: true });
});

test("parseFrontmatter handles exact YAML block scalars | and > with CRLF and paragraph breaks", () => {
  const { parseFrontmatter } = require("../scripts/generate-index.js");
  const content = "---\r\nname: test-skill\r\ndescription: |\r\n  First line\r\n  Second line\r\n\r\n  Paragraph two\r\nsummary: >\r\n  This is folded\r\n  into a single line.\r\n\r\n  New paragraph.\r\n---\r\nBody text\r\n";
  const fm = parseFrontmatter(content);
  assert.strictEqual(fm.name, "test-skill");
  assert.strictEqual(fm.description, "First line\nSecond line\n\nParagraph two");
  assert.strictEqual(fm.summary, "This is folded into a single line.\n\nNew paragraph.");
});

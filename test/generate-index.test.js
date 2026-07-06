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
  assert.ok(Array.isArray(index.capabilities));
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

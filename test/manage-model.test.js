"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const source = path.resolve(__dirname, "../data/models/openai-model-catalog.json");

test("Astra has official metadata and does not replace profile defaults", () => {
  const catalog = JSON.parse(fs.readFileSync(source));
  const astra = catalog.models.find(m => m.model === "gpt-6-astra");
  assert.ok(astra, "exact Astra model must be in the catalog");
  assert.equal(astra.context_window, 1050000);
  assert.equal(astra.max_output_tokens, 128000);
  assert.deepEqual(astra.pricing_per_1m_tokens, { input_usd: 10, cached_input_usd: 1, output_usd: 50 });
  assert.equal(astra.verification.status, "unverified");
  for (const profile of catalog.routing_profiles) assert.notEqual(profile.preferred?.[0], astra.id);
});

test("add, show, select and undo affect only the chosen catalog and preserve defaults", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "manage-model-"));
  const catalogPath = path.join(home, "openai-model-catalog.json");
  const original = JSON.parse(fs.readFileSync(source));
  original.custom_metadata = { keep: [1, 2] };
  fs.writeFileSync(catalogPath, JSON.stringify(original));
  const run = (...args) => spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/manage-model.js"), ...args, "--provider", "openai", "--catalog", catalogPath], { encoding: "utf8" });
  const read = () => JSON.parse(fs.readFileSync(catalogPath));
  const bytes = fs.readFileSync(catalogPath, "utf8");
  assert.equal(run("show").status, 0);
  assert.equal(fs.readFileSync(catalogPath, "utf8"), bytes);
  const added = run("add", "--model", "exact-new-model");
  assert.equal(added.status, 0, added.stderr);
  assert.deepEqual(read().routing_profiles, original.routing_profiles);
  assert.deepEqual(read().custom_metadata, original.custom_metadata);
  assert.deepEqual(read().models.at(-1), { id: "openai.exact-new-model", model: "exact-new-model", verification: { status: "unverified" } });
  const afterAdd = fs.readFileSync(catalogPath, "utf8");
  assert.equal(run("add", "--model", "exact-new-model").status, 0);
  assert.equal(fs.readFileSync(catalogPath, "utf8"), afterAdd);
  const profile = original.routing_profiles[0].id;
  const selected = run("select", "--model", "exact-new-model", "--profile", profile);
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(read().routing_profiles[0].preferred[0], "openai.exact-new-model");
  assert.deepEqual(read().routing_profiles.slice(1), original.routing_profiles.slice(1));
  const undo = run("undo", "--backup", JSON.parse(selected.stdout).backup);
  assert.equal(undo.status, 0, undo.stderr);
  assert.equal(fs.readFileSync(catalogPath, "utf8"), afterAdd);
  for (const args of [["select", "--model", "missing", "--profile", profile], ["add", "--model", " bad id "], ["select", "--model", "gpt-6-astra", "--profile", "missing"], ["add", "--model", "x", "--provider", "deepseek"]]) {
    assert.notEqual(run(...args).status, 0);
    assert.equal(fs.readFileSync(catalogPath, "utf8"), afterAdd);
  }
  fs.writeFileSync(catalogPath, "{bad");
  assert.notEqual(run("add", "--model", "valid-id").status, 0);
  assert.equal(fs.readFileSync(catalogPath, "utf8"), "{bad");
});

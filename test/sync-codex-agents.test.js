"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MANIFEST_FILE,
  syncCodexAgents,
} = require("../scripts/sync-codex-agents");

test("agent sync copies only MyOS-owned profiles and records hashes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myos-agent-sync-"));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(source, "myos-code-mapper.toml"), "name = \"myos_code_mapper\"\n", "utf8");
  fs.writeFileSync(path.join(source, "foreign.toml"), "name = \"foreign\"\n", "utf8");
  fs.writeFileSync(path.join(target, "keep.toml"), "name = \"keep\"\n", "utf8");

  const manifest = syncCodexAgents({ source, target });
  assert.equal(manifest.files.length, 1);
  assert.equal(fs.existsSync(path.join(target, "myos-code-mapper.toml")), true);
  assert.equal(fs.existsSync(path.join(target, "foreign.toml")), false);
  assert.equal(fs.existsSync(path.join(target, "keep.toml")), true);
  const written = JSON.parse(fs.readFileSync(path.join(target, MANIFEST_FILE), "utf8"));
  assert.match(written.files[0].sha256, /^[a-f0-9]{64}$/);
  fs.rmSync(root, { recursive: true, force: true });
});

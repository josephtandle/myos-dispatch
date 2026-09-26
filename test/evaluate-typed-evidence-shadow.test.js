"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DEFAULT_REPLAY_CORPUS_FILE } = require("../src/promotion/typed-evidence-shadow-policy");
const script = path.resolve(__dirname, "../scripts/evaluate-typed-evidence-shadow.js");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typed-shadow-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const corpusFile = path.join(root, "workspace/agents/shared/replay-corpora/typed-evidence-shadow-corpus.json");
  fs.mkdirSync(path.dirname(corpusFile), { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    MYOS_HOME_ROOT: root,
    OPENCLAW_HOME_ROOT: path.join(root, "legacy"),
  };
  return {
    corpusFile,
    run: (...args) => spawnSync(process.execPath, [script, "--no-record", ...args], {
      cwd: root, env, encoding: "utf8", timeout: 10000,
    }),
  };
}

test("CLI resolves and prints the workspace corpus without an in-repo copy", (t) => {
  assert.equal(fs.existsSync(DEFAULT_REPLAY_CORPUS_FILE), false);
  const { corpusFile, run } = fixture(t);
  fs.writeFileSync(corpusFile, JSON.stringify({ cases: [] }));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`Replay corpus: ${corpusFile}`), result.stdout);
  assert.match(result.stdout, /0\/0 passed/);
});

test("CLI includes the resolved corpus in valid JSON output", (t) => {
  const { corpusFile, run } = fixture(t);
  fs.writeFileSync(corpusFile, JSON.stringify({ cases: [] }));
  const result = run("--json");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).corpusFile, corpusFile);
});

test("CLI honors an explicit corpus instead of the workspace copy", (t) => {
  const { corpusFile, run } = fixture(t);
  fs.writeFileSync(corpusFile, "invalid workspace JSON");
  const explicitFile = path.join(path.dirname(corpusFile), "explicit.json");
  fs.writeFileSync(explicitFile, JSON.stringify({ cases: [] }));
  const result = run("--corpus", explicitFile, "--json");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).corpusFile, explicitFile);
});

test("CLI exits 2 with a clear message when no corpus exists", (t) => {
  const { run } = fixture(t);
  const result = run();
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Replay corpus not found.*workspace.*--corpus/);
});

test("CLI reports a missing explicit corpus even when a workspace copy exists", (t) => {
  const { corpusFile, run } = fixture(t);
  fs.writeFileSync(corpusFile, JSON.stringify({ cases: [] }));
  const missingFile = path.join(path.dirname(corpusFile), "missing.json");
  const result = run("--corpus", missingFile);
  assert.equal(result.status, 2, result.stderr);
  assert.ok(result.stderr.includes(`Replay corpus not found: ${missingFile}`));
});

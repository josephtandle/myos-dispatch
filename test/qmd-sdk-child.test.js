"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const HELPER = path.resolve(__dirname, "../packages/local-search/qmd-sdk-child.mjs");

function makeFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qmd-sdk-child-")));
  const packageRoot = path.join(root, "node_modules", "@tobilu", "qmd");
  const dist = path.join(packageRoot, "dist");
  const dbPath = path.join(root, "index.sqlite");
  const modelPath = path.join(root, "embedding.gguf");
  const recordPath = path.join(root, "calls.jsonl");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "@tobilu/qmd",
    version: "2.8.3",
    type: "module",
  }));
  fs.writeFileSync(dbPath, Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(64)]));
  fs.writeFileSync(modelPath, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(32)]));
  fs.writeFileSync(path.join(dist, "index.js"), `
    import fs from "node:fs";
    const record = (value) => fs.appendFileSync(process.env.TEST_QMD_RECORD, JSON.stringify(value) + "\\n");
    if (process.env.TEST_QMD_STDOUT_NOISE) process.stdout.write("synthetic SDK noise\\n");
    record({ op: "import-index", model: process.env.QMD_EMBED_MODEL });
    export async function createStore(options) {
      record({ op: "createStore", options });
      return {
        async searchLex(query, options) {
          record({ op: "searchLex", query, options });
          if (process.env.TEST_QMD_SEARCH_ERROR) throw new Error("synthetic search failure");
          return [{ filepath: process.env.TEST_QMD_FILEPATH || "qmd://docs/opaque.md", score: 0.75, body: "secret body", title: "secret title" }];
        },
        async searchVector(query, options) {
          record({ op: "searchVector", query, options, model: process.env.QMD_EMBED_MODEL });
          if (process.env.TEST_QMD_SEARCH_ERROR) throw new Error("synthetic search failure");
          return [{ filepath: "qmd://docs/vector.md", score: 0.5, body: "secret vector body" }];
        },
        async search() { record({ op: "search" }); throw new Error("hybrid forbidden"); },
        async expandQuery() { record({ op: "expandQuery" }); throw new Error("expansion forbidden"); },
        async update() { record({ op: "update" }); throw new Error("update forbidden"); },
        async embed() { record({ op: "embed" }); throw new Error("embed forbidden"); },
        async close() { record({ op: "close" }); },
      };
    }
  `);
  fs.writeFileSync(path.join(dist, "llm.js"), `
    import fs from "node:fs";
    fs.appendFileSync(process.env.TEST_QMD_RECORD, JSON.stringify({ op: "import-llm" }) + "\\n");
    export async function disposeDefaultLlamaCpp() {
      fs.appendFileSync(process.env.TEST_QMD_RECORD, JSON.stringify({ op: "disposeDefaultLlamaCpp" }) + "\\n");
    }
  `);
  return { root, packageRoot, dbPath, modelPath, recordPath };
}

function runHelper(fixture, request, extraEnv = {}) {
  return spawnSync(process.execPath, [HELPER], {
    input: JSON.stringify(request),
    encoding: "utf8",
    env: { ...process.env, TEST_QMD_RECORD: fixture.recordPath, ...extraEnv },
  });
}

function readCalls(fixture) {
  if (!fs.existsSync(fixture.recordPath)) return [];
  return fs.readFileSync(fixture.recordPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("lexical search calls only searchLex and emits sanitized candidates", () => {
  const fixture = makeFixture();
  try {
    const query = String.raw`one "literal" query .* [x] $HOME`;
    const result = runHelper(fixture, {
      operation: "lexical",
      packageRoot: fixture.packageRoot,
      dbPath: fixture.dbPath,
      collection: "docs",
      query,
      limit: 3,
      modelPaths: null,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      { file: "qmd://docs/opaque.md", score: 0.75 },
    ]);
    const calls = readCalls(fixture);
    assert.deepEqual(calls.filter(({ op }) => op.startsWith("search")).map(({ op }) => op), ["searchLex"]);
    assert.equal(calls.find(({ op }) => op === "import-index").model, undefined);
    assert.equal(calls.find(({ op }) => op === "searchLex").query, query);
    assert.deepEqual(calls.find(({ op }) => op === "searchLex").options, { collection: "docs", limit: 3 });
    assert.ok(calls.some(({ op }) => op === "close"));
    assert.ok(calls.some(({ op }) => op === "disposeDefaultLlamaCpp"));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("semantic search sets the local model before import and calls only searchVector", () => {
  const fixture = makeFixture();
  try {
    const result = runHelper(fixture, {
      operation: "semantic",
      packageRoot: fixture.packageRoot,
      dbPath: fixture.dbPath,
      collection: "docs",
      query: "semantic orchard",
      limit: 2,
      modelPaths: { embed: fixture.modelPath },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      { file: "qmd://docs/vector.md", score: 0.5 },
    ]);
    const calls = readCalls(fixture);
    assert.deepEqual(calls.filter(({ op }) => op.startsWith("search")).map(({ op }) => op), ["searchVector"]);
    const search = calls.find(({ op }) => op === "searchVector");
    assert.equal(search.model, fs.realpathSync(fixture.modelPath));
    assert.deepEqual(search.options, { collection: "docs", limit: 2 });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("invalid requests fail before SDK import", async (t) => {
  const baseRequest = (fixture) => ({
    operation: "semantic",
    packageRoot: fixture.packageRoot,
    dbPath: fixture.dbPath,
    collection: "docs",
    query: "bounded query",
    limit: 2,
    modelPaths: { embed: fixture.modelPath },
  });
  const cases = [
    ["operation", (request) => { request.operation = "hybrid"; }],
    ["package root", (request) => { request.packageRoot = "relative/qmd"; }],
    ["incomplete package", (request, fixture) => {
      fs.rmSync(path.join(fixture.packageRoot, "dist", "llm.js"));
    }],
    ["missing DB", (request, fixture) => { request.dbPath = path.join(fixture.root, "missing.sqlite"); }],
    ["non-SQLite DB", (request, fixture) => {
      const invalidDb = path.join(fixture.root, "not-sqlite.db");
      fs.writeFileSync(invalidDb, "not a SQLite database");
      request.dbPath = invalidDb;
    }],
    ["collection", (request) => { request.collection = "../docs"; }],
    ["empty query", (request) => { request.query = "   "; }],
    ["oversized query", (request) => { request.query = "x".repeat(1025); }],
    ["zero limit", (request) => { request.limit = 0; }],
    ["fractional limit", (request) => { request.limit = 1.5; }],
    ["nonpositive memory multiplier", (request) => {
      request.resourcePolicy = { inferenceWaitMs: 30_000, memory: { modelSizeMultiplier: 0 } };
    }],
    ["unknown memory policy field", (request) => {
      request.resourcePolicy = { inferenceWaitMs: 30_000, memory: { unbounded: true } };
    }],
    ["remote model", (request) => { request.modelPaths.embed = "https://example.test/model.gguf"; }],
    ["bad GGUF header", (request, fixture) => {
      const badModel = path.join(fixture.root, "bad.gguf");
      fs.writeFileSync(badModel, "nope");
      request.modelPaths.embed = badModel;
    }],
    ["symlink model", (request, fixture) => {
      const link = path.join(fixture.root, "linked.gguf");
      fs.symlinkSync(fixture.modelPath, link);
      request.modelPaths.embed = link;
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const fixture = makeFixture();
      try {
        const request = baseRequest(fixture);
        mutate(request, fixture);
        const missingDb = name === "missing DB" ? request.dbPath : null;
        const result = runHelper(fixture, request);

        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, "");
        assert.equal(JSON.parse(result.stderr).error.code, "INVALID_REQUEST");
        assert.deepEqual(readCalls(fixture), []);
        if (missingDb) assert.equal(fs.existsSync(missingDb), false);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("search failure closes the store and disposes the global llama instance", () => {
  const fixture = makeFixture();
  try {
    const result = runHelper(fixture, {
      operation: "lexical",
      packageRoot: fixture.packageRoot,
      dbPath: fixture.dbPath,
      collection: "docs",
      query: "trigger failure",
      limit: 1,
      modelPaths: { embed: fixture.modelPath },
    }, { TEST_QMD_SEARCH_ERROR: "1" });

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "QMD_SEARCH_FAILED");
    const operations = readCalls(fixture).map(({ op }) => op);
    assert.ok(operations.includes("close"));
    assert.ok(operations.includes("disposeDefaultLlamaCpp"));
    assert.ok(operations.indexOf("close") < operations.indexOf("disposeDefaultLlamaCpp"));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an unbounded SDK filepath fails closed without exporting it", () => {
  const fixture = makeFixture();
  try {
    const oversizedFile = `qmd://docs/${"x".repeat(4096)}`;
    const result = runHelper(fixture, {
      operation: "lexical",
      packageRoot: fixture.packageRoot,
      dbPath: fixture.dbPath,
      collection: "docs",
      query: "bounded output",
      limit: 1,
      modelPaths: { embed: fixture.modelPath },
    }, { TEST_QMD_FILEPATH: oversizedFile });

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "QMD_SEARCH_FAILED");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("SDK diagnostics cannot contaminate candidate stdout", () => {
  const fixture = makeFixture();
  try {
    const result = runHelper(fixture, {
      operation: "lexical",
      packageRoot: fixture.packageRoot,
      dbPath: fixture.dbPath,
      collection: "docs",
      query: "clean stdout",
      limit: 1,
      modelPaths: { embed: fixture.modelPath },
    }, { TEST_QMD_STDOUT_NOISE: "1" });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      { file: "qmd://docs/opaque.md", score: 0.75 },
    ]);
    assert.match(result.stderr, /synthetic SDK noise/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

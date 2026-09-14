"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { publish, reconcile } = require("../packages/local-search/catalogue");
const { normalizeConfig } = require("../packages/local-search/config");
const { runSdkSearch, runSdkSearchCollections } = require("../packages/local-search/qmd");
const { search } = require("../packages/local-search/search");
const { loadManifests, stage } = require("../packages/local-search/staging");

const CHILD = path.resolve(__dirname, "../packages/local-search/qmd-sdk-child.mjs");
const NODE24 = process.env.MYOS_TEST_NODE24 || process.execPath;

function node24Runtime() {
  assert.equal(path.isAbsolute(NODE24), true, "MYOS_TEST_NODE24 or process.execPath must be absolute");
  assert.equal(fs.existsSync(NODE24), true, "selected Node 24 runtime must exist");
  const version = spawnSync(NODE24, ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(Number(/^v(\d+)/.exec(version.stdout)?.[1]), 24, "selected runtime must be Node 24");
  return NODE24;
}

function syntheticQmd(t, behavior = "success") {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "local-search-sdk-batch-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const packageRoot = path.join(base, "qmd");
  const dist = path.join(packageRoot, "dist");
  const events = path.join(base, "events.jsonl");
  const dbPath = path.join(base, "qmd-index.sqlite");
  const modelPath = path.join(base, "embed.gguf");
  const preload = path.join(base, "memory-probe.cjs");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@tobilu/qmd", version: "2.8.3", type: "module" }));
  fs.writeFileSync(dbPath, Buffer.from("SQLite format 3\0"), { mode: 0o600 });
  fs.writeFileSync(modelPath, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(16)]), { mode: 0o600 });
  const eventPath = JSON.stringify(events);
  fs.writeFileSync(path.join(dist, "index.js"), `
    import fs from "node:fs";
    const log = (event) => fs.appendFileSync(${eventPath}, JSON.stringify(event) + "\\n");
    export async function createStore() {
      log("create");
      return {
        async searchLex(query, options) {
          log({ search: options.collection, query, limit: options.limit });
          ${behavior === "failSecond" ? "if (options.collection === 'two') throw new Error('synthetic failure');" : ""}
          ${behavior === "foreignSecond" ? "if (options.collection === 'two') return [{ filepath: 'qmd://foreign/0.md', score: 100 }];" : ""}
          ${behavior === "largeOutput" ? "return Array.from({ length: 8 }, (_, index) => ({ filepath: `qmd://\\${options.collection}/${'x'.repeat(4000 - options.collection.length)}.md`, score: 100 - index }));" : ""}
          return Array.from({ length: 10 }, (_, index) => ({ filepath: \`qmd://\${options.collection}/\${index}.md\`, score: 100 - index }));
        },
        async searchVector(query, options) { return this.searchLex(query, options); },
        async close() { log("close"); }
      };
    }
  `);
  fs.writeFileSync(path.join(dist, "llm.js"), `
    import fs from "node:fs";
    export async function disposeDefaultLlamaCpp() { fs.appendFileSync(${eventPath}, JSON.stringify("dispose") + "\\n"); }
  `);
  fs.writeFileSync(preload, `
    const Module = require("node:module");
    const target = ${JSON.stringify(path.resolve(__dirname, "../packages/local-search/resources.js"))};
    const load = Module._load;
    Module._load = function(request, parent, isMain) {
      const resolved = Module._resolveFilename(request, parent, isMain);
      const value = load.apply(this, arguments);
      if (resolved !== target) return value;
      return { ...value, acquireInferenceWithMemory(config, options = {}) {
        return value.acquireInferenceWithMemory(config, {
          ...options,
          memoryOptions: { ...options.memoryOptions, readings: { availableBytes: 1048576, totalBytes: 2097152 } },
        });
      }};
    };
  `);
  return { packageRoot, dbPath, modelPath, events, stateDirectory: base, preload };
}

function invokeChild(fixture, request) {
  return spawnSync(node24Runtime(), ["-r", fixture.preload, CHILD], {
    encoding: "utf8",
    input: JSON.stringify({
      operation: "lexical",
      packageRoot: fixture.packageRoot,
      dbPath: fixture.dbPath,
      query: "needle",
      limit: 8,
      stateDirectory: fixture.stateDirectory,
      ...request,
    }),
    timeout: 5_000,
  });
}

function readEvents(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("SDK wrapper rejects conflicting collection forms without dropping either shape", async () => {
  const controller = new AbortController();
  controller.abort();
  const config = {
    stateDirectory: path.join(fs.realpathSync(os.tmpdir()), "local-search-sdk-wrapper"),
    qmd: { timeoutMs: 1 },
    resourcePolicy: { inferenceWaitMs: 1 },
  };
  const common = { operation: "lexical", query: "needle", limit: 8 };

  assert.deepEqual(await runSdkSearch(config, { ...common, collection: "one", collections: ["one"] }, { signal: controller.signal }), {
    ok: false,
    status: "invalidRequest",
  });
  assert.deepEqual(await runSdkSearch(config, { ...common, collection: undefined, collections: undefined }, { signal: controller.signal }), {
    ok: false,
    status: "invalidRequest",
  });
  assert.equal((await runSdkSearch(config, { ...common, collection: "one" }, { signal: controller.signal })).status, "aborted");
  assert.equal((await runSdkSearch(config, { ...common, collections: ["one"] }, { signal: controller.signal })).status, "aborted");
});

test("SDK child batches collections sequentially with one store lifecycle and a per-collection limit", (t) => {
  const fixture = syntheticQmd(t);
  const child = invokeChild(fixture, { collections: ["one", "two", "three", "four"] });

  assert.equal(child.status, 0, child.stderr);
  const rows = JSON.parse(child.stdout);
  assert.equal(rows.length, 32);
  assert.deepEqual(rows.map((row) => row.file.split("/")[2]).filter((value, index, all) => index === 0 || value !== all[index - 1]), ["one", "two", "three", "four"]);
  assert.deepEqual(readEvents(fixture.events), [
    "create",
    { search: "one", query: "needle", limit: 8 },
    { search: "two", query: "needle", limit: 8 },
    { search: "three", query: "needle", limit: 8 },
    { search: "four", query: "needle", limit: 8 },
    "close",
    "dispose",
  ]);
});

test("legacy and batched child requests return equivalent lexical and semantic candidates", (t) => {
  const fixture = syntheticQmd(t);
  for (const operation of ["lexical", "semantic"]) {
    const common = operation === "semantic" ? {
      operation,
      modelPaths: { embed: fixture.modelPath },
      resourcePolicy: { inferenceWaitMs: 1_000, memory: { minimumAvailableBytes: 1, modelSizeMultiplier: 0.001, fixedOverheadBytes: 1 } },
      admissionTimeoutMs: 1_000,
    } : { operation };
    const legacyRows = ["one", "two", "three", "four"].flatMap((collection) => {
      const child = invokeChild(fixture, { ...common, collection });
      assert.equal(child.status, 0, child.stderr);
      return JSON.parse(child.stdout);
    });
    const batch = invokeChild(fixture, { ...common, collections: ["one", "two", "three", "four"] });
    assert.equal(batch.status, 0, batch.stderr);
    assert.deepEqual(JSON.parse(batch.stdout), legacyRows);
  }
});

test("child rejects invalid collection forms before QMD startup and preserves the legacy form", (t) => {
  const invalidRequests = [
    {},
    { collection: "one", collections: ["one"] },
    { collection: 1 },
    { collection: true },
    { collection: ["one"] },
    { collection: { id: "one" } },
    { collection: null },
    { collections: [] },
    { collections: [1] },
    { collections: [true] },
    { collections: [["one"]] },
    { collections: [{ id: "one" }] },
    { collections: [null] },
    { collections: [1, "1"] },
    { collections: ["one", "one"] },
    { collections: ["one", "bad/collection"] },
    { collections: Array.from({ length: 65 }, (_, index) => `root-${index}`) },
  ];
  for (const request of invalidRequests) {
    const fixture = syntheticQmd(t);
    const child = invokeChild(fixture, request);
    assert.notEqual(child.status, 0);
    assert.equal(JSON.parse(child.stderr).error.code, "INVALID_REQUEST");
    assert.deepEqual(readEvents(fixture.events), []);
  }
  const fixture = syntheticQmd(t);
  const legacy = invokeChild(fixture, { collection: "one" });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(JSON.parse(legacy.stdout).length, 8);
});

test("foreign candidates and mid-batch failures return no content and always clean up", (t) => {
  for (const behavior of ["foreignSecond", "failSecond"]) {
    const fixture = syntheticQmd(t, behavior);
    const child = invokeChild(fixture, { collections: ["one", "two", "three"] });
    assert.notEqual(child.status, 0);
    assert.equal(child.stdout, "");
    const events = readEvents(fixture.events);
    assert.deepEqual(events.slice(-2), ["close", "dispose"]);
    assert.deepEqual(events.filter((event) => event && typeof event === "object").map((event) => event.search), ["one", "two"]);
  }
});

function rootIndex(t, ids, withFiles = true) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "local-search-parent-batch-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const roots = ids.map((id, index) => {
    const rootPath = path.join(base, id);
    fs.mkdirSync(rootPath);
    if (withFiles) fs.writeFileSync(path.join(rootPath, `${id}.md`), `ordinary evidence ${index}\n`);
    return { id, path: rootPath, contentEnabled: true, extensions: [".md"], maxFiles: 10, maxFileBytes: 4096 };
  });
  const config = normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots,
    budgets: { queryDeadlineMs: 10_000, indexDeadlineMs: 10_000, reserveBytes: 1, reserveFraction: 0.000001, quotaBytes: 1024 ** 2 },
  });
  const catalogue = reconcile(config, { publish: false }).catalogue;
  const staged = stage(config, catalogue, "a".repeat(64));
  assert.equal(staged.ok, true);
  for (const item of staged.staged) item.record.indexedHash = item.current.hash;
  catalogue.indexedRevision = "a".repeat(64);
  publish(config, catalogue);
  return { config, catalogue, manifests: loadManifests(config), staged };
}

function fourRootIndex(t) {
  return rootIndex(t, ["one", "two", "three", "four"]);
}

test("zero-record catalogues skip SDK calls without overstating indexed coverage", async (t) => {
  const indexed = rootIndex(t, ["empty-root"], false);
  let calls = 0;
  const options = {
    manifests: indexed.manifests,
    qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }),
    runSdkSearch: async () => { calls += 1; return { ok: true, stdout: "[]" }; },
  };

  const keyword = await search(indexed.config, { query: "missing", mode: "keyword" }, options);
  const indexedKeyword = await search(indexed.config, { query: "missing", mode: "indexed-keyword" }, options);

  assert.equal(calls, 0);
  assert.equal(keyword.status, "completeAsOfSnapshot");
  assert.equal(keyword.lexicalStatus, "available");
  assert.equal(keyword.negativeIsComplete, true);
  assert.equal(indexedKeyword.status, "indexedSubset");
  assert.equal(indexedKeyword.negativeIsComplete, false);
});

test("four selected roots use one SDK request per indexed, lexical, and semantic operation", async (t) => {
  const indexed = fourRootIndex(t);
  const calls = [];
  const options = {
    manifests: indexed.manifests,
    qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }),
    runSdkSearch: async (_config, request) => {
      calls.push(request);
      const collections = request.collections || [request.collection];
      const rows = collections.map((collection, index) => {
        const staged = indexed.staged.staged.find((item) => item.record.rootId === collection);
        return { file: `qmd://${collection}/${staged.filename}`, score: 10 - index };
      });
      return { ok: true, stdout: JSON.stringify(rows) };
    },
  };

  const indexedResult = await search(indexed.config, { query: "ordinary", mode: "indexed-keyword" }, options);
  const autoResult = await search(indexed.config, { query: "concept absent from exact text", mode: "auto" }, options);

  assert.equal(indexedResult.results.length, 4);
  assert.equal(autoResult.results.length, 4);
  assert.deepEqual(indexedResult.results.map((result) => result.rootId), ["one", "two", "three", "four"]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((request) => [request.operation, request.collections]), [
    ["lexical", ["one", "two", "three", "four"]],
    ["lexical", ["one", "two", "three", "four"]],
    ["semantic", ["one", "two", "three", "four"]],
  ]);
});

test("indexed batching preserves requested root order through equal-score capping", async (t) => {
  const indexed = fourRootIndex(t);
  const requested = ["four", "three", "two", "one"];
  const result = await search(indexed.config, { query: "ordinary", mode: "indexed-keyword", roots: requested, maxResults: 2 }, {
    manifests: indexed.manifests,
    qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }),
    runSdkSearch: async (_config, request) => {
      assert.deepEqual(request.collections, requested);
      return { ok: true, stdout: JSON.stringify(request.collections.map((collection) => {
        const staged = indexed.staged.staged.find((item) => item.record.rootId === collection);
        return { file: `qmd://${collection}/${staged.filename}`, score: 10 };
      })) };
    },
  });
  assert.deepEqual(result.results.map((item) => item.rootId), ["four", "three"]);
});

test("sixty-five roots use ordered legacy calls in both parent search paths", async (t) => {
  const ids = Array.from({ length: 65 }, (_, index) => `root-${String(index).padStart(2, "0")}`);
  const indexed = rootIndex(t, ids);
  for (const mode of ["indexed-keyword", "keyword"]) {
    const calls = [];
    const result = await search(indexed.config, { query: "absent", mode }, {
      manifests: indexed.manifests,
      qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }),
      runSdkSearch: async (_config, request) => {
        calls.push(request);
        return { ok: true, stdout: "[]" };
      },
    });

    assert.deepEqual(result.results, []);
    assert.equal(calls.length, 65, mode);
    assert.deepEqual(calls.map((request) => request.collection), ids, mode);
    assert.equal(calls.every((request) => request.limit === 8 && !Object.hasOwn(request, "collections")), true, mode);
  }
});

test("over-64 fallback stops at a deadline without returning partial candidates", async (t) => {
  const originalNow = Date.now;
  let clock = 0;
  Date.now = () => clock;
  t.after(() => { Date.now = originalNow; });
  const calls = [];
  const result = await runSdkSearchCollections({}, {
    operation: "lexical",
    collections: Array.from({ length: 65 }, (_, index) => `root-${index}`),
    query: "needle",
    limit: 8,
  }, {
    deadline: 1,
    invoke: async (_config, request) => {
      calls.push(request.collection);
      clock = 1;
      return { ok: true, stdout: JSON.stringify([{ file: "qmd://root-0/0.md", score: 1 }]) };
    },
  });
  assert.deepEqual(calls, ["root-0"]);
  assert.deepEqual(result, { ok: false, status: "deadlineExpired" });
  assert.equal(Object.hasOwn(result, "stdout"), false);
});

test("parent emits no candidates when the shared child output cap fails closed", async (t) => {
  const indexed = fourRootIndex(t);
  const staged = indexed.staged.staged.find((item) => item.record.rootId === "one");
  const result = await search(indexed.config, { query: "ordinary", mode: "indexed-keyword" }, {
    manifests: indexed.manifests,
    qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }),
    runSdkSearch: async () => ({
      ok: false,
      status: "outputLimit",
      stdout: JSON.stringify([{ file: `qmd://one/${staged.filename}`, score: 100 }]),
    }),
  });
  assert.deepEqual(result.results, []);
});

test("parent refuses candidates outside selected collections", async (t) => {
  const indexed = fourRootIndex(t);
  const result = await search(indexed.config, { query: "not present", mode: "keyword", roots: ["one"] }, {
    manifests: indexed.manifests,
    qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }),
    runSdkSearch: async () => ({
      ok: true,
      stdout: JSON.stringify([{ file: `qmd://two/${indexed.staged.staged.find((item) => item.record.rootId === "two").filename}`, score: 100 }]),
    }),
  });
  assert.deepEqual(result.results, []);
  assert.equal(result.lexicalStatus, "qmdCollectionMismatch");
});

test("parent discards a completed batch after abort or deadline", async (t) => {
  const indexed = fourRootIndex(t);
  const candidate = { file: `qmd://one/${indexed.staged.staged.find((item) => item.record.rootId === "one").filename}`, score: 100 };
  const controller = new AbortController();
  const aborted = await search(indexed.config, { query: "not present", mode: "keyword" }, {
    manifests: indexed.manifests,
    signal: controller.signal,
    qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }),
    runSdkSearch: async () => { controller.abort(); return { ok: true, stdout: JSON.stringify([candidate]) }; },
  });
  assert.deepEqual(aborted.results, []);
  assert.equal(aborted.lexicalStatus, "aborted");

  const deadlineConfig = normalizeConfig({
    ...indexed.config,
    budgets: { ...indexed.config.budgets, queryDeadlineMs: 1 },
  });
  const expired = await search(deadlineConfig, { query: "not present", mode: "keyword" }, {
    manifests: indexed.manifests,
    qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }),
    runSdkSearch: async () => {
      const end = Date.now() + 3;
      while (Date.now() < end) {}
      return { ok: true, stdout: JSON.stringify([candidate]) };
    },
  });
  assert.deepEqual(expired.results, []);
  assert.equal(expired.lexicalStatus, "deadlineExpired");
});

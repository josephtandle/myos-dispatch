"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { publish, reconcile } = require("../catalogue");
const { normalizeConfig } = require("../config");
const { extractionKey } = require("../hydration");
const { parseCandidates } = require("../qmd");
const { search } = require("../search");

function fixture(t, text) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "semantic-passage-test-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "docs");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "design.md"), text);
  const config = normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "docs", path: root, contentEnabled: true, extensions: [".md"], maxFiles: 10, maxFileBytes: 64 * 1024 }],
    budgets: { queryDeadlineMs: 2_000, indexDeadlineMs: 2_000, reserveBytes: 1, reserveFraction: 0.000001, quotaBytes: 1024 ** 2 },
  });
  const fresh = reconcile(config);
  const record = fresh.catalogue.records[0];
  record.indexedHash = record.observedHash;
  publish(config, fresh.catalogue);
  return {
    config,
    record,
    manifests: { docs: { [`${record.sourceId}.md`]: { sourceId: record.sourceId, hash: record.observedHash } } },
  };
}

function semanticAdapters(record, manifests, semantic) {
  return {
    manifests,
    qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }),
    runSdkSearch: async () => ({
      ok: true,
      stdout: JSON.stringify([{ file: `qmd://docs/${record.sourceId}.md`, score: 0.9, semantic }]),
    }),
  };
}

test("semantic passage position anchors a paraphrase-only match late in the file", async (t) => {
  const late = "The nocturnal backup quietly restores the durable journal after a restart.\n";
  const text = `${"unrelated opening material\n".repeat(20)}${late}`;
  const { config, record, manifests } = fixture(t, text);
  const chunkPos = text.indexOf(late);

  const result = await search(config, { query: "How does recovery work?", mode: "semantic", maxBytes: 110 }, semanticAdapters(record, manifests, {
    chunkPos,
    contentHash: crypto.createHash("sha256").update(text).digest("hex"),
  }));

  assert.match(result.results[0].snippet, /nocturnal backup/);
  assert.equal(result.results[0].anchorStatus, "semanticPassage");
});

test("a lexical passage takes precedence over the start of a winning semantic chunk", async (t) => {
  const late = "The late lexical beacon identifies the exact recovery paragraph.\n";
  const text = `${"unrelated opening material\n".repeat(20)}${late}`;
  const { config, record, manifests } = fixture(t, text);

  const result = await search(config, { query: "late lexical beacon", mode: "semantic", maxBytes: 110 }, semanticAdapters(record, manifests, {
    chunkPos: 0,
    contentHash: crypto.createHash("sha256").update(text).digest("hex"),
  }));

  assert.equal(result.results[0].snippet, `unrelated opening material\n${late}`);
  assert.equal(result.results[0].anchorStatus, "bestLexicalPassage");
});

test("the SDK child output survives parsing, lexical-first fusion, and packet emission", async (t) => {
  const late = "A cobalt lantern preserves the checkpoint across an abrupt restart.\n";
  const text = `😀${"ordinary preface\n".repeat(18)}${late}`;
  const { config, record, manifests } = fixture(t, text);
  const packageRoot = path.join(path.dirname(config.stateDirectory), "synthetic-qmd");
  const dist = path.join(packageRoot, "dist");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@tobilu/qmd", version: "2.8.3", type: "module" }));
  const row = {
    filepath: `qmd://docs/${record.sourceId}.md`,
    score: 0.9,
    body: text,
    hash: crypto.createHash("sha256").update(text).digest("hex"),
    chunkPos: text.indexOf(late),
  };
  const mismatched = { ...row, hash: "f".repeat(64) };
  const missingBody = { filepath: row.filepath, score: 0.7, hash: row.hash, chunkPos: row.chunkPos };
  fs.writeFileSync(path.join(dist, "index.js"), `export async function createStore(){return {searchLex:async()=>${JSON.stringify([row, mismatched, missingBody])},close:async()=>{}}}`);
  fs.writeFileSync(path.join(dist, "llm.js"), "export async function disposeDefaultLlamaCpp(){}\n");
  const dbPath = path.join(config.stateDirectory, "synthetic.sqlite");
  fs.mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(dbPath, Buffer.from("SQLite format 3\0"), { mode: 0o600 });
  const child = spawnSync(process.execPath, [path.resolve(__dirname, "../qmd-sdk-child.mjs")], {
    encoding: "utf8",
    input: JSON.stringify({
      operation: "lexical", packageRoot, dbPath, collection: "docs", query: "recovery behavior",
      limit: 3, stateDirectory: config.stateDirectory,
    }),
    timeout: 5_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const childRows = JSON.parse(child.stdout);
  assert.equal(Object.hasOwn(childRows[0], "body"), false);
  assert.equal(Object.hasOwn(childRows[1], "semantic"), false);
  assert.equal(Object.hasOwn(childRows[2], "body"), false);
  assert.equal(Object.hasOwn(childRows[2], "semantic"), false);
  assert.deepEqual(parseCandidates(child.stdout, manifests).candidates[0].semantic, {
    chunkPos: row.chunkPos,
    contentHash: row.hash,
  });

  const result = await search(config, { query: "How is recovery handled?", mode: "auto", maxBytes: 100 }, {
    manifests,
    qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }),
    runSdkSearch: async (_config, request) => request.operation === "semantic"
      ? { ok: true, stdout: JSON.stringify([childRows[0]]) }
      : { ok: true, stdout: JSON.stringify([{ file: row.filepath, score: 0.8 }]) },
  });

  assert.equal(result.results[0].mode, "auto");
  assert.equal(result.results[0].anchorStatus, "semanticPassage");
  assert.match(result.results[0].snippet, /cobalt lantern/);
});

test("semantic offsets are UTF-16 positions and reject unsafe or stale boundaries", async (t) => {
  const late = "Verified passage after emoji.\n";
  const text = `😀${"opening\n".repeat(12)}${late}`;
  const { config, record, manifests } = fixture(t, text);
  const contentHash = crypto.createHash("sha256").update(text).digest("hex");
  const valid = text.indexOf(late);
  const cases = [
    { semantic: { chunkPos: valid, contentHash }, expected: "semanticPassage" },
    { semantic: null, expected: "noLexicalAnchorBeginningFallback" },
    { semantic: { chunkPos: -1, contentHash }, expected: "noLexicalAnchorBeginningFallback" },
    { semantic: { chunkPos: text.length, contentHash }, expected: "noLexicalAnchorBeginningFallback" },
    { semantic: { chunkPos: 1, contentHash }, expected: "noLexicalAnchorBeginningFallback" },
    { semantic: { chunkPos: valid, contentHash: "f".repeat(64) }, expected: "noLexicalAnchorBeginningFallback" },
    { semantic: { chunkPos: "4", contentHash }, expected: "noLexicalAnchorBeginningFallback" },
  ];

  for (const entry of cases) {
    const result = await search(config, { query: "words absent everywhere", mode: "semantic", maxBytes: 80 }, semanticAdapters(record, manifests, entry.semantic));
    assert.equal(result.results[0].anchorStatus, entry.expected);
    if (entry.expected === "semanticPassage") assert.match(result.results[0].snippet, /Verified passage/);
    else assert.match(result.results[0].snippet, /^😀opening/);
  }
});

test("Office semantic passages use extracted-text hashes and stay inside their native segment", async (t) => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "semantic-office-test-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "docs");
  fs.mkdirSync(root);
  const source = Buffer.from("synthetic-office\0binary");
  fs.writeFileSync(path.join(root, "notes.docx"), source);
  const config = normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "docs", path: root, contentEnabled: true, extensions: [".docx"], maxFiles: 10, maxFileBytes: 64 * 1024 }],
    budgets: { queryDeadlineMs: 2_000, indexDeadlineMs: 2_000, reserveBytes: 1, reserveFraction: 0.000001, quotaBytes: 1024 ** 2 },
    parser: { pythonPath: "/opt/local/python3", timeoutMs: 1_000 },
  });
  const first = "😀 First paragraph has no answer.\n";
  const second = "Second paragraph contains the violet compass.\n";
  const extracted = `${first}${second}`;
  const sourceHash = crypto.createHash("sha256").update(source).digest("hex");
  const fingerprint = "a".repeat(64);
  const key = extractionKey(sourceHash, fingerprint);
  const fresh = reconcile(config);
  const record = fresh.catalogue.records[0];
  record.indexedHash = sourceHash;
  record.indexedExtractionKey = key;
  publish(config, fresh.catalogue);
  const manifests = { docs: { [`${record.sourceId}.md`]: { sourceId: record.sourceId, hash: sourceHash, extractionKey: key } } };
  const extractDocument = async () => ({
    text: extracted, sourceHash, parserIdentity: {}, parserFingerprint: fingerprint,
    segments: [
      { start: 0, end: first.length, locator: { paragraph: 1 } },
      { start: first.length, end: extracted.length, locator: { paragraph: 2 } },
    ],
    coverage: { status: "complete", limitations: [] }, complete: true,
  });
  const semantic = { chunkPos: first.length, contentHash: crypto.createHash("sha256").update(extracted).digest("hex") };

  const result = await search(config, { query: "Which direction should we take?", mode: "semantic", maxBytes: 200 }, {
    ...semanticAdapters(record, manifests, semantic), extractDocument,
  });
  const hit = result.results[0];

  assert.match(hit.snippet, /violet compass/);
  assert.doesNotMatch(hit.snippet, /First paragraph/);
  assert.deepEqual(hit.sourceLocators, [{ paragraph: 2 }]);
  assert.equal(Object.hasOwn(hit, "locator"), false);
  assert.equal(hit.truncated, true);
  assert.equal(hit.contextIncomplete, true);
  assert.equal(Buffer.from(extracted).subarray(hit.extractedTextLocator.byteOffset, hit.extractedTextLocator.byteOffset + Buffer.byteLength(hit.snippet)).toString("utf8"), hit.snippet);
});

test("Office semantic positions in extraction gaps advance to the next segment", async (t) => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "semantic-office-gap-test-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "docs");
  fs.mkdirSync(root);
  const source = Buffer.from("synthetic-office-gap\0binary");
  fs.writeFileSync(path.join(root, "notes.docx"), source);
  const config = normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "docs", path: root, contentEnabled: true, extensions: [".docx"], maxFiles: 10, maxFileBytes: 64 * 1024 }],
    budgets: { queryDeadlineMs: 2_000, indexDeadlineMs: 2_000, reserveBytes: 1, reserveFraction: 0.000001, quotaBytes: 1024 ** 2 },
    parser: { pythonPath: "/opt/local/python3", timeoutMs: 1_000 },
  });
  const first = "😀 First slide has no answer.";
  const separator = "\n";
  const second = "Second slide contains the amber sextant.";
  const extracted = `${first}${separator}${second}`;
  const sourceHash = crypto.createHash("sha256").update(source).digest("hex");
  const fingerprint = "b".repeat(64);
  const key = extractionKey(sourceHash, fingerprint);
  const fresh = reconcile(config);
  const record = fresh.catalogue.records[0];
  record.indexedHash = sourceHash;
  record.indexedExtractionKey = key;
  publish(config, fresh.catalogue);
  const manifests = { docs: { [`${record.sourceId}.md`]: { sourceId: record.sourceId, hash: sourceHash, extractionKey: key } } };
  const segments = [
    { start: 0, end: first.length, locator: { slide: 1 } },
    { start: first.length + separator.length, end: extracted.length, locator: { slide: 2 } },
  ];
  assert.equal(segments[0].end + 1, segments[1].start);
  const extractDocument = async () => ({
    text: extracted, sourceHash, parserIdentity: {}, parserFingerprint: fingerprint,
    segments, coverage: { status: "complete", limitations: [] }, complete: true,
  });
  const semantic = {
    chunkPos: segments[0].end,
    contentHash: crypto.createHash("sha256").update(extracted).digest("hex"),
  };

  const result = await search(config, { query: "Which navigation tool?", mode: "semantic", maxBytes: 200 }, {
    ...semanticAdapters(record, manifests, semantic), extractDocument,
  });
  const hit = result.results[0];

  assert.equal(hit.snippet, second);
  assert.deepEqual(hit.sourceLocators, [{ slide: 2 }]);
  assert.equal(hit.extractedTextLocator.byteOffset, Buffer.byteLength(`${first}${separator}`));
  assert.equal(hit.hash, sourceHash);
});

test("a source changed before semantic packet emission is omitted", async (t) => {
  const text = `${"opening\n".repeat(10)}late semantic passage\n`;
  const { config, record, manifests } = fixture(t, text);
  let changed = false;
  const result = await search(config, { query: "unrelated paraphrase", mode: "semantic" }, {
    ...semanticAdapters(record, manifests, {
      chunkPos: text.indexOf("late"),
      contentHash: crypto.createHash("sha256").update(text).digest("hex"),
    }),
    beforeEmit() {
      if (!changed) {
        changed = true;
        fs.writeFileSync(path.join(config.roots[0].path, "design.md"), "replacement content");
      }
    },
  });

  assert.equal(result.results.length, 0);
  assert.ok(result.sourceUnavailable.some((item) => item.status === "changedBeforeEmission"));
});

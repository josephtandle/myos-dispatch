"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFile, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const api = require("..");
const { normalizeConfig, writeConfig } = require("../config");
const { publish, reconcile } = require("../catalogue");
const { acquire } = require("../maintenance");
const { validateEmbedResult } = require("../embed-result");
const { environment: qmdEnvironment, parseCandidates, qmdStatus, runQmd, verifyModels } = require("../qmd");
const { readVerified } = require("../scope");
const { stage } = require("../staging");

function fixture(t, overrides = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "local-search-test-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "docs");
  const stateDirectory = path.join(base, "state");
  fs.mkdirSync(root);
  const input = {
    enabled: true,
    stateDirectory,
    roots: [{ id: "docs", path: root, contentEnabled: true, extensions: [".md", ".txt", ".json", ".yaml", ".bin"], maxFiles: 50, maxFileBytes: 4096 }],
    budgets: { pollIntervalMs: 25, queryDeadlineMs: 2000, indexDeadlineMs: 2000, reserveBytes: 1, reserveFraction: 0.000001, quotaBytes: 1024 ** 2 },
    ...overrides,
  };
  return { base, root, stateDirectory, input, config: normalizeConfig(input) };
}

test("package pins the supported Node 24 runtime", () => {
  const manifest = require("../package.json");
  assert.equal(manifest.engines.node, "24.x");
});

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test("import is inert and disabled configuration performs no writes", async (t) => {
  const f = fixture(t, { enabled: false });
  assert.equal(fs.existsSync(f.stateDirectory), false);
  assert.equal((await api.status(f.config)).status, "disabled");
  assert.equal(fs.existsSync(f.stateDirectory), false);
});

test("enabled root supports metadata, keyword packets, and estimate-only token labelling", async (t) => {
  const f = fixture(t);
  write(path.join(f.root, "notes.md"), "First line\nFresh apricot fact\n");
  const metadata = await api.search(f.config, { query: "notes", mode: "filename" });
  assert.equal(metadata.results[0].relative, "notes.md");
  assert.equal(Object.hasOwn(metadata.results[0], "snippet"), false);
  const content = await api.search(f.config, { query: "apricot", mode: "keyword", maxTokens: 8 });
  assert.match(content.results[0].snippet, /apricot/i);
  assert.equal(content.tokenEstimateMethod, "characters_divided_by_four_estimate_only");
  assert.equal(content.taskClass, "cheap_routing");
});

test("metadata-only files never expose their contents", async (t) => {
  const f = fixture(t);
  write(path.join(f.root, "opaque.bin"), "metadata-only needle");
  const filename = await api.search(f.config, { query: "opaque", mode: "filename" });
  assert.equal(filename.results[0].relative, "opaque.bin");
  assert.equal(Object.hasOwn(filename.results[0], "snippet"), false);
  const content = await api.search(f.config, { query: "needle", mode: "keyword" });
  assert.equal(content.results.length, 0);
});

test("search and read enforce maxBytes on UTF-8 bytes", async (t) => {
  const f = fixture(t);
  write(path.join(f.root, "unicode.md"), "needle🙂🙂🙂");
  const searched = await api.search(f.config, { query: "needle", mode: "keyword", maxBytes: 9 });
  assert.ok(searched.bytes <= 9);
  assert.ok(Buffer.byteLength(searched.results[0].snippet) <= 9);
  const read = await api.read(f.config, { sourceId: searched.results[0].sourceId, maxBytes: 9 });
  assert.ok(read.bytes <= 9);
  assert.equal(read.text.includes("�"), false);
});

test("requests reject malformed bounds, duplicates, and unknown roots", async (t) => {
  const f = fixture(t);
  await assert.rejects(api.search(f.config, { query: "x", maxResults: 9 }), { code: "INVALID_REQUEST" });
  await assert.rejects(api.search(f.config, { query: "x", roots: ["docs", "docs"] }), { code: "INVALID_REQUEST" });
  await assert.rejects(api.search(f.config, { query: "x", roots: ["elsewhere"] }), { code: "INVALID_REQUEST" });
});

test("configuration rejects unsafe paths, duplicate roots, and remote model paths", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "local-search-config-"));
  const root = path.join(base, "root"); fs.mkdirSync(root);
  const one = { id: "a", path: root, extensions: [".md"] };
  assert.throws(() => normalizeConfig({ enabled: true, stateDirectory: path.join(root, "state"), roots: [one] }), /outside|overlap/);
  assert.throws(() => normalizeConfig({ enabled: true, stateDirectory: path.join(base, "state"), roots: [one, one] }), /duplicate/);
  assert.throws(() => normalizeConfig({ enabled: false, stateDirectory: "relative", roots: [] }), /absolute/);
  assert.throws(() => normalizeConfig({ enabled: true, stateDirectory: path.join(base, "state"), roots: [one], qmd: { nodePath: "/bin/node", packageRoot: "/tmp/qmd", modelPaths: { embed: "https://host/model.gguf" } } }), /absolute/);
  fs.rmSync(base, { recursive: true, force: true });
});

test("configuration refuses an approved browser profile root", () => {
  const browserRoot = "/Users/example/Library/Application Support/Google/Chrome/Default";
  assert.throws(() => normalizeConfig({
    enabled: true,
    stateDirectory: "/private/tmp/local-search-state",
    roots: [{ id: "browser", path: browserRoot, contentEnabled: true, extensions: [".txt"] }],
  }), /sensitive|browser/i);
});

test("hidden, secret, browser, cloud, symlink, and hardlink paths are denied", async (t) => {
  const f = fixture(t);
  write(path.join(f.root, "ordinary.md"), "plain text");
  write(path.join(f.root, ".env.production"), "kiwi secret");
  write(path.join(f.root, "credentials.txt"), "kiwi secret");
  write(path.join(f.root, ".hidden", "note.md"), "kiwi hidden");
  write(path.join(f.root, "BrowserProfiles", "note.md"), "kiwi browser");
  write(path.join(f.root, "Library", "CloudStorage", "note.md"), "kiwi cloud");
  fs.symlinkSync(path.join(f.root, "ordinary.md"), path.join(f.root, "alias.md"));
  fs.linkSync(path.join(f.root, "ordinary.md"), path.join(f.root, "hard.md"));
  const result = await api.search(f.config, { query: "kiwi", mode: "keyword" });
  assert.equal(result.results.length, 0);
  assert.ok(result.sourceUnavailable.some((item) => item.reason === "hardlinkDenied"));
});

test("secret content is denied consistently in live keyword and filename search", async (t) => {
  const f = fixture(t);
  write(path.join(f.root, "ordinary.md"), "password=supersecretvalue needle");
  const keyword = await api.search(f.config, { query: "needle", mode: "keyword" });
  const filename = await api.search(f.config, { query: "ordinary", mode: "filename" });
  assert.equal(keyword.results.length, 0);
  assert.equal(filename.results.length, 0);
  assert.ok(keyword.sourceUnavailable.some((item) => item.reason === "secretPatternDenied"));
});

test("quoted JSON and YAML secret values are denied and agent Chrome cannot be approved", async (t) => {
  const f = fixture(t);
  write(path.join(f.root, "settings.json"), JSON.stringify({ apiKey: "synthetic-example-value", marker: "needle" }));
  write(path.join(f.root, "settings.yaml"), "access_token: 'synthetic-example-value'\nmarker: needle\n");
  for (const mode of ["keyword", "filename"]) {
    const result = await api.search(f.config, { query: mode === "keyword" ? "needle" : "settings", mode });
    assert.equal(result.results.length, 0);
    assert.ok(result.sourceUnavailable.some((item) => item.reason === "secretPatternDenied"));
  }
  assert.throws(() => normalizeConfig({
    enabled: true,
    stateDirectory: "/private/tmp/local-search-state",
    roots: [{ id: "browser", path: "/Users/example/.myos/agent-chrome", contentEnabled: true, extensions: [".json"] }],
  }), /sensitive|browser/i);
});

test("oversized, binary, and invalid UTF-8 files are explicitly unavailable", async (t) => {
  const f = fixture(t);
  f.input.roots[0].maxFileBytes = 8;
  const config = normalizeConfig(f.input);
  write(path.join(f.root, "large.txt"), "0123456789");
  write(path.join(f.root, "nul.txt"), Buffer.from([65, 0, 66]));
  write(path.join(f.root, "bad.txt"), Buffer.from([0xc3, 0x28]));
  const reasons = new Set((await api.search(config, { query: "A", mode: "keyword" })).sourceUnavailable.map((item) => item.reason));
  assert.ok(reasons.has("sizeLimit"));
  assert.ok(reasons.has("unsupportedBinary") || reasons.has("invalidUtf8"));
});

test("query reconciliation observes same-size preserved-mtime edit, rename, and delete", async (t) => {
  const f = fixture(t);
  const original = path.join(f.root, "one.txt");
  write(original, "alpha");
  assert.equal((await api.search(f.config, { query: "alpha", mode: "keyword" })).results.length, 1);
  const before = fs.statSync(original);
  write(original, "bravo"); fs.utimesSync(original, before.atime, before.mtime);
  assert.equal((await api.search(f.config, { query: "bravo", mode: "keyword" })).results.length, 1);
  assert.equal((await api.search(f.config, { query: "alpha", mode: "keyword" })).results.length, 0);
  const renamed = path.join(f.root, "two.txt"); fs.renameSync(original, renamed);
  assert.equal((await api.search(f.config, { query: "two", mode: "filename" })).results[0].relative, "two.txt");
  fs.unlinkSync(renamed);
  assert.equal((await api.search(f.config, { query: "bravo", mode: "keyword" })).results.length, 0);
});

test("verified read rejects atomic replacement at its final path barrier", (t) => {
  const f = fixture(t);
  const file = path.join(f.root, "replace.txt");
  write(file, "first");
  const result = readVerified(f.config.roots[0], file, {
    beforeFinalVerification() {
      const replacement = path.join(f.root, "replacement.txt");
      write(replacement, "other");
      fs.renameSync(replacement, file);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "changedDuringRead");
});

test("new files are live lexical results before semantic indexing", async (t) => {
  const f = fixture(t); write(path.join(f.root, "new.md"), "uncatalogued kumquat");
  const result = await api.search(f.config, { query: "kumquat", mode: "auto" });
  assert.equal(result.results[0].mode, "keyword");
  assert.equal(result.semanticPending, true);
  assert.equal(result.semanticStatus, "notConfigured");
});

test("staging identity binds a source to the bytes ranked by QMD", (t) => {
  const f = fixture(t);
  const file = path.join(f.root, "changing.md");
  write(file, "revision A orange cats");
  const stagedA = stage(f.config, reconcile(f.config, { publish: false }).catalogue, "a".repeat(64));
  write(file, "revision B orchard irrigation");
  const stagedB = stage(f.config, reconcile(f.config, { publish: false }).catalogue, "b".repeat(64));
  const fileA = Object.keys(stagedA.manifests.docs)[0];
  const fileB = Object.keys(stagedB.manifests.docs)[0];
  assert.notEqual(fileA, fileB);
  assert.equal(parseCandidates(JSON.stringify([{ file: `qmd://docs/${fileB}`, score: 1 }]), stagedA.manifests).candidates.length, 0);
});

test("embedding validation accepts the pinned SDK no-work result", () => {
  assert.equal(validateEmbedResult({ docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 }), true);
  assert.equal(validateEmbedResult({ docsProcessed: 1, chunksEmbedded: 2, errors: 0, failures: [] }), true);
});

test("embedding validation rejects malformed, partial, and failed results", () => {
  const invalid = [
    null,
    {},
    { chunksEmbedded: 0, errors: 0, durationMs: 0 },
    { docsProcessed: 0, errors: 0, durationMs: 0 },
    { docsProcessed: 0, chunksEmbedded: 0, durationMs: 0 },
    { docsProcessed: -1, chunksEmbedded: 0, errors: 0, durationMs: 0 },
    { docsProcessed: 0.5, chunksEmbedded: 0, errors: 0, durationMs: 0 },
    { docsProcessed: 0, chunksEmbedded: Number.MAX_SAFE_INTEGER + 1, errors: 0, durationMs: 0 },
    { docsProcessed: 0, chunksEmbedded: 0, errors: 1, durationMs: 0 },
    { docsProcessed: 0, chunksEmbedded: 0, errors: 0, failures: {}, durationMs: 0 },
    { docsProcessed: 0, chunksEmbedded: 0, errors: 0, failures: [{ reason: "failed" }], durationMs: 0 },
    { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: -1 },
    { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: Infinity },
  ];
  for (const result of invalid) assert.equal(validateEmbedResult(result), false);
});

test("ordinary maintenance recovers an interrupted owned staging temp", async (t) => {
  const f = fixture(t);
  write(path.join(f.root, "recover.md"), "recoverable content");
  const directory = path.join(f.stateDirectory, "staging", "docs");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `${"a".repeat(64)}.md.12345.tmp`);
  fs.writeFileSync(temporary, "interrupted", { mode: 0o600 });

  const result = await api.index(f.config, { adapters: {
    qmdStatus: () => ({ available: true, semanticAvailable: false, status: "available" }),
    updateIndex: async () => ({ ok: true, status: "indexed", indexed: 1 }),
  } });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(temporary), false);
});

test("staging preflight preserves owned cache when an unrelated entry is present", (t) => {
  const f = fixture(t);
  write(path.join(f.root, "safe.md"), "safe content");
  const directory = path.join(f.stateDirectory, "staging", "docs");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const owned = path.join(directory, `${"b".repeat(64)}.md`);
  const unrelated = path.join(directory, "unrelated.tmp");
  fs.writeFileSync(owned, "owned", { mode: 0o600 });
  fs.writeFileSync(unrelated, "unrelated", { mode: 0o600 });

  assert.throws(() => stage(f.config, reconcile(f.config, { publish: false }).catalogue, "c".repeat(64)), { code: "STAGING_CORRUPT" });
  assert.equal(fs.readFileSync(owned, "utf8"), "owned");
  assert.equal(fs.readFileSync(unrelated, "utf8"), "unrelated");
});

test("staging rejects and preserves an unsafe owned-temp symlink", (t) => {
  const f = fixture(t);
  write(path.join(f.root, "safe.md"), "safe content");
  const directory = path.join(f.stateDirectory, "staging", "docs");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const outside = path.join(f.base, "outside");
  fs.writeFileSync(outside, "outside", { mode: 0o600 });
  const temporary = path.join(directory, `${"d".repeat(64)}.md.2468.tmp`);
  fs.symlinkSync(outside, temporary);

  assert.throws(() => stage(f.config, reconcile(f.config, { publish: false }).catalogue, "e".repeat(64)), { code: "STAGING_CORRUPT" });
  assert.equal(fs.lstatSync(temporary).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(outside, "utf8"), "outside");
});

test("semantic mode overlays a fresh lexical match and marks incomplete coverage", async (t) => {
  const f = fixture(t);
  write(path.join(f.root, "fresh.md"), "brand-new loquat evidence");
  const result = await api.search(f.config, { query: "loquat", mode: "semantic" });
  assert.equal(result.results[0].mode, "keyword");
  assert.equal(result.semanticPending, true);
  assert.equal(result.negativeIsComplete, false);
});

test("stale mapped QMD hits cannot return old text after a preserved-mtime edit", async (t) => {
  const model = path.join(os.tmpdir(), `fake-${process.pid}.gguf`); write(model, "model"); t.after(() => fs.rmSync(model, { force: true }));
  const f = fixture(t, { qmd: { nodePath: process.execPath, packageRoot: path.resolve(__dirname, ".."), modelPaths: { embed: model } } });
  const file = path.join(f.root, "stale.txt"); write(file, "old value");
  const first = reconcile(f.config); const record = first.catalogue.records[0];
  record.indexedHash = record.observedHash; publish(f.config, first.catalogue);
  const stat = fs.statSync(file); write(file, "new value"); fs.utimesSync(file, stat.atime, stat.mtime);
  const result = await api.search(f.config, { query: "old", mode: "semantic" }, {
    manifests: { docs: { [`${record.sourceId}.md`]: record.sourceId } },
    qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }),
    runSdkSearch: async () => ({ ok: true, stdout: JSON.stringify([{ score: 0.9, file: `qmd://docs/${record.sourceId}.md?index=1` }]) }),
  });
  assert.equal(result.results.length, 0);
  assert.equal(result.semanticStatus, "staleReevaluatedSemanticPending");
  const fresh = await api.search(f.config, { query: "new", mode: "semantic" }, {
    manifests: { docs: { [`${record.sourceId}.md`]: record.sourceId } },
    qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }),
    runSdkSearch: async () => ({ ok: true, stdout: JSON.stringify([{ score: 0.9, file: `qmd://docs/${record.sourceId}.md?index=1` }]) }),
  });
  assert.match(fresh.results[0].snippet, /new value/);
  assert.doesNotMatch(fresh.results[0].snippet, /old value/);
});

test("packet emission drops a selected lexical source that becomes irrelevant", async (t) => {
  const f = fixture(t);
  const file = path.join(f.root, "barrier.md");
  write(file, "needle stays selected");
  let changed = false;
  const result = await api.search(f.config, { query: "needle", mode: "keyword" }, {
    beforeEmit() {
      if (!changed) { changed = true; write(file, "entirely unrelated"); }
    },
  });
  assert.equal(result.results.length, 0);
  assert.ok(result.sourceUnavailable.some((item) => item.status === "changedBeforeEmission"));
});

test("QMD candidates fail closed on malformed JSON, timeout, and arbitrary paths", async (t) => {
  assert.equal(parseCandidates("not-json", {}).status, "malformedQmdJson");
  assert.deepEqual(parseCandidates(JSON.stringify([{ score: 1, file: "file:///etc/passwd" }]), {}).candidates, []);
  const f = fixture(t); write(path.join(f.root, "one.md"), "semantic text");
  const result = await api.search(f.config, { query: "semantic", mode: "semantic" }, {
    qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }), runSdkSearch: async () => ({ ok: false, status: "timeout" }),
  });
  assert.equal(result.semanticStatus, "timeout");
  assert.equal(result.results[0].mode, "keyword");
  assert.equal(result.negativeIsComplete, false);
});

test("keyword and semantic query use only operation-shaped SDK search adapters", async (t) => {
  const f = fixture(t); write(path.join(f.root, "sdk.md"), "literal query words");
  const fresh = reconcile(f.config); const record = fresh.catalogue.records[0];
  record.indexedHash = record.observedHash; publish(f.config, fresh.catalogue);
  const operations = [];
  const options = {
    manifests: { docs: { [`${record.sourceId}.md`]: { sourceId: record.sourceId, hash: record.observedHash } } },
    qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }),
    runSdkSearch: async (_config, request) => {
      operations.push(request.operation);
      return { ok: true, stdout: JSON.stringify([{ file: `qmd://docs/${record.sourceId}.md`, score: 0.8 }]) };
    },
  };
  await api.search(f.config, { query: "literal query words", mode: "keyword" }, options);
  assert.deepEqual(operations, ["lexical"]);
  operations.length = 0;
  const semantic = await api.search(f.config, { query: "literal query words", mode: "semantic" }, options);
  assert.deepEqual(operations, ["semantic"]);
  assert.equal(semantic.negativeIsComplete, false);
});

test("QMD model environment is explicit and model files require GGUF headers", (t) => {
  const f = fixture(t);
  const model = path.join(f.base, "embed.gguf");
  write(model, "not-a-gguf");
  const qmd = { nodePath: process.execPath, packageRoot: f.base, modelPaths: { embed: model }, modelHashes: {} };
  const config = { ...f.config, qmd };
  assert.throws(() => verifyModels(config), { code: "MODEL_INVALID_GGUF" });
  write(model, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(16)]));
  verifyModels(config);
  const env = qmdEnvironment(config);
  assert.equal(env.QMD_EMBED_MODEL, model);
  assert.equal(Object.hasOwn(env, "HTTPS_PROXY"), false);
});

test("QMD timeout drains its owned process group", async (t) => {
  const f = fixture(t);
  const packageRoot = path.join(f.base, "qmd");
  const model = path.join(f.base, "embed.gguf");
  write(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@tobilu/qmd", version: "2.8.3" }));
  write(path.join(packageRoot, "bin", "qmd"), "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000);");
  for (const relative of ["dist/index.js", "dist/llm.js", "dist/store.js"]) write(path.join(packageRoot, relative), '"use strict";\n');
  write(model, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(16)]));
  const config = normalizeConfig({ ...f.input, qmd: { nodePath: process.execPath, packageRoot, modelPaths: { embed: model }, timeoutMs: 1000, outputBytes: 4096 } });
  const available = qmdStatus(config);
  if (!available.available) {
    const unsupported = new Set(["strictNetworkEnforcementUnsupported", "strictNetworkEnforcementUnavailable"]);
    if (unsupported.has(available.status)) return t.skip(`QMD timeout test requires macOS sandbox enforcement: ${available.status}`);
    assert.fail(`Synthetic pinned QMD fixture is unavailable: ${available.status}`);
  }
  const result = await runQmd(config, [], { timeoutMs: 1000 });
  assert.equal(result.status, "timeout");
  const childPid = Number(result.stdout.trim());
  assert.ok(Number.isSafeInteger(childPid));
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
});

test("offline reconciliation preserves rows and cannot claim a complete negative", async (t) => {
  const f = fixture(t); write(path.join(f.root, "kept.md"), "preserve me"); reconcile(f.config);
  fs.renameSync(f.root, `${f.root}-offline`);
  const partial = reconcile(f.config);
  assert.equal(partial.complete, false);
  assert.equal(partial.catalogue.records[0].relative, "kept.md");
  assert.equal((await api.search(f.config, { query: "missing", mode: "filename" })).negativeIsComplete, false);
});

test("selected-root search does not reconcile unrelated offline roots and reports scan budget", async (t) => {
  const f = fixture(t);
  const other = path.join(f.base, "other"); fs.mkdirSync(other);
  const input = { ...f.input,
    roots: [...f.input.roots, { ...f.input.roots[0], id: "other", path: other }],
    budgets: { ...f.input.budgets, maxContentScanBytes: 4 },
  };
  const config = normalizeConfig(input);
  write(path.join(f.root, "large.md"), "needle");
  fs.rmdirSync(other);
  const result = await api.search(config, { query: "needle", mode: "keyword", roots: ["docs"] });
  assert.equal(result.status, "partial");
  assert.equal(result.contentScan.exceeded, true);
  assert.equal(result.sourceUnavailable.some((item) => item.path === other), false);
});

test("unchanged indexing publishes refreshed metadata and replacement clears every inherited hash", async (t) => {
  const f = fixture(t);
  const file = path.join(f.root, "meta.bin"); write(file, "opaque");
  const first = reconcile(f.config);
  first.catalogue.indexedRevision = crypto.createHash("sha256").update("").digest("hex");
  first.catalogue.semanticPending = false;
  first.catalogue.records[0].indexedHash = "historical";
  publish(f.config, first.catalogue);
  const oldReconciledAt = first.catalogue.reconciledAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  fs.utimesSync(file, new Date(), new Date());
  const unchanged = await api.index(f.config, { testOnlyInProcess: true });
  assert.equal(unchanged.status, "unchanged");
  assert.notEqual(require("../catalogue").loadCatalogue(f.config).reconciledAt, oldReconciledAt);

  const oldRoot = `${f.root}-old`; fs.renameSync(f.root, oldRoot); fs.mkdirSync(f.root);
  write(path.join(f.root, "a.md"), "a"); write(path.join(f.root, "b.md"), "b");
  const limited = normalizeConfig({ ...f.input, roots: [{ ...f.input.roots[0], maxFiles: 1 }] });
  const replaced = reconcile(limited, { publish: false });
  assert.equal(replaced.complete, false);
  assert.ok(replaced.catalogue.records.every((record) => record.indexedHash === null));
});

test("partial embedding and cleanup failures retain semantic pending", async (t) => {
  for (const failure of ["embed", "finish"]) {
    const f = fixture(t);
    write(path.join(f.root, `${failure}.md`), "semantic evidence");
    const result = await api.index(f.config, { adapters: {
      qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }),
      updateIndex: async () => ({ ok: true, status: "indexed", indexed: 1 }),
      embedCollection: async () => failure === "embed" ? ({ ok: false, status: "embeddingFailed" }) : ({ ok: true }),
      finish: async () => { if (failure === "finish") throw new Error("cleanup failed"); },
    } });
    assert.equal(result.ok, false);
    assert.equal(result.catalogue.semanticPending, true);
    assert.ok(result.catalogue.records.every((record) => !record.indexedHash));
  }
});

test("maintenance uses a stable SQLite transaction lock and releases idempotently", (t) => {
  const f = fixture(t);
  const lock = acquire(f.config);
  const lockPath = path.join(f.stateDirectory, "maintenance-lock.sqlite");
  assert.equal(fs.existsSync(lockPath), true);
  assert.throws(() => acquire(f.config), { code: "MAINTENANCE_BUSY" });
  lock.release();
  lock.release();
  assert.equal(fs.existsSync(lockPath), true);
  acquire(f.config).release();
});

test("maintenance rejects unsafe pre-existing SQLite lock files", (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.stateDirectory, { mode: 0o700 });
  const lockPath = path.join(f.stateDirectory, "maintenance-lock.sqlite");
  fs.writeFileSync(lockPath, "not sqlite", { mode: 0o644 });
  assert.throws(() => acquire(f.config), { code: "UNSAFE_STATE" });
  assert.equal(fs.readFileSync(lockPath, "utf8"), "not sqlite");
});

test("busy maintenance cannot mutate catalogue, staging, or manifests", async (t) => {
  const f = fixture(t); write(path.join(f.root, "pending.md"), "pending");
  const lock = acquire(f.config); t.after(() => lock.release());
  await assert.rejects(api.index(f.config, { testOnlyInProcess: true }), { code: "MAINTENANCE_BUSY" });
  for (const name of ["catalogue.json", "staging", "staging-manifest.json"]) {
    assert.equal(fs.existsSync(path.join(f.stateDirectory, name)), false);
  }
});

function nextWatchEvent(events, predicate) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { clearInterval(poll); reject(new Error(`watch reconciliation timeout: ${JSON.stringify(events.map((event) => ({ reason: event.reason, records: event.result.catalogue && event.result.catalogue.records.map((record) => ({ relative: record.relative, hash: record.observedHash })) })))}`)); }, 2000);
    const poll = setInterval(() => {
      const found = events.find(predicate);
      if (found) { clearTimeout(deadline); clearInterval(poll); resolve(found); }
    }, 5);
  });
}

test("foreground watch periodically recovers missed add, edit, and delete events", async (t) => {
  const f = fixture(t); const events = [];
  const controller = await api.watch(f.config, { watchEvents: false, testOnlyInProcess: true, onReconcile: (event) => events.push(event) });
  t.after(() => controller.stop());
  write(path.join(f.root, "watched.md"), "version one");
  await nextWatchEvent(events, (event) => event.reason === "periodic" && event.result.catalogue.records.some((item) => item.relative === "watched.md"));
  const initialHash = controller.getState().last.catalogue.records[0].observedHash;
  write(path.join(f.root, "watched.md"), "version two");
  await nextWatchEvent(events, (event) => event.result.catalogue.records.some((item) => item.observedHash !== initialHash));
  fs.unlinkSync(path.join(f.root, "watched.md"));
  await nextWatchEvent(events, (event) => event.result.catalogue.records.length === 0);
  assert.equal(controller.getState().running, false);
  const firstStop = controller.stop();
  assert.strictEqual(controller.stop(), firstStop);
  await firstStop;
});

test("already-aborted watch installs no watcher or timer and stop is shared", async (t) => {
  const f = fixture(t);
  const abort = new AbortController(); abort.abort();
  const controller = await api.watch(f.config, { signal: abort.signal, testOnlyInProcess: true });
  assert.deepEqual(controller.getState(), { stopped: true, running: false, runs: 0, last: undefined, healthErrors: [] });
  assert.strictEqual(controller.stop(), controller.stop());
});

test("watch startup and periodic recovery execute update and embedding callbacks", async (t) => {
  const f = fixture(t);
  write(path.join(f.root, "automatic.md"), "automatic indexing");
  const commands = [];
  const events = [];
  const controller = await api.watch(f.config, {
    watchEvents: false,
    onReconcile: (event) => events.push(event),
    adapters: {
      qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }),
      runQmd: async (_config, args) => {
        commands.push(args);
        if (args.includes("list")) return { ok: true, stdout: "docs" };
        return { ok: true, stdout: "" };
      },
    },
  });
  t.after(() => controller.stop());
  assert.ok(commands.some((args) => args.includes("update")));
  assert.ok(commands.some((args) => args.includes("embed")));
  const firstCount = commands.length;
  write(path.join(f.root, "automatic.md"), "automatic indexing changed");
  await nextWatchEvent(events, (event) => event.reason === "periodic" && commands.length > firstCount);
  assert.ok(commands.length > firstCount);
  await controller.stop();
});

test("status omits sources and snippets, while absent QMD indexes lexical-only", async (t) => {
  const f = fixture(t); write(path.join(f.root, "private.md"), "not in status");
  const before = await api.status(f.config);
  assert.equal(before.status, "notStarted"); assert.equal(before.recordCount, 0);
  const indexed = await api.index(f.config, { testOnlyInProcess: true });
  assert.equal(indexed.status, "lexicalOnly"); assert.equal(indexed.taskClass, "default_automation");
  const value = await api.status(f.config); const json = JSON.stringify(value);
  assert.equal(value.recordCount, 1); assert.doesNotMatch(json, /private\.md|snippet|sourceId/);
  assert.equal(value.degraded, "notConfigured");
});

test("owner-only config and CLI smoke produce structured JSON", async (t) => {
  const f = fixture(t); write(path.join(f.root, "cli.md"), "cli needle");
  const configPath = path.join(f.base, "local-search.json"); writeConfig(configPath, f.input);
  assert.equal(fs.statSync(configPath).mode & 0o077, 0);
  const cli = path.resolve(__dirname, "../bin/local-search.js");
  const output = await new Promise((resolve, reject) => execFile(process.execPath, [cli, "search", "--config", configPath, "--query", "needle", "--mode", "keyword"], { encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const result = JSON.parse(output); assert.equal(result.ok, true); assert.equal(result.results[0].relative, "cli.md");
});

test("macOS sandbox blocks loopback listen in direct and nested processes", { skip: process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec") }, (t) => {
  const nested = "const{spawnSync}=require('node:child_process');const n=spawnSync(process.execPath,['-e',\"require('node:net').createServer().listen(0)\"],{timeout:800});const s=require('node:net').createServer();s.on('error',()=>process.exit(n.status===0?2:0));s.listen(0,()=>process.exit(3));";
  const result = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)(deny network*)", process.execPath, "-e", nested], { timeout: 2000 });
  if (result.status === 71) return t.skip("sandbox-exec is present but unavailable in this execution environment");
  assert.equal(result.status, 0);
});

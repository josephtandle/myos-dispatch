"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { normalizeConfig } = require("../packages/local-search/config");
const { search } = require("../packages/local-search/search");
const api = require("../packages/local-search");

function fixture(t, files, budgets = {}, roots = null) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "local-search-native-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "docs");
  fs.mkdirSync(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return { root, config: normalizeConfig({
    enabled: true, stateDirectory: path.join(base, "state"),
    roots: roots || [{ id: "docs", path: root, contentEnabled: true, extensions: [".md", ".txt"], maxFiles: 64, maxFileBytes: 64 * 1024 }],
    budgets: { queryDeadlineMs: 2000, indexDeadlineMs: 2000, reserveBytes: 1, reserveFraction: 0.000001, quotaBytes: 1024 ** 2, ...budgets },
  }) };
}

test("native discovery does not open a queued directory replaced by an outside symlink", async (t) => {
  const files = { "queued/original.md": "inside" };
  for (let index = 0; index < 40; index += 1) files[`filler-${index}.md`] = "inside";
  const f = fixture(t, files);
  const outside = path.join(path.dirname(f.root), "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "outside.md"), "needle");

  const queued = path.join(f.root, "queued");
  const originalOpen = fsp.opendir;
  let replacementScheduled = false;
  let outsideDirectoryOpens = 0;
  fsp.opendir = async (target, ...args) => {
    if (target === queued && fs.lstatSync(target).isSymbolicLink()) outsideDirectoryOpens += 1;
    const handle = await originalOpen(target, ...args);
    if (target !== f.root) return handle;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const entry of handle) {
          if (entry.name === "queued" && !replacementScheduled) {
            replacementScheduled = true;
            setImmediate(() => {
              fs.renameSync(queued, `${queued}-original`);
              fs.symlinkSync(outside, queued, "dir");
            });
          }
          yield entry;
        }
      },
      close: () => handle.close(),
    };
  };
  try {
    const result = await search(f.config, { query: "needle", mode: "native" });
    assert.equal(replacementScheduled, true);
    assert.equal(fs.lstatSync(queued).isSymbolicLink(), true);
    assert.equal(outsideDirectoryOpens, 0);
    assert.equal(result.results.length, 0);
    assert.equal(result.status, "partial", JSON.stringify(result.sourceUnavailable));
  } finally { fsp.opendir = originalOpen; }
});

test("native exact paths retain spaces and return each matching root", async (t) => {
  const first = fixture(t, { "a file.md": "one" });
  const secondRoot = path.join(path.dirname(first.root), "other");
  fs.mkdirSync(secondRoot);
  fs.writeFileSync(path.join(secondRoot, "a file.md"), "two");
  const config = normalizeConfig({ ...first.config, roots: [
    { id: "a", path: first.root, contentEnabled: true, extensions: [".md"], maxFiles: 64, maxFileBytes: 64 * 1024 },
    { id: "b", path: secondRoot, contentEnabled: true, extensions: [".md"], maxFiles: 64, maxFileBytes: 64 * 1024 },
  ] });
  const result = await search(config, { query: "a file.md", mode: "native" });
  assert.deepEqual(result.results.map((item) => [item.rootId, item.relative]), [["a", "a file.md"], ["b", "a file.md"]]);
});

test("public native search does not eagerly load unrelated manifests", async (t) => {
  const f = fixture(t, { "wanted.md": "body" });
  const originalReadFile = fs.readFileSync;
  let manifestReads = 0;
  fs.readFileSync = (target, ...args) => {
    if (String(target).endsWith("staging-manifest.json")) manifestReads += 1;
    return originalReadFile(target, ...args);
  };
  try {
    const result = await api.search(f.config, { query: "wanted.md", mode: "native" });
    assert.equal(result.results[0].relative, "wanted.md");
    assert.equal(manifestReads, 0);
  } finally { fs.readFileSync = originalReadFile; }
});

test("native discovery yields to asynchronous cancellation and bounds directory walks", async (t) => {
  const files = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`d/${index}.md`, "needle"]));
  const f = fixture(t, files);
  const limited = normalizeConfig({ ...f.config, roots: [{ id: "docs", path: f.root, contentEnabled: true, extensions: [".md"], maxFiles: 1, maxFileBytes: 64 * 1024 }] });
  const bounded = await search(limited, { query: "needle", mode: "native" });
  assert.equal(bounded.status, "partial");

  const controller = new AbortController();
  setImmediate(() => controller.abort());
  const cancelled = await search(f.config, { query: "needle", mode: "native" }, { signal: controller.signal });
  assert.equal(cancelled.status, "partial");
  assert.equal(cancelled.negativeIsComplete, false);
});

test("native text scanning yields after the first read and emits nothing after cancellation", async (t) => {
  const files = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`${index}.md`, "needle"]));
  const f = fixture(t, files);
  const controller = new AbortController();
  const originalRead = fs.readSync;
  let reads = 0;
  fs.readSync = (...args) => {
    reads += 1;
    const result = originalRead(...args);
    if (reads === 1) setImmediate(() => controller.abort());
    return result;
  };
  try {
    const cancelled = await search(f.config, { query: "needle", mode: "native" }, { signal: controller.signal });
    assert.equal(reads, 1);
    assert.equal(controller.signal.aborted, true);
    assert.equal(cancelled.results.length, 0);
    assert.equal(cancelled.status, "partial");
  } finally { fs.readSync = originalRead; }
});

test("native treats corrupt or oversized catalogues as partial and reconstructs cache identities", async (t) => {
  const f = fixture(t, { "actual.md": "needle" });
  fs.mkdirSync(f.config.stateDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(f.config.stateDirectory, "catalogue.json"), "x".repeat(1024 * 1024 + 1));
  const oversized = await search(f.config, { query: "needle", mode: "native" });
  assert.equal(oversized.status, "partial");
  assert.equal(oversized.results[0].relative, "actual.md");

  fs.writeFileSync(path.join(f.config.stateDirectory, "catalogue.json"), JSON.stringify({ version: 1, records: [{ rootId: "docs", path: path.join(f.root, "actual.md"), relative: "forged-needle.md" }] }));
  const mismatch = await search(f.config, { query: "forged-needle", mode: "native" });
  assert.notEqual(mismatch.nativeStage, "cachedFilename");
  assert.equal(mismatch.results.length, 0);
});

test("native catalogue replacement with a FIFO cannot block past the query deadline", (t) => {
  const f = fixture(t, { "wanted.md": "body" }, { queryDeadlineMs: 100 });
  fs.mkdirSync(f.config.stateDirectory, { recursive: true, mode: 0o700 });
  const catalogue = path.join(f.config.stateDirectory, "catalogue.json");
  fs.writeFileSync(catalogue, JSON.stringify({ version: 1, records: [] }), { mode: 0o600 });
  const script = `
    const fs = require("node:fs");
    const fsp = require("node:fs/promises");
    const { spawnSync } = require("node:child_process");
    const { search } = require(${JSON.stringify(path.join(__dirname, "../packages/local-search/search"))});
    const config = ${JSON.stringify(f.config)};
    const catalogue = ${JSON.stringify(catalogue)};
    const originalLstat = fsp.lstat;
    let replaced = false;
    fsp.lstat = async (target, ...args) => {
      const stat = await originalLstat(target, ...args);
      if (!replaced && target === catalogue) {
        replaced = true;
        fs.unlinkSync(catalogue);
        const made = spawnSync("/usr/bin/mkfifo", [catalogue]);
        if (made.status !== 0) throw new Error("mkfifo failed");
      }
      return stat;
    };
    search(config, { query: "wanted", mode: "native" }).then((result) => {
      process.stdout.write(JSON.stringify(result));
    }, (error) => { process.stderr.write(error.stack); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 1000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, "partial");
  assert.equal(result.results[0].relative, "wanted.md");
});

test("native finds fresh filename matches across roots without reading their content", async (t) => {
  const first = fixture(t, { "cached.md": "unrelated cached body" });
  const secondRoot = path.join(path.dirname(first.root), "second root");
  fs.mkdirSync(secondRoot);
  fs.mkdirSync(first.config.stateDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(first.config.stateDirectory, "catalogue.json"), JSON.stringify({
    version: 1,
    records: [{ rootId: "a", path: path.join(first.root, "cached.md") }],
  }));
  fs.writeFileSync(path.join(first.root, "invoice-september.md"), "unrelated fresh body");
  fs.writeFileSync(path.join(secondRoot, "invoice october.md"), "another unrelated body");
  const config = normalizeConfig({ ...first.config, roots: [
    { id: "a", path: first.root, contentEnabled: true, extensions: [".md"], maxFiles: 64, maxFileBytes: 64 * 1024 },
    { id: "b", path: secondRoot, contentEnabled: true, extensions: [".md"], maxFiles: 64, maxFileBytes: 64 * 1024 },
  ] });

  const originalRead = fs.readSync;
  let contentReads = 0;
  fs.readSync = (...args) => { contentReads += 1; return originalRead(...args); };
  try {
    const result = await search(config, { query: "invoice", mode: "native" });
    assert.deepEqual(result.results.map((item) => [item.rootId, item.relative]), [
      ["a", "invoice-september.md"],
      ["b", "invoice october.md"],
    ]);
    assert.equal(result.nativeStage, "currentFilename");
    assert.equal(contentReads, 0);
  } finally { fs.readSync = originalRead; }
});

test("native charges actual reads, rejects growth, and never claims a complete negative for no terms or documents", async (t) => {
  const f = fixture(t, { "grow.md": "needle", "doc.pdf": "not parsed" });
  const originalRead = fs.readSync;
  let grown = false;
  fs.readSync = (...args) => {
    if (!grown) { grown = true; fs.appendFileSync(path.join(f.root, "grow.md"), " additional bytes beyond scan allowance"); }
    return originalRead(...args);
  };
  try {
    const growing = await search(f.config, { query: "needle", mode: "native" });
    assert.equal(growing.results.length, 0);
    assert.equal(growing.negativeIsComplete, false);
  } finally { fs.readSync = originalRead; }
  const noTerms = await search(f.config, { query: "the", mode: "native" });
  assert.equal(noTerms.negativeIsComplete, false);
});

test("native ranking ties are stable and emission rejects changed metadata or replaced roots", async (t) => {
  const first = fixture(t, { "same.md": "needle" });
  const second = path.join(path.dirname(first.root), "second");
  fs.mkdirSync(second); fs.writeFileSync(path.join(second, "same.md"), "needle");
  const config = normalizeConfig({ ...first.config, roots: [
    { id: "z", path: second, contentEnabled: true, extensions: [".md"], maxFiles: 64, maxFileBytes: 64 * 1024 },
    { id: "a", path: first.root, contentEnabled: true, extensions: [".md"], maxFiles: 64, maxFileBytes: 64 * 1024 },
  ] });
  const stable = await search(config, { query: "needle", mode: "native" });
  assert.deepEqual(stable.results.map((item) => item.rootId), ["a", "z"]);
  let replaced = false;
  const edited = await search(config, { query: "same.md", mode: "native" }, { beforeEmit() {
    if (replaced) return;
    replaced = true; fs.renameSync(first.root, `${first.root}-old`); fs.mkdirSync(first.root); fs.writeFileSync(path.join(first.root, "same.md"), "replacement");
  } });
  assert.equal(edited.results.length, 0);
  assert.ok(edited.sourceUnavailable.some((item) => item.status === "rootReplaced"));
});

test("native final root guards cover metadata filename and current text branches", async (t) => {
  async function replaceFirstRootDuringSecondEmission(first, secondRoot, query) {
    const config = normalizeConfig({ ...first.config, roots: [
      { id: "a", path: first.root, contentEnabled: true, extensions: [".md"], maxFiles: 64, maxFileBytes: 64 * 1024 },
      { id: "b", path: secondRoot, contentEnabled: true, extensions: [".md"], maxFiles: 64, maxFileBytes: 64 * 1024 },
    ] });
    let emissions = 0;
    return search(config, { query, mode: "native" }, { beforeEmit() {
      emissions += 1;
      if (emissions !== 2) return;
      fs.renameSync(first.root, `${first.root}-old`);
      fs.mkdirSync(first.root);
    } });
  }

  const filename = fixture(t, { "matching-a.md": "body" });
  const filenameSecond = path.join(path.dirname(filename.root), "filename-second");
  fs.mkdirSync(filenameSecond);
  fs.writeFileSync(path.join(filenameSecond, "matching-b.md"), "body");
  const filenameResult = await replaceFirstRootDuringSecondEmission(filename, filenameSecond, "matching");

  const text = fixture(t, { "first.md": "shared needle" });
  const textSecond = path.join(path.dirname(text.root), "text-second");
  fs.mkdirSync(textSecond);
  fs.writeFileSync(path.join(textSecond, "second.md"), "shared needle");
  const textResult = await replaceFirstRootDuringSecondEmission(text, textSecond, "needle");

  assert.deepEqual([
    [filenameResult.nativeStage, filenameResult.status, filenameResult.results.map((item) => item.rootId), filenameResult.sourceUnavailable.some((item) => item.status === "rootReplaced")],
    [textResult.nativeStage, textResult.status, textResult.results.map((item) => item.rootId), textResult.sourceUnavailable.some((item) => item.status === "rootReplaced")],
  ], [
    ["currentFilename", "partial", ["b"], true],
    ["currentText", "partial", ["b"], true],
  ]);
});

test("native cache prefilters by computed relative path before metadata verification", async (t) => {
  const f = fixture(t, { "wanted-cache.md": "body" });
  fs.mkdirSync(f.config.stateDirectory, { recursive: true, mode: 0o700 });
  const irrelevant = Array.from({ length: 200 }, (_, index) => ({
    rootId: "docs",
    path: path.join(f.root, `irrelevant-cache-${index}.md`),
    relative: `wanted-forged-${index}.md`,
    sourceId: `forged-${index}`,
  }));
  fs.writeFileSync(path.join(f.config.stateDirectory, "catalogue.json"), JSON.stringify({
    version: 1,
    records: [...irrelevant, {
      rootId: "docs",
      path: path.join(f.root, "wanted-cache.md"),
      relative: "forged-relative.md",
      sourceId: "forged-source-id",
    }],
  }), { mode: 0o600 });

  const originalLstat = fs.lstatSync;
  let irrelevantMetadataStats = 0;
  fs.lstatSync = (target, ...args) => {
    if (path.basename(String(target)).startsWith("irrelevant-cache-")) irrelevantMetadataStats += 1;
    return originalLstat(target, ...args);
  };
  try {
    const result = await search(f.config, { query: "wanted", mode: "native" });
    assert.equal(irrelevantMetadataStats, 0);
    assert.equal(result.nativeStage, "cachedFilename");
    assert.equal(result.results[0].relative, "wanted-cache.md");
    assert.notEqual(result.results[0].sourceId, "forged-source-id");
  } finally { fs.lstatSync = originalLstat; }
});

test("native incremental emission preserves stable order and packet limits", async (t) => {
  const f = fixture(t, {
    "c.md": `needle ${"c".repeat(80)}`,
    "a.md": `needle ${"a".repeat(80)}`,
    "b.md": `needle ${"b".repeat(80)}`,
  });
  const result = await search(f.config, { query: "needle", mode: "native", maxResults: 2, maxBytes: 20 });
  assert.deepEqual(result.results.map((item) => item.relative), ["a.md", "b.md"]);
  assert.equal(result.results.length, 2);
  assert.ok(result.bytes <= 20, `expected at most 20 bytes, received ${result.bytes}`);
});

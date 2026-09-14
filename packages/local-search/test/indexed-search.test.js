"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const api = require("..");
const { normalizeConfig } = require("../config");
const { publish, reconcile } = require("../catalogue");
const { loadManifests, stage } = require("../staging");

function fixture(t, options = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "indexed-search-test-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "docs");
  fs.mkdirSync(root);
  const configInput = (overrides = {}) => ({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "docs", path: root, contentEnabled: overrides.contentEnabled ?? true, extensions: overrides.extensions || options.extensions || [".md"], maxFiles: 20, maxFileBytes: 4096 }],
    budgets: { queryDeadlineMs: overrides.queryDeadlineMs ?? options.queryDeadlineMs ?? 2000, reserveBytes: 1, reserveFraction: 0.000001, quotaBytes: 1024 ** 2 },
  });
  const config = normalizeConfig(configInput());
  return { base, root, config, configInput };
}

function indexText(config, relative, revision = "a".repeat(64)) {
  const catalogue = reconcile(config, { publish: false }).catalogue;
  const staged = stage(config, catalogue, revision);
  assert.equal(staged.ok, true);
  for (const item of staged.staged) item.record.indexedHash = item.current.hash;
  catalogue.indexedRevision = revision;
  publish(config, catalogue);
  return { catalogue, staged, manifests: loadManifests(config), record: catalogue.records.find((item) => item.relative === relative) };
}

function sdkRow(rootId, filename, score = 1) {
  return JSON.stringify([{ file: `qmd://${rootId}/${filename}`, score }]);
}

function sdkOptions(manifests, stdout) {
  return {
    manifests,
    qmdStatus: () => ({ available: true, semanticAvailable: false, status: "available" }),
    runSdkSearch: async () => ({ ok: true, stdout }),
  };
}

function filenameFor(indexed, relative = "selected.md") {
  return indexed.staged.staged.find((item) => item.record.relative === relative).filename;
}

function unavailableReasons(result) {
  return result.sourceUnavailable.map((item) => item.reason);
}

test("accepts the real stage and loadManifests cryptographic binding without relative", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "selected.md"), "alpha separated beta evidence");
  const indexed = indexText(f.config, "selected.md");
  const filename = indexed.staged.staged[0].filename;
  const entry = indexed.manifests.docs[filename];
  assert.equal(Object.hasOwn(entry, "relative"), false);
  assert.equal(filename, `${crypto.createHash("sha256").update(`${indexed.record.sourceId}:${indexed.record.indexedHash}`).digest("hex")}.md`);
  const result = await api.search(f.config, { query: "alpha beta", mode: "indexed-keyword" }, sdkOptions(indexed.manifests, sdkRow("docs", filename)));
  assert.equal(result.status, "indexedSubset");
  assert.equal(result.results[0].relative, "selected.md");
  assert.equal(result.taskClass, "cheap_routing");
  assert.equal(result.complianceLane, "unattended_local");
});

test("indexed-keyword is an explicit subset fast path and never reads non-candidates", async (t) => {
  const f = fixture(t);
  const selected = path.join(f.root, "selected.md");
  const sentinel = path.join(f.root, "sentinel.md");
  fs.writeFileSync(selected, "needle evidence");
  fs.writeFileSync(sentinel, "sentinel must not be read");
  const indexed = indexText(f.config, "selected.md");
  const filename = indexed.staged.staged.find((item) => item.record.relative === "selected.md").filename;
  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  const originalReaddir = fs.readdirSync;
  const opened = new Map();
  let directoryReads = 0;
  fs.openSync = function instrumentedOpen(target, ...args) {
    const fd = originalOpen.call(this, target, ...args);
    opened.set(fd, path.resolve(target));
    return fd;
  };
  fs.readSync = function instrumentedRead(fd, ...args) {
    assert.notEqual(opened.get(fd), sentinel, "noncandidate bytes were read");
    return originalRead.call(this, fd, ...args);
  };
  fs.readdirSync = function instrumentedReaddir(...args) {
    directoryReads += 1;
    return originalReaddir.apply(this, args);
  };
  try {
    const result = await api.search(f.config, { query: "needle", mode: "indexed-keyword" }, sdkOptions(indexed.manifests, sdkRow("docs", filename)));
    assert.equal(result.status, "indexedSubset");
    assert.equal(result.coverage, "indexedSubset");
    assert.equal(result.negativeIsComplete, false);
    assert.equal(result.fullScanRequiredForCompleteNegative, true);
    assert.equal(result.results[0].relative, "selected.md");
    assert.equal(directoryReads, 0);
  } finally {
    fs.openSync = originalOpen;
    fs.readSync = originalRead;
    fs.readdirSync = originalReaddir;
  }
});

test("rejects malformed or mismatched QMD rows and manifest bindings", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "selected.md"), "needle evidence");
  const indexed = indexText(f.config, "selected.md");
  const filename = filenameFor(indexed);
  const validEntry = indexed.manifests.docs[filename];
  const cases = [
    ["plain string", { docs: { [filename]: validEntry.sourceId } }, sdkRow("docs", filename)],
    ["missing hash", { docs: { [filename]: { ...validEntry, hash: undefined } } }, sdkRow("docs", filename)],
    ["wrong sourceHash", { docs: { [filename]: { ...validEntry, sourceHash: "0".repeat(64) } } }, sdkRow("docs", filename)],
    ["non-null extraction", { docs: { [filename]: { ...validEntry, extractionKey: "parser-key" } } }, sdkRow("docs", filename)],
    ["conflicting relative", { docs: { [filename]: { ...validEntry, relative: "other.md" } } }, sdkRow("docs", filename)],
    ["malformed JSON", indexed.manifests, "{"],
    ["malformed row", indexed.manifests, JSON.stringify([{ file: 42, score: 1 }])],
  ];
  for (const [label, manifests, stdout] of cases) {
    const result = await api.search(f.config, { query: "needle", mode: "indexed-keyword" }, sdkOptions(manifests, stdout));
    assert.equal(result.results.length, 0, label);
  }
  const arbitrary = "f".repeat(64) + ".md";
  const manifests = { docs: { ...indexed.manifests.docs, [arbitrary]: validEntry } };
  const arbitraryResult = await api.search(f.config, { query: "needle", mode: "indexed-keyword" }, sdkOptions(manifests, sdkRow("docs", arbitrary)));
  assert.equal(arbitraryResult.results.length, 0);
  const wrongCollection = await api.search(f.config, { query: "needle", mode: "indexed-keyword" }, sdkOptions({ ...indexed.manifests, other: { [filename]: validEntry } }, sdkRow("other", filename)));
  assert.equal(wrongCollection.status, "fallbackRequired");
  assert.ok(unavailableReasons(wrongCollection).includes("indexedCollectionMismatch"));
});

test("rejects current candidates changed with preserved mtime, deleted, secret, or revoked", async (t) => {
  async function scenario(name, mutate, expectedReason) {
    await t.test(name, async (st) => {
      const f = fixture(st);
      const selected = path.join(f.root, "selected.md");
      fs.writeFileSync(selected, "needle alpha");
      const indexed = indexText(f.config, "selected.md");
      const replacementConfig = await mutate({ f, selected, indexed });
      const result = await api.search(replacementConfig || f.config, { query: "needle", mode: "indexed-keyword" }, sdkOptions(indexed.manifests, sdkRow("docs", filenameFor(indexed))));
      assert.equal(result.results.length, 0);
      assert.ok(unavailableReasons(result).includes(expectedReason), JSON.stringify(result.sourceUnavailable));
    });
  }
  await scenario("content changed while mtime is preserved", ({ selected }) => {
    const stat = fs.statSync(selected);
    fs.writeFileSync(selected, "needle omega");
    fs.utimesSync(selected, stat.atime, stat.mtime);
  }, "indexedHashMismatch");
  await scenario("candidate deleted", ({ selected }) => fs.unlinkSync(selected), "removed");
  await scenario("candidate becomes secret", ({ selected }) => fs.writeFileSync(selected, "password=abcdefgh"), "secretPatternDenied");
  await scenario("content access revoked", ({ f }) => normalizeConfig(f.configInput({ contentEnabled: false })), "contentNotEnabled");
});

test("does not trust traversal or cached catalogue paths", async (t) => {
  const f = fixture(t);
  const selected = path.join(f.root, "selected.md");
  const decoy = path.join(f.base || path.dirname(f.root), "decoy.md");
  fs.writeFileSync(selected, "needle real evidence");
  fs.writeFileSync(decoy, "needle decoy evidence");
  const indexed = indexText(f.config, "selected.md");
  const filename = filenameFor(indexed);
  indexed.record.path = decoy;
  publish(f.config, indexed.catalogue);
  const valid = await api.search(f.config, { query: "needle", mode: "indexed-keyword" }, sdkOptions(indexed.manifests, sdkRow("docs", filename)));
  assert.match(valid.results[0].snippet, /real evidence/);
  indexed.record.relative = "../decoy.md";
  publish(f.config, indexed.catalogue);
  const traversal = await api.search(f.config, { query: "needle", mode: "indexed-keyword" }, sdkOptions(indexed.manifests, sdkRow("docs", filename)));
  assert.equal(traversal.results.length, 0);
});

test("root replacement during SDK await discards every candidate", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "selected.md"), "needle evidence");
  const indexed = indexText(f.config, "selected.md");
  const moved = `${f.root}-original`;
  const result = await api.search(f.config, { query: "needle", mode: "indexed-keyword" }, {
    ...sdkOptions(indexed.manifests, sdkRow("docs", filenameFor(indexed))),
    runSdkSearch: async () => {
      fs.renameSync(f.root, moved);
      fs.mkdirSync(f.root);
      return { ok: true, stdout: sdkRow("docs", filenameFor(indexed)) };
    },
  });
  assert.equal(result.status, "fallbackRequired");
  assert.equal(result.results.length, 0);
  assert.ok(unavailableReasons(result).includes("indexedRootReplaced"));
});

test("root replacement or abort in beforeEmit discards content", async (t) => {
  await t.test("root replacement", async (st) => {
    const f = fixture(st);
    fs.writeFileSync(path.join(f.root, "selected.md"), "needle evidence");
    const indexed = indexText(f.config, "selected.md");
    const result = await api.search(f.config, { query: "needle", mode: "indexed-keyword" }, {
      ...sdkOptions(indexed.manifests, sdkRow("docs", filenameFor(indexed))),
      beforeEmit() { fs.renameSync(f.root, `${f.root}-original`); fs.mkdirSync(f.root); },
    });
    assert.equal(result.results.length, 0);
    assert.ok(unavailableReasons(result).includes("indexedRootReplaced"));
  });
  await t.test("abort", async (st) => {
    const f = fixture(st);
    fs.writeFileSync(path.join(f.root, "selected.md"), "needle evidence");
    const indexed = indexText(f.config, "selected.md");
    const controller = new AbortController();
    const result = await api.search(f.config, { query: "needle", mode: "indexed-keyword" }, {
      ...sdkOptions(indexed.manifests, sdkRow("docs", filenameFor(indexed))), signal: controller.signal,
      beforeEmit() { controller.abort(); },
    });
    assert.equal(result.results.length, 0);
    assert.equal(result.aborted, true);
    assert.equal(result.deadlineExpired, false);
  });
});

test("final root check catches replacement after packet reads", async (t) => {
  const f = fixture(t);
  const selected = path.join(f.root, "selected.md");
  fs.writeFileSync(selected, "needle evidence");
  const indexed = indexText(f.config, "selected.md");
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const opened = new Map();
  let armed = false;
  fs.openSync = function trackedOpen(target, ...args) {
    const fd = originalOpen.call(this, target, ...args);
    opened.set(fd, path.resolve(target));
    return fd;
  };
  fs.closeSync = function replacingClose(fd) {
    const result = originalClose.call(this, fd);
    if (armed && opened.get(fd) === selected) {
      armed = false;
      fs.renameSync(f.root, `${f.root}-original`);
      fs.mkdirSync(f.root);
    }
    return result;
  };
  try {
    const result = await api.search(f.config, { query: "needle", mode: "indexed-keyword" }, {
      ...sdkOptions(indexed.manifests, sdkRow("docs", filenameFor(indexed))), beforeEmit() { armed = true; },
    });
    assert.equal(result.results.length, 0);
    assert.ok(unavailableReasons(result).includes("indexedRootReplaced"));
  } finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }
});

test("cancellation and expired deadlines are fail-closed with honest flags", async (t) => {
  await t.test("abort during SDK await", async (st) => {
    const f = fixture(st);
    fs.writeFileSync(path.join(f.root, "selected.md"), "needle evidence");
    const indexed = indexText(f.config, "selected.md");
    const controller = new AbortController();
    const result = await api.search(f.config, { query: "needle", mode: "indexed-keyword" }, {
      ...sdkOptions(indexed.manifests, sdkRow("docs", filenameFor(indexed))), signal: controller.signal,
      runSdkSearch: async () => { controller.abort(); return { ok: true, stdout: sdkRow("docs", filenameFor(indexed)) }; },
    });
    assert.equal(result.results.length, 0);
    assert.equal(result.aborted, true);
    assert.equal(result.deadlineExpired, false);
  });
  await t.test("deadline expires before SDK dispatch", async (st) => {
    const f = fixture(st, { queryDeadlineMs: 1 });
    fs.writeFileSync(path.join(f.root, "selected.md"), "needle evidence");
    const indexed = indexText(f.config, "selected.md");
    let dispatched = false;
    const result = await api.search(f.config, { query: "needle", mode: "indexed-keyword" }, {
      ...sdkOptions(indexed.manifests, sdkRow("docs", filenameFor(indexed))),
      qmdStatus() { const end = Date.now() + 3; while (Date.now() < end) {} return { available: true, status: "available" }; },
      runSdkSearch: async (_config, _request, options) => { dispatched = true; assert.ok(options.timeoutMs > 0); return { ok: true, stdout: "[]" }; },
    });
    assert.equal(dispatched, false);
    assert.equal(result.deadlineExpired, true);
    assert.equal(result.aborted, false);
  });
});

test("new files remain incomplete negatives and historical watermark is retained", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "selected.md"), "old evidence");
  const indexed = indexText(f.config, "selected.md");
  const watermark = indexed.catalogue.reconciledAt;
  fs.writeFileSync(path.join(f.root, "new.md"), "brandnew needle");
  const result = await api.search(f.config, { query: "brandnew", mode: "indexed-keyword" }, sdkOptions(indexed.manifests, "[]"));
  assert.equal(result.results.length, 0);
  assert.equal(result.negativeIsComplete, false);
  assert.equal(result.fullScanRequiredForCompleteNegative, true);
  assert.equal(result.indexWatermark, watermark);
});

test("indexed-filename uses only catalogue candidates and real manifest bindings", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "selected-notes.md"), "filename evidence");
  fs.writeFileSync(path.join(f.root, "unrelated.md"), "unrelated evidence");
  const indexed = indexText(f.config, "selected-notes.md");
  let sdkCalled = false;
  const result = await api.search(f.config, { query: "selected", mode: "indexed-filename" }, {
    manifests: indexed.manifests,
    qmdStatus() { throw new Error("filename mode must not probe QMD"); },
    runSdkSearch: async () => { sdkCalled = true; return { ok: true, stdout: "[]" }; },
  });
  assert.equal(sdkCalled, false);
  assert.deepEqual(result.results.map((item) => item.relative), ["selected-notes.md"]);
  assert.equal(result.coverage, "indexedSubset");
  assert.equal(result.negativeIsComplete, false);
});

test("SDK timeout is returned as an indexed fallback with no content", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "selected.md"), "needle evidence");
  const indexed = indexText(f.config, "selected.md");
  const result = await api.search(f.config, { query: "needle", mode: "indexed-keyword" }, {
    ...sdkOptions(indexed.manifests, sdkRow("docs", filenameFor(indexed))),
    runSdkSearch: async (_config, _request, options) => {
      assert.ok(options.timeoutMs > 0);
      return { ok: false, status: "timeout" };
    },
  });
  assert.equal(result.status, "fallbackRequired");
  assert.equal(result.results.length, 0);
  assert.ok(unavailableReasons(result).includes("timeout"));
  assert.equal(result.deadlineExpired, false);
  assert.equal(result.aborted, false);
});

test("missing or corrupt catalogues fall back without discovery", async (t) => {
  await t.test("missing", async (st) => {
    const f = fixture(st);
    const result = await api.search(f.config, { query: "needle", mode: "indexed-filename" }, { manifests: {} });
    assert.equal(result.status, "fallbackRequired");
    assert.ok(unavailableReasons(result).includes("indexedCatalogueUnavailable"));
  });
  await t.test("corrupt", async (st) => {
    const f = fixture(st);
    fs.mkdirSync(f.config.stateDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(f.config.stateDirectory, "catalogue.json"), "not-json", { mode: 0o600 });
    const result = await api.search(f.config, { query: "needle", mode: "indexed-filename" }, { manifests: {} });
    assert.equal(result.status, "fallbackRequired");
    assert.ok(unavailableReasons(result).includes("catalogueCorrupt"));
  });
});

test("malformed catalogue records fall back without throwing", async (t) => {
  const malformedRecords = [
    ["null row", null],
    ["primitive row", 42],
    ["missing relative", { rootId: "docs", sourceId: "invalid" }],
    ["non-string relative", { rootId: "docs", sourceId: "invalid", relative: 42 }],
  ];

  for (const [name, malformedRecord] of malformedRecords) {
    await t.test(name, async (st) => {
      const f = fixture(st);
      fs.writeFileSync(path.join(f.root, "selected.md"), "needle evidence");
      const indexed = indexText(f.config, "selected.md");
      fs.writeFileSync(path.join(f.config.stateDirectory, "catalogue.json"), JSON.stringify({
        ...indexed.catalogue,
        records: [malformedRecord],
      }), { mode: 0o600 });

      const result = await api.search(f.config, { query: "needle", mode: "indexed-filename" }, { manifests: {} });
      assert.equal(result.status, "fallbackRequired");
      assert.deepEqual(result.results, []);
      assert.ok(unavailableReasons(result).includes("indexedCatalogueUnavailable"));
    });
  }
});

test("indexed mode is text-only and reports Office candidates unsupported", async (t) => {
  const f = fixture(t, { extensions: [".md", ".docx"] });
  fs.writeFileSync(path.join(f.root, "report.docx"), Buffer.from("PK\u0003\u0004office"));
  const catalogue = reconcile(f.config, { publish: false }).catalogue;
  const record = catalogue.records.find((item) => item.relative === "report.docx");
  record.indexedHash = record.observedHash;
  const revision = "b".repeat(64);
  catalogue.indexedRevision = revision;
  publish(f.config, catalogue);
  const filename = `${crypto.createHash("sha256").update(`${record.sourceId}:${record.indexedHash}`).digest("hex")}.md`;
  const manifests = { docs: { [filename]: { sourceId: record.sourceId, hash: record.indexedHash, sourceHash: record.indexedHash, extractionKey: null, revision } } };
  const result = await api.search(f.config, { query: "report", mode: "indexed-filename" }, { manifests });
  assert.equal(result.results.length, 0);
  assert.ok(unavailableReasons(result).includes("indexedDocumentUnsupported"));
});

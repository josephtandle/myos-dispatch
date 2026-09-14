"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadCatalogue, metadataPolicyFingerprint, publish, reconcile } = require("../packages/local-search/catalogue");
const { createMetadataCursor, refreshMetadata, closeMetadataCursor } = require("../packages/local-search/metadata-refresh");

function fixture(t, rootCount = 1) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "metadata-refresh-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const roots = Array.from({ length: rootCount }, (_, index) => {
    const root = path.join(base, `docs-${index}`);
    fs.mkdirSync(root, { mode: 0o700 });
    return { id: `docs-${index}`, path: root, contentEnabled: true, extensions: [".md"], maxFiles: 100, maxFileBytes: 1024 * 1024 };
  });
  return {
    stateDirectory: path.join(base, "state"), roots,
    budgets: { indexDeadlineMs: 1_000, quotaBytes: Number.MAX_SAFE_INTEGER, reserveBytes: 0, reserveFraction: 0 },
    qmd: null,
  };
}

async function finish(config, cursor, options = {}) {
  let result;
  for (let count = 0; count < 100; count += 1) {
    result = await refreshMetadata(config, { cursor, deadline: Date.now() + 1_000, ...options });
    if (result.complete || !["ok", "partial"].includes(result.status)) return result;
  }
  throw new Error("metadata sweep did not finish");
}

test("slice budgets bound entries, queued directories, handles, root files, and share work fairly", async (t) => {
  const config = fixture(t, 2);
  config.roots[0].maxFiles = 1;
  for (const root of config.roots) {
    fs.writeFileSync(path.join(root.path, "one.md"), "one");
    fs.writeFileSync(path.join(root.path, "two.md"), "two");
    for (const directory of ["a", "b", "c"]) fs.mkdirSync(path.join(root.path, directory));
  }
  const cursor = createMetadataCursor(config);
  const result = await refreshMetadata(config, {
    cursor, maxEntries: 2, maxQueuedDirectories: 4, maxDirectoryHandles: 2, maxRootFiles: 1,
    maxDeletionChecks: 1, maxDeletions: 1, deadline: Date.now() + 1_000,
  });
  assert.deepEqual(result.budgets, {
    entries: 2, queuedDirectories: 4, directoryHandles: 2, rootFiles: 1, deletionChecks: 1, deletions: 1,
  });
  assert.equal(result.budgetQualifier, "cooperativeBudgetNotHardDeadline");
  assert.equal(result.processedByRoot["docs-0"] > 0, true);
  assert.equal(result.processedByRoot["docs-1"] > 0, true);
  for (let count = 0; count < 4; count += 1) await refreshMetadata(config, { cursor, deadline: Date.now() + 1_000 });
  assert.equal(loadCatalogue(config).records.filter((record) => record.rootId === "docs-0").length <= 1, true);
  closeMetadataCursor(cursor);
});

test("queued directory replacement cannot escape and an incomplete sweep cannot delete unseen records", async (t) => {
  const config = fixture(t);
  const root = config.roots[0];
  const child = path.join(root.path, "child");
  const outside = path.join(path.dirname(root.path), "outside");
  fs.mkdirSync(child);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(child, "inside.md"), "inside");
  fs.writeFileSync(path.join(outside, "escaped.md"), "escaped");
  const first = createMetadataCursor(config);
  await finish(config, first);
  const original = loadCatalogue(config).records.find((record) => record.relative === path.join("child", "inside.md"));
  fs.rmSync(child, { recursive: true });
  fs.mkdirSync(child);
  const cursor = createMetadataCursor(config);
  await refreshMetadata(config, { cursor, maxEntries: 1, deadline: Date.now() + 1_000 });
  fs.rmSync(child, { recursive: true });
  fs.symlinkSync(outside, child);
  await refreshMetadata(config, { cursor, deadline: Date.now() + 1_000 });
  const records = loadCatalogue(config).records;
  assert.equal(records.some((record) => record.path === path.join(outside, "escaped.md")), false);
  assert.deepEqual(records.find((record) => record.relative === original.relative), original);
});

test("confined ENOENT deletion is bounded while permission-style failures preserve records", { concurrency: false }, async (t) => {
  const config = fixture(t);
  const files = ["one.md", "two.md", "three.md"].map((name) => path.join(config.roots[0].path, name));
  for (const file of files) fs.writeFileSync(file, file);
  await finish(config, createMetadataCursor(config));
  for (const file of files) fs.unlinkSync(file);
  const cursor = createMetadataCursor(config);
  const first = await finish(config, cursor, { maxDeletionChecks: 2, maxDeletions: 1 });
  assert.equal(first.usage.deletions <= 1, true);
  assert.equal(loadCatalogue(config).records.length, 0);

  fs.writeFileSync(files[0], "restored");
  await finish(config, createMetadataCursor(config));
  fs.unlinkSync(files[0]);
  const lstat = fs.lstatSync;
  fs.lstatSync = (target, ...args) => {
    if (target === files[0]) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return lstat(target, ...args);
  };
  const deniedCursor = createMetadataCursor(config);
  try {
    for (let count = 0; count < 3; count += 1) await refreshMetadata(config, { cursor: deniedCursor, deadline: Date.now() + 1_000 });
  }
  finally { fs.lstatSync = lstat; }
  assert.equal(loadCatalogue(config).records.some((record) => record.path === files[0]), true);
});

test("directory mutation across slices forbids unseen deletion", async (t) => {
  const config = fixture(t);
  const first = path.join(config.roots[0].path, "first.md");
  const second = path.join(config.roots[0].path, "second.md");
  fs.writeFileSync(first, "first");
  fs.writeFileSync(second, "second");
  await finish(config, createMetadataCursor(config));
  const cursor = createMetadataCursor(config);
  await refreshMetadata(config, { cursor, maxEntries: 1, deadline: Date.now() + 1_000 });
  fs.unlinkSync(second);
  await refreshMetadata(config, { cursor, deadline: Date.now() + 1_000 });
  assert.equal(loadCatalogue(config).records.some((record) => record.relative === "second.md"), true);
});

test("unchanged metadata preserves hashes across light and heavy passes; same-mtime edits invalidate them", async (t) => {
  const config = fixture(t);
  const file = path.join(config.roots[0].path, "note.md");
  fs.writeFileSync(file, "alpha");
  const heavy = reconcile(config);
  const record = heavy.catalogue.records[0];
  record.indexedHash = record.observedHash;
  publish(config, heavy.catalogue);
  const reconciledAt = heavy.catalogue.reconciledAt;
  const fingerprint = record.metadataFingerprint;

  await finish(config, createMetadataCursor(config));
  let current = loadCatalogue(config);
  assert.equal(current.records[0].indexedHash, record.indexedHash);
  assert.equal(current.reconciledAt, reconciledAt);
  const secondHeavy = reconcile(config);
  assert.equal(secondHeavy.catalogue.records[0].metadataFingerprint, fingerprint);
  assert.equal(secondHeavy.catalogue.records[0].indexedHash, record.indexedHash);

  const originalTimes = fs.statSync(file);
  fs.writeFileSync(file, "bravo");
  fs.utimesSync(file, originalTimes.atime, originalTimes.mtime);
  await finish(config, createMetadataCursor(config));
  current = loadCatalogue(config);
  assert.equal(current.records[0].observedHash, null);
  assert.equal(current.records[0].indexedHash, null);
});

test("policy additions participate in metadata fingerprints", async (t) => {
  const config = fixture(t);
  const file = path.join(config.roots[0].path, "note.md");
  fs.writeFileSync(file, "alpha");
  await finish(config, createMetadataCursor(config));
  const first = loadCatalogue(config).records[0].metadataFingerprint;
  const root = config.roots[0];
  const policySha256 = crypto.createHash("sha256").update("metadata-fingerprint-policy").digest("hex");
  const rootStat = fs.lstatSync(root.path, { bigint: true });
  const fileStat = fs.lstatSync(file, { bigint: true });
  const manifest = path.join(path.dirname(root.path), "admission.json");
  fs.writeFileSync(manifest, JSON.stringify({
    version: 1,
    rootId: root.id,
    rootPath: fs.realpathSync(root.path),
    root: { dev: rootStat.dev.toString(), ino: rootStat.ino.toString() },
    policySha256,
    files: [{
      path: "note.md",
      sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      dev: fileStat.dev.toString(),
      ino: fileStat.ino.toString(),
    }],
  }), { mode: 0o600 });
  root.admissionManifest = manifest;
  root.admissionPolicySha256 = policySha256;
  await finish(config, createMetadataCursor(config));
  assert.notEqual(loadCatalogue(config).records[0].metadataFingerprint, first);

  const baseline = metadataPolicyFingerprint(root);
  for (const changed of [
    { ...root, path: `${root.path}-other` },
    { ...root, contentEnabled: false },
    { ...root, flags: ["metadata"] },
    { ...root, exclusions: ["private"] },
    { ...root, extensions: [".txt"] },
    { ...root, maxFiles: root.maxFiles - 1 },
    { ...root, maxFileBytes: root.maxFileBytes - 1 },
    { ...root, admissionManifest: { version: 2 } },
    { ...root, admissionPolicySha256: "b".repeat(64) },
    { ...root, admissionRefreshPolicy: "on-change" },
    { ...root, admissionExcludePaths: ["private-marker"] },
  ]) assert.notEqual(metadataPolicyFingerprint(changed), baseline);
  assert.equal(metadataPolicyFingerprint({ ...root, admissionExcludePaths: ["private-marker"] }).includes("private-marker"), false);
});

test("lock contention, abort, and storage rejection do not publish false success", async (t) => {
  const config = fixture(t);
  fs.writeFileSync(path.join(config.roots[0].path, "note.md"), "alpha");
  const cursor = createMetadataCursor(config);
  const lock = require("../packages/local-search/maintenance").acquire(config);
  try {
    const busy = await refreshMetadata(config, { cursor, deadline: Date.now() + 1_000 });
    assert.equal(busy.status, "busy");
    assert.equal(cursor.metadataRefreshedAt, null);
  } finally { lock.release(); }

  const abort = new AbortController();
  const aborted = await refreshMetadata(config, {
    cursor, signal: abort.signal, deadline: Date.now() + 1_000,
    beforePublish() { abort.abort(); },
  });
  assert.equal(aborted.status, "aborted");
  assert.equal(cursor.metadataRefreshedAt, null);
  assert.equal(fs.existsSync(path.join(config.stateDirectory, "catalogue.json")), false);

  config.budgets.quotaBytes = 1;
  const rejected = await refreshMetadata(config, { cursor, deadline: Date.now() + 1_000 });
  assert.equal(rejected.status, "storageRejected");
  assert.equal(cursor.metadataRefreshedAt, null);
  assert.equal(fs.existsSync(path.join(config.stateDirectory, "catalogue.json")), false);
});

test("semantic degradation does not disable metadata and the light path reads no source body", { concurrency: false }, async (t) => {
  const config = fixture(t);
  const file = path.join(config.roots[0].path, "note.md");
  fs.writeFileSync(file, "private source body");
  publish(config, { version: 1, records: [], reconciledAt: "2020-01-01T00:00:00.000Z", roots: {}, degraded: "partialExtraction", semanticPending: true });
  const readFile = fs.readFileSync;
  fs.readFileSync = (target, ...args) => {
    if (target === file) throw new Error("source body read");
    return readFile(target, ...args);
  };
  let yielded = false;
  setImmediate(() => { yielded = true; });
  try {
    const result = await finish(config, createMetadataCursor(config));
    assert.equal(result.status, "ok");
  } finally { fs.readFileSync = readFile; }
  const catalogue = loadCatalogue(config);
  assert.equal(catalogue.degraded, "partialExtraction");
  assert.equal(catalogue.records.length, 1);
  assert.equal(yielded, true);
});

test("closing a cursor closes retained directory handles", async (t) => {
  const config = fixture(t);
  fs.writeFileSync(path.join(config.roots[0].path, "note.md"), "alpha");
  const cursor = createMetadataCursor(config);
  await refreshMetadata(config, { cursor, maxEntries: 1, deadline: Date.now() + 1_000 });
  closeMetadataCursor(cursor);
  assert.equal(cursor.closed, true);
  assert.equal(cursor.roots.every((state) => state.directory === null), true);
  assert.equal((await refreshMetadata(config, { cursor })).status, "closed");
});

test("an aborted unpublished slice replays consumed cursor work", async (t) => {
  const config = fixture(t);
  fs.writeFileSync(path.join(config.roots[0].path, "note.md"), "alpha");
  await finish(config, createMetadataCursor(config));
  fs.writeFileSync(path.join(config.roots[0].path, "second.md"), "beta");
  const cursor = createMetadataCursor(config);
  const abort = new AbortController();
  const interrupted = await refreshMetadata(config, {
    cursor, signal: abort.signal, deadline: Date.now() + 1_000,
    beforePublish() { abort.abort(); },
  });
  assert.equal(interrupted.status, "aborted");
  assert.equal(loadCatalogue(config).records.length, 1);

  const resumed = await finish(config, cursor);
  assert.equal(resumed.status, "ok");
  assert.equal(resumed.complete, true);
  assert.equal(loadCatalogue(config).records.length, 2);

  let signalReads = 0;
  const midscanCursor = createMetadataCursor(config);
  const midscan = await refreshMetadata(config, {
    cursor: midscanCursor, deadline: Date.now() + 1_000,
    signal: { get aborted() { signalReads += 1; return signalReads > 2; } },
  });
  assert.equal(midscan.status, "aborted");
  assert.equal((await finish(config, midscanCursor)).complete, true);

  const hookCursor = createMetadataCursor(config);
  const hookFailure = await refreshMetadata(config, {
    cursor: hookCursor, deadline: Date.now() + 1_000,
    beforePublish() { throw new Error("pre-publish failure"); },
  });
  assert.equal(hookFailure.status, "failed");
  assert.equal((await finish(config, hookCursor)).complete, true);

  const storageCursor = createMetadataCursor(config);
  config.budgets.quotaBytes = 1;
  assert.equal((await refreshMetadata(config, { cursor: storageCursor, deadline: Date.now() + 1_000 })).status, "storageRejected");
  config.budgets.quotaBytes = Number.MAX_SAFE_INTEGER;
  assert.equal((await finish(config, storageCursor)).complete, true);

  const publishCursor = createMetadataCursor(config);
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === path.join(config.stateDirectory, "catalogue.json")) throw Object.assign(new Error("publish failed"), { code: "EIO" });
    return rename(source, target);
  };
  try {
    assert.equal((await refreshMetadata(config, { cursor: publishCursor, deadline: Date.now() + 1_000 })).status, "failed");
  } finally { fs.renameSync = rename; }
  assert.equal((await finish(config, publishCursor)).complete, true);
  assert.equal(loadCatalogue(config).records.length, 2);
});

test("completed roots remain complete until the entire fair generation publishes", async (t) => {
  const config = fixture(t, 2);
  fs.writeFileSync(path.join(config.roots[0].path, "only.md"), "only");
  for (let index = 0; index < 8; index += 1) fs.writeFileSync(path.join(config.roots[1].path, `${index}.md`), String(index));
  const cursor = createMetadataCursor(config);
  let result;
  for (let slice = 0; slice < 40; slice += 1) {
    result = await refreshMetadata(config, {
      cursor, maxEntries: 1, maxRootFiles: 1, maxDeletionChecks: 1, deadline: Date.now() + 1_000,
    });
    if (result.complete) break;
  }
  assert.equal(result.complete, true);
  assert.equal(loadCatalogue(config).records.length, 9);
});

test("each slice revokes removed roots and resets changed root policy", async (t) => {
  const config = fixture(t);
  const original = path.join(config.roots[0].path, "old.md");
  fs.writeFileSync(original, "old");
  await finish(config, createMetadataCursor(config));
  assert.equal(loadCatalogue(config).records.length, 1);

  const cursor = createMetadataCursor(config);
  const replacement = path.join(path.dirname(config.roots[0].path), "replacement");
  fs.mkdirSync(replacement);
  fs.writeFileSync(path.join(replacement, "new.md"), "new");
  const priorRoot = config.roots[0];
  config.roots = [{ ...priorRoot, path: replacement, maxFileBytes: priorRoot.maxFileBytes - 1 }];
  const changed = await finish(config, cursor);
  assert.equal(changed.complete, true);
  assert.deepEqual(loadCatalogue(config).records.map((record) => record.relative), ["new.md"]);
  assert.equal(loadCatalogue(config).records.some((record) => record.path === original), false);

  const removalCursor = createMetadataCursor(config);
  config.roots = [];
  const removed = await refreshMetadata(config, { cursor: removalCursor, deadline: Date.now() + 1_000 });
  assert.equal(removed.status, "ok");
  assert.equal(removed.complete, true);
  assert.equal(loadCatalogue(config).records.length, 0);
});

test("an already-aborted policy change remains pending until replacement publication", async (t) => {
  const config = fixture(t);
  const oldPath = path.join(config.roots[0].path, "old.md");
  fs.writeFileSync(oldPath, "old");
  await finish(config, createMetadataCursor(config));

  const cursor = createMetadataCursor(config);
  const replacement = path.join(path.dirname(config.roots[0].path), "replacement-after-abort");
  fs.mkdirSync(replacement);
  const newPath = path.join(replacement, "new.md");
  fs.writeFileSync(newPath, "new");
  config.roots = [{ ...config.roots[0], path: replacement }];

  const abort = new AbortController();
  abort.abort();
  assert.equal((await refreshMetadata(config, { cursor, signal: abort.signal })).status, "aborted");
  for (let slice = 0; slice < 3; slice += 1) {
    await refreshMetadata(config, { cursor, maxEntries: 1, deadline: Date.now() + 1_000 });
  }

  const records = loadCatalogue(config).records;
  assert.equal(records.some((record) => record.path === oldPath), false);
  assert.equal(records.some((record) => record.path === newPath), true);
  closeMetadataCursor(cursor);
});

test("policy invalidations survive every unpublished failure branch", { concurrency: false }, async (t) => {
  for (const failure of ["busy", "storageRejected", "beforePublish", "publish"]) {
    await t.test(failure, async (child) => {
      const config = fixture(child);
      const oldPath = path.join(config.roots[0].path, "old.md");
      fs.writeFileSync(oldPath, "old");
      await finish(config, createMetadataCursor(config));
      const cursor = createMetadataCursor(config);
      const replacement = path.join(path.dirname(config.roots[0].path), `replacement-${failure}`);
      fs.mkdirSync(replacement);
      const newPath = path.join(replacement, "new.md");
      fs.writeFileSync(newPath, "new");
      config.roots = [{ ...config.roots[0], path: replacement }];

      if (failure === "busy") {
        const lock = require("../packages/local-search/maintenance").acquire(config);
        try { assert.equal((await refreshMetadata(config, { cursor })).status, "busy"); }
        finally { lock.release(); }
      } else if (failure === "storageRejected") {
        config.budgets.quotaBytes = 1;
        assert.equal((await refreshMetadata(config, { cursor, deadline: Date.now() + 1_000 })).status, "storageRejected");
        config.budgets.quotaBytes = Number.MAX_SAFE_INTEGER;
      } else if (failure === "beforePublish") {
        assert.equal((await refreshMetadata(config, {
          cursor, deadline: Date.now() + 1_000,
          beforePublish() { throw new Error("pre-publish failure"); },
        })).status, "failed");
      } else {
        const rename = fs.renameSync;
        fs.renameSync = (source, target) => {
          if (target === path.join(config.stateDirectory, "catalogue.json")) throw Object.assign(new Error("publish failed"), { code: "EIO" });
          return rename(source, target);
        };
        try { assert.equal((await refreshMetadata(config, { cursor, deadline: Date.now() + 1_000 })).status, "failed"); }
        finally { fs.renameSync = rename; }
      }

      assert.equal(cursor.pendingPolicyInvalidations.has(config.roots[0].id), true);
      assert.equal((await finish(config, cursor)).complete, true);
      const records = loadCatalogue(config).records;
      assert.equal(records.some((record) => record.path === oldPath), false);
      assert.equal(records.some((record) => record.path === newPath), true);
      assert.equal(cursor.pendingPolicyInvalidations.size, 0);
    });
  }
});

test("deletion candidates stay stable across catalogue reorder and growth", async (t) => {
  const config = fixture(t, 2);
  const removed = ["one.md", "two.md", "three.md"];
  for (const name of removed) fs.writeFileSync(path.join(config.roots[0].path, name), name);
  fs.writeFileSync(path.join(config.roots[1].path, "kept.md"), "kept");
  await finish(config, createMetadataCursor(config));
  for (const name of removed) fs.unlinkSync(path.join(config.roots[0].path, name));

  const cursor = createMetadataCursor(config);
  await refreshMetadata(config, { cursor, maxEntries: 1, maxDeletionChecks: 1, maxDeletions: 1, deadline: Date.now() + 1_000 });
  await refreshMetadata(config, { cursor, maxEntries: 1, maxDeletionChecks: 1, maxDeletions: 1, deadline: Date.now() + 1_000 });
  const concurrent = loadCatalogue(config);
  concurrent.records.unshift({
    ...concurrent.records.find((record) => record.rootId === "docs-1"),
    sourceId: "concurrent", relative: "concurrent.md", path: path.join(config.roots[1].path, "concurrent.md"),
  });
  publish(config, concurrent);

  let result;
  for (let slice = 0; slice < 30; slice += 1) {
    result = await refreshMetadata(config, { cursor, maxEntries: 1, maxDeletionChecks: 1, maxDeletions: 1, deadline: Date.now() + 1_000 });
    if (result.complete) break;
  }
  assert.equal(result.complete, true);
  assert.equal(loadCatalogue(config).records.some((record) => record.rootId === "docs-0"), false);
});

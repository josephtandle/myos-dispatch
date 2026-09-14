"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const api = require("../packages/local-search");
const { normalizeConfig } = require("../packages/local-search/config");
const { reconcile } = require("../packages/local-search/catalogue");
const { classify, discoverRoot, readVerified, readVerifiedBytes } = require("../packages/local-search/scope");
const { stage } = require("../packages/local-search/staging");
const { MAX_MANIFEST_BYTES } = require("../packages/local-search/admission");

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function fixture() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "local-search-admission-"));
  const root = path.join(base, "docs");
  const state = path.join(base, "state");
  const manifest = path.join(base, "admission.json");
  fs.mkdirSync(root, { mode: 0o700 });
  fs.mkdirSync(state, { mode: 0o700 });
  fs.writeFileSync(path.join(root, "allowed.md"), "allowed", { mode: 0o600 });
  fs.writeFileSync(path.join(root, "other.md"), "other", { mode: 0o600 });
  return { base, root, state, manifest };
}

function rootConfig(fx, extra = {}) {
  return { id: "docs", path: fx.root, contentEnabled: true, extensions: [".md"], maxFiles: 50, maxFileBytes: 4096, ...extra };
}

function configFor(fx, roots = [rootConfig(fx)]) {
  return normalizeConfig({
    enabled: true,
    stateDirectory: fx.state,
    roots,
    budgets: { reserveBytes: 1, reserveFraction: 0.000001, quotaBytes: 1024 ** 2 },
  });
}

function manifestFor(fx, entries = ["allowed.md"]) {
  const rootStat = fs.lstatSync(fx.root, { bigint: true });
  return {
    version: 1, rootId: "docs", rootPath: fs.realpathSync(fx.root),
    root: { dev: rootStat.dev.toString(), ino: rootStat.ino.toString() },
    policySha256: "a".repeat(64),
    files: entries.map((relative) => {
      const stat = fs.lstatSync(path.join(fx.root, relative), { bigint: true });
      const bytes = fs.readFileSync(path.join(fx.root, relative));
      return { path: relative, sha256: sha256(bytes), dev: stat.dev.toString(), ino: stat.ino.toString() };
    }),
  };
}

function writeManifest(fx, value) { fs.writeFileSync(fx.manifest, JSON.stringify(value), { mode: 0o600 }); }

test("legacy roots retain content admission without a manifest", () => {
  const fx = fixture();
  const config = normalizeConfig({ enabled: true, stateDirectory: fx.state, roots: [rootConfig(fx)] });
  assert.equal(readVerified(config.roots[0], path.join(fx.root, "allowed.md")).ok, true);
});

test("configured admission fails closed when its manifest is missing and denies unlisted files", () => {
  const fx = fixture();
  const config = normalizeConfig({ enabled: true, stateDirectory: fx.state, roots: [rootConfig(fx, { admissionManifest: fx.manifest, admissionPolicySha256: "a".repeat(64) })] });
  assert.equal(readVerified(config.roots[0], path.join(fx.root, "allowed.md")).ok, false);
  writeManifest(fx, manifestFor(fx));
  assert.equal(readVerified(config.roots[0], path.join(fx.root, "allowed.md")).ok, true);
  assert.equal(readVerified(config.roots[0], path.join(fx.root, "other.md")).ok, false);
});

test("manifest validation rejects traversal, duplicates, empty allow-lists, and symlink manifests", () => {
  const fx = fixture();
  const config = normalizeConfig({ enabled: true, stateDirectory: fx.state, roots: [rootConfig(fx, { admissionManifest: fx.manifest, admissionPolicySha256: "a".repeat(64) })] });
  for (const files of [["../allowed.md"], ["allowed.md", "allowed.md"], []]) {
    writeManifest(fx, manifestFor(fx));
    assert.equal(readVerified(config.roots[0], path.join(fx.root, "allowed.md")).ok, true);
    const manifest = manifestFor(fx, files[0] === "../allowed.md" ? ["allowed.md"] : files);
    if (files[0] === "../allowed.md") manifest.files[0].path = "../allowed.md";
    writeManifest(fx, manifest);
    assert.equal(readVerified(config.roots[0], path.join(fx.root, "allowed.md")).ok, false);
  }
  writeManifest(fx, manifestFor(fx));
  assert.equal(readVerified(config.roots[0], path.join(fx.root, "allowed.md")).ok, true);
  fs.unlinkSync(fx.manifest);
  fs.symlinkSync(path.join(fx.root, "allowed.md"), fx.manifest);
  assert.equal(readVerified(config.roots[0], path.join(fx.root, "allowed.md")).ok, false);
});

test("manifest permits only listed text files and directory ancestors", () => {
  const fx = fixture();
  fs.mkdirSync(path.join(fx.root, "nested"));
  fs.writeFileSync(path.join(fx.root, "nested", "allowed.md"), "nested", { mode: 0o600 });
  const config = normalizeConfig({ enabled: true, stateDirectory: fx.state, roots: [rootConfig(fx, { admissionManifest: fx.manifest, admissionPolicySha256: "a".repeat(64) })] });
  writeManifest(fx, manifestFor(fx, ["nested/allowed.md"]));
  const root = config.roots[0];
  assert.equal(classify(root, path.join(fx.root, "nested")).ok, true);
  assert.equal(classify(root, path.join(fx.root, "allowed.md")).ok, false);
  assert.deepEqual(discoverRoot(root, Date.now() + 1_000).files.map((file) => file.relative), ["nested/allowed.md"]);
});

test("source, root, and manifest changes cannot bypass a cached candidate", () => {
  const fx = fixture();
  const config = normalizeConfig({ enabled: true, stateDirectory: fx.state, roots: [rootConfig(fx, { admissionManifest: fx.manifest, admissionPolicySha256: "a".repeat(64) })] });
  const root = config.roots[0];
  writeManifest(fx, manifestFor(fx));
  const source = path.join(fx.root, "allowed.md");
  assert.equal(readVerified(root, source).ok, true);
  const original = fs.statSync(source);
  fs.writeFileSync(source, "changed");
  fs.utimesSync(source, original.atime, original.mtime);
  assert.equal(readVerified(root, source).ok, false);
  fs.writeFileSync(source, "allowed", { mode: 0o600 });
  writeManifest(fx, manifestFor(fx));
  assert.equal(readVerified(root, source).ok, true);
  assert.equal(readVerifiedBytes(root, source, { afterRead: () => fs.unlinkSync(fx.manifest) }).ok, false);
  writeManifest(fx, manifestFor(fx));
  assert.equal(readVerified(root, source).ok, true);
  assert.equal(readVerifiedBytes(root, source, { afterRead: () => writeManifest(fx, manifestFor(fx, [])) }).ok, false);
  writeManifest(fx, manifestFor(fx));
  assert.equal(readVerified(root, source).ok, true);
  fs.renameSync(source, path.join(fx.root, "old.md"));
  fs.writeFileSync(source, "allowed", { mode: 0o600 });
  assert.equal(readVerified(root, source).ok, false);
  fs.rmSync(fx.root, { recursive: true });
  fs.mkdirSync(fx.root, { mode: 0o700 });
  fs.writeFileSync(source, "allowed", { mode: 0o600 });
  assert.equal(readVerified(root, source).ok, false);
});

test("manifest loader denies hardlinks and path swaps without unbounded reads", () => {
  const fx = fixture();
  writeManifest(fx, manifestFor(fx));
  const config = configFor(fx, [rootConfig(fx, { admissionManifest: fx.manifest, admissionPolicySha256: "a".repeat(64) })]);
  const root = config.roots[0];
  const source = path.join(fx.root, "allowed.md");
  assert.equal(readVerified(root, source).ok, true);

  const linked = path.join(fx.base, "linked-admission.json");
  fs.linkSync(fx.manifest, linked);
  assert.equal(readVerified(root, source).ok, false);
  fs.unlinkSync(linked);

  writeManifest(fx, manifestFor(fx));
  assert.equal(readVerified(root, source).ok, true);
  const originalOpen = fs.openSync;
  let swapped = false;
  fs.openSync = function swappedOpen(filePath, ...args) {
    if (!swapped && filePath === fx.manifest) {
      swapped = true;
      fs.renameSync(fx.manifest, `${fx.manifest}.old`);
      fs.symlinkSync(source, fx.manifest);
    }
    return originalOpen.call(this, filePath, ...args);
  };
  try { assert.equal(readVerified(root, source).ok, false); } finally { fs.openSync = originalOpen; }

  fs.unlinkSync(fx.manifest);
  fs.renameSync(`${fx.manifest}.old`, fx.manifest);
  assert.equal(readVerified(root, source).ok, true);
  const originalRead = fs.readSync;
  let largestRead = 0;
  let grew = false;
  fs.readSync = function growingRead(fd, buffer, offset, length, position) {
    largestRead = Math.max(largestRead, length);
    if (!grew) {
      grew = true;
      fs.appendFileSync(fx.manifest, " ".repeat(MAX_MANIFEST_BYTES + 1));
    }
    return originalRead.call(this, fd, buffer, offset, length, position);
  };
  try { assert.equal(readVerified(root, source).ok, false); } finally { fs.readSync = originalRead; }
  assert.ok(largestRead <= MAX_MANIFEST_BYTES + 1);

  const moved = `${fx.base}.moved`;
  writeManifest(fx, manifestFor(fx));
  assert.equal(readVerified(root, source).ok, true);
  let ancestorSwapped = false;
  fs.readSync = function swappingAncestor(fd, buffer, offset, length, position) {
    const count = originalRead.call(this, fd, buffer, offset, length, position);
    if (!ancestorSwapped) {
      ancestorSwapped = true;
      fs.renameSync(fx.base, moved);
      fs.mkdirSync(fx.base, { mode: 0o700 });
    }
    return count;
  };
  try { assert.equal(readVerified(root, source).ok, false); } finally { fs.readSync = originalRead; }
});

test("admission manifests must be outside every approved root", () => {
  const fx = fixture();
  const other = path.join(fx.base, "other-root");
  fs.mkdirSync(other, { mode: 0o700 });
  const admitted = rootConfig(fx, { admissionManifest: fx.manifest, admissionPolicySha256: "a".repeat(64) });
  assert.equal(configFor(fx, [admitted, { ...rootConfig(fx), id: "other", path: other }]).roots.length, 2);

  assert.throws(() => configFor(fx, [
    { ...admitted, admissionManifest: path.join(other, "admission.json") },
    { ...rootConfig(fx), id: "other", path: other },
  ]), /outside.*approved root/i);
});

test("staging rejects cached reads after revocation and rechecks generation before publication", () => {
  const fx = fixture();
  writeManifest(fx, manifestFor(fx));
  const config = configFor(fx, [rootConfig(fx, { admissionManifest: fx.manifest, admissionPolicySha256: "a".repeat(64) })]);
  const fresh = reconcile(config, { publish: false });
  assert.equal(fresh.currentReads.get(path.join(fx.root, "allowed.md")).ok, true);
  assert.equal(stage(config, fresh.catalogue, "a".repeat(64), fresh.currentReads).staged.length, 1);

  writeManifest(fx, manifestFor(fx, []));
  const revoked = stage(config, fresh.catalogue, "b".repeat(64), fresh.currentReads);
  assert.equal(revoked.staged.length, 0);
  assert.equal(fs.readdirSync(path.join(fx.state, "staging", "docs")).length, 0);

  writeManifest(fx, manifestFor(fx));
  const refreshed = reconcile(config, { publish: false });
  assert.equal(refreshed.currentReads.get(path.join(fx.root, "allowed.md")).ok, true);
  const originalRename = fs.renameSync;
  let revokedDuringStage = false;
  fs.renameSync = function revokingRename(from, to) {
    const result = originalRename.call(this, from, to);
    if (!revokedDuringStage && to.endsWith(".md")) {
      revokedDuringStage = true;
      writeManifest(fx, manifestFor(fx, []));
    }
    return result;
  };
  let raced;
  try { raced = stage(config, refreshed.catalogue, "c".repeat(64), refreshed.currentReads); } finally { fs.renameSync = originalRename; }
  assert.equal(raced.staged.length, 0);
  assert.equal(fs.readdirSync(path.join(fx.state, "staging", "docs")).length, 0);
});

test("rollback unlink failure blocks QMD update and embedding after publication revocation", async () => {
  const fx = fixture();
  writeManifest(fx, manifestFor(fx));
  const config = configFor(fx, [rootConfig(fx, { admissionManifest: fx.manifest, admissionPolicySha256: "a".repeat(64) })]);
  const fresh = reconcile(config, { publish: false });
  const positive = stage(config, fresh.catalogue, "d".repeat(64), fresh.currentReads);
  assert.equal(positive.ok, true);
  assert.equal(positive.staged.length, 1);

  const originalRename = fs.renameSync;
  const originalUnlink = fs.unlinkSync;
  let revokedDuringPublication = false;
  let rollbackDenied = false;
  let updateCalls = 0;
  let embeddingCalls = 0;
  fs.renameSync = function revokingRename(from, to) {
    const result = originalRename.call(this, from, to);
    if (!revokedDuringPublication && to.endsWith(".md")) {
      revokedDuringPublication = true;
      writeManifest(fx, manifestFor(fx, []));
    }
    return result;
  };
  fs.unlinkSync = function deniedRollback(filePath) {
    if (revokedDuringPublication && filePath.endsWith(".md")) {
      rollbackDenied = true;
      throw Object.assign(new Error("rollback denied"), { code: "EACCES" });
    }
    return originalUnlink.call(this, filePath);
  };

  let result;
  try {
    result = await api.index(config, { adapters: {
      qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }),
      updateIndex: async () => { updateCalls += 1; return { ok: true, status: "indexed", indexed: 0 }; },
      embedCollection: async () => { embeddingCalls += 1; return { ok: true }; },
    } });
  } finally {
    fs.renameSync = originalRename;
    fs.unlinkSync = originalUnlink;
  }

  assert.equal(revokedDuringPublication, true);
  assert.equal(rollbackDenied, true);
  assert.equal(result.ok, false);
  assert.equal(result.status, "stagingRollbackFailed");
  assert.equal(updateCalls, 0);
  assert.equal(embeddingCalls, 0);
});

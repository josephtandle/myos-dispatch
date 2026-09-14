"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { normalizeConfig } = require("../packages/local-search/config");
const { ADMISSION_REFRESH_POLICY_SHA256, refreshAdmissions, revokeAdmission } = require("../packages/local-search/admission-refresh");
const { admissionFor, loadManifest } = require("../packages/local-search/admission");
const { reconcile } = require("../packages/local-search/catalogue");
const { readVerified, readVerifiedBytes, verifyMetadata } = require("../packages/local-search/scope");
const { stage } = require("../packages/local-search/staging");

function fixture() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "local-search-refresh-"));
  const root = path.join(base, "docs");
  const state = path.join(base, "state");
  fs.mkdirSync(root, { mode: 0o700 });
  fs.mkdirSync(state, { mode: 0o700 });
  return { base, root, state, manifest: path.join(base, "admission.json") };
}

function input(fx, root = {}, budgets = {}) {
  return {
    enabled: true,
    stateDirectory: fx.state,
    roots: [{
      id: "docs", path: fx.root, contentEnabled: true, extensions: [".md"],
      maxFiles: 50, maxFileBytes: 4096,
      admissionManifest: fx.manifest,
      admissionPolicySha256: "a".repeat(64),
      ...root,
    }],
    budgets: { maxContentScanBytes: 8192, indexDeadlineMs: 2000, reserveBytes: 1, reserveFraction: 0.000001, quotaBytes: 1024 ** 2, ...budgets },
  };
}

test("refresh opt-in is an exact technical Markdown root contract", () => {
  const fx = fixture();
  assert.throws(() => normalizeConfig(input(fx, { admissionRefreshPolicy: "technical-markdown-v1" })), /policy hash|unknown field/i);
  assert.equal(normalizeConfig(input(fx, { admissionManifest: undefined, admissionPolicySha256: undefined })).roots[0].admissionRefreshPolicy, null);
});

function automaticConfig(fx, root = {}, budgets = {}) {
  return normalizeConfig(input(fx, {
    admissionPolicySha256: ADMISSION_REFRESH_POLICY_SHA256,
    admissionRefreshPolicy: "technical-markdown-v1",
    ...root,
  }, budgets));
}

function rewriteManifest(fx, mutate) {
  const manifest = JSON.parse(fs.readFileSync(fx.manifest, "utf8"));
  mutate(manifest);
  fs.writeFileSync(fx.manifest, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
}

test("automatic refresh admits only clean technical Markdown and exact exclusions persist", async () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.root, "guide.md"), "Build with deterministic checks.", { mode: 0o600 });
  fs.writeFileSync(path.join(fx.root, "payments.md"), "Technical notes.", { mode: 0o600 });
  fs.writeFileSync(path.join(fx.root, "people.md"), "A customer phone number is recorded.", { mode: 0o600 });
  fs.writeFileSync(path.join(fx.root, "excluded.md"), "Clean but permanently excluded.", { mode: 0o600 });
  const config = automaticConfig(fx, { admissionExcludePaths: ["excluded.md"] });

  const result = await refreshAdmissions(config);
  assert.deepEqual({ ok: result.ok, approved: result.approved, denied: result.denied }, { ok: true, approved: 1, denied: 3 });
  const manifest = loadManifest(config.roots[0]);
  assert.equal(manifest.ok, true);
  assert.deepEqual([...manifest.entries.keys()], ["guide.md"]);
  assert.equal(readVerified(config.roots[0], path.join(fx.root, "guide.md")).ok, true);
  assert.equal(readVerified(config.roots[0], path.join(fx.root, "people.md")).ok, false);

  fs.writeFileSync(path.join(fx.root, "guide.md"), "Changed clean technical material.", { mode: 0o600 });
  fs.writeFileSync(path.join(fx.root, "new.md"), "A newly added clean document.", { mode: 0o600 });
  const changed = await refreshAdmissions(config);
  assert.equal(changed.ok, true);
  assert.deepEqual([...loadManifest(config.roots[0]).entries.keys()].sort(), ["guide.md", "new.md"]);

  fs.writeFileSync(path.join(fx.root, "guide.md"), "customer payment notes", { mode: 0o600 });
  assert.equal((await refreshAdmissions(config)).ok, true);
  assert.deepEqual([...loadManifest(config.roots[0]).entries.keys()], ["new.md"]);
});

test("config exclusions deny metadata, bytes, staging, and refresh body reads immediately", async () => {
  const fx = fixture();
  const source = path.join(fx.root, "guide.md");
  fs.writeFileSync(source, "clean technical guide", { mode: 0o600 });
  const admitted = automaticConfig(fx);
  assert.equal((await refreshAdmissions(admitted)).ok, true);
  const fresh = reconcile(admitted, { publish: false });
  assert.equal(fresh.currentReads.get(source).ok, true);

  const excluded = automaticConfig(fx, { admissionExcludePaths: ["guide.md"] });
  assert.equal(verifyMetadata(excluded.roots[0], source).ok, false);
  assert.equal(readVerifiedBytes(excluded.roots[0], source).ok, false);
  assert.equal(stage(excluded, fresh.catalogue, "e".repeat(64), fresh.currentReads).staged.length, 0);
  let sourceOpens = 0;
  assert.equal((await refreshAdmissions(excluded, { beforeSourceOpen: () => { sourceOpens += 1; } })).ok, true);
  assert.equal(sourceOpens, 0);
});

test("optional durable revocations have a strict schema and deny paths with ancestor awareness", async () => {
  const fx = fixture();
  fs.mkdirSync(path.join(fx.root, "dir"), { mode: 0o700 });
  fs.writeFileSync(path.join(fx.root, "dir", "private.md"), "private technical guide", { mode: 0o600 });
  fs.writeFileSync(path.join(fx.root, "dir", "public.md"), "public technical guide", { mode: 0o600 });
  const config = automaticConfig(fx);
  assert.equal((await refreshAdmissions(config)).ok, true);
  assert.equal(loadManifest(config.roots[0]).ok, true, "the legacy six-key manifest remains valid");

  rewriteManifest(fx, (manifest) => { manifest.revoked = ["dir/private.md"]; });
  const revoked = loadManifest(config.roots[0]);
  assert.equal(revoked.ok, true);
  assert.deepEqual([...revoked.revoked], ["dir/private.md"]);
  assert.equal(admissionFor(config.roots[0], "dir").ancestor, true);
  assert.equal(readVerified(config.roots[0], path.join(fx.root, "dir", "private.md")).ok, false);
  assert.equal(readVerified(config.roots[0], path.join(fx.root, "dir", "public.md")).ok, true);

  rewriteManifest(fx, (manifest) => { manifest.revoked = ["*"]; });
  assert.equal(readVerified(config.roots[0], path.join(fx.root, "dir", "public.md")).ok, false);

  for (const invalid of [["dir/private.md", "dir/private.md"], ["../private.md"], ["*", "dir/private.md"]]) {
    rewriteManifest(fx, (manifest) => { manifest.revoked = invalid; });
    assert.equal(loadManifest(config.roots[0]).ok, false);
  }
});

test("refresh and revoke serialize in both orders without losing durable revocations", async () => {
  const fx = fixture();
  const source = path.join(fx.root, "guide.md");
  fs.writeFileSync(source, "clean technical guide", { mode: 0o600 });
  const oldConfig = automaticConfig(fx);
  assert.equal((await refreshAdmissions(oldConfig)).ok, true);

  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  let refreshLocked;
  const refreshReached = new Promise((resolve) => { refreshLocked = resolve; });
  const refreshing = refreshAdmissions(oldConfig, { beforePublish: async () => {
    refreshLocked();
    await refreshGate;
  } });
  await refreshReached;
  let revokeFinished = false;
  const revoking = revokeAdmission(oldConfig, "docs", "guide.md", { timeoutMs: 1000 }).then((result) => {
    revokeFinished = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(revokeFinished, false);
  releaseRefresh();
  assert.equal((await refreshing).ok, true);
  assert.equal((await revoking).ok, true);
  assert.equal(readVerified(oldConfig.roots[0], source).ok, false);

  let sourceOpens = 0;
  assert.equal((await refreshAdmissions(oldConfig, { beforeSourceOpen: () => { sourceOpens += 1; } })).ok, true);
  assert.equal(sourceOpens, 0, "an old config worker reloads and screens the durable revocation before source reads");
  assert.equal(readVerified(oldConfig.roots[0], source).ok, false);

  rewriteManifest(fx, (manifest) => { manifest.revoked = []; });
  let releaseRevoke;
  const revokeGate = new Promise((resolve) => { releaseRevoke = resolve; });
  let revokeLocked;
  const revokeReached = new Promise((resolve) => { revokeLocked = resolve; });
  const first = revokeAdmission(oldConfig, "docs", "guide.md", { timeoutMs: 1000, beforePublish: async () => {
    revokeLocked();
    await revokeGate;
  } });
  await revokeReached;
  let refreshFinished = false;
  const second = refreshAdmissions(oldConfig).then((result) => {
    refreshFinished = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshFinished, false);
  releaseRevoke();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.deepEqual([...loadManifest(oldConfig.roots[0]).revoked], ["guide.md"]);
  assert.equal(readVerified(oldConfig.roots[0], source).ok, false);
});

test("wildcard revocation survives refresh and prevents every source body read", async () => {
  const fx = fixture();
  const one = path.join(fx.root, "one.md");
  const two = path.join(fx.root, "two.md");
  fs.writeFileSync(one, "first technical guide", { mode: 0o600 });
  fs.writeFileSync(two, "second technical guide", { mode: 0o600 });
  const config = automaticConfig(fx);
  assert.equal((await refreshAdmissions(config)).ok, true);
  assert.equal((await revokeAdmission(config, "docs", "*")).ok, true);
  assert.equal(readVerified(config.roots[0], one).ok, false);
  assert.equal(readVerified(config.roots[0], two).ok, false);
  let sourceOpens = 0;
  assert.equal((await refreshAdmissions(config, { beforeSourceOpen: () => { sourceOpens += 1; } })).ok, true);
  assert.equal(sourceOpens, 0);
  assert.deepEqual([...loadManifest(config.roots[0]).revoked], ["*"]);
});

test("lock timeout, unsafe lock, and cancellation never publish", async () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.root, "guide.md"), "stable technical guide", { mode: 0o600 });
  const config = automaticConfig(fx);
  assert.equal((await refreshAdmissions(config)).ok, true);
  const original = fs.readFileSync(fx.manifest);
  const lockPath = `${fx.manifest}.lock`;
  fs.mkdirSync(lockPath, { mode: 0o700 });

  const timedOut = await refreshAdmissions(config, { deadline: Date.now() + 20 });
  assert.equal(timedOut.ok, false);
  assert.deepEqual(fs.readFileSync(fx.manifest), original);

  const controller = new AbortController();
  const cancelled = revokeAdmission(config, "docs", "guide.md", { signal: controller.signal, timeoutMs: 1000 });
  setImmediate(() => controller.abort());
  assert.equal((await cancelled).status, "aborted");
  assert.deepEqual(fs.readFileSync(fx.manifest), original);

  fs.chmodSync(lockPath, 0o755);
  assert.equal((await revokeAdmission(config, "docs", "guide.md", { timeoutMs: 1000 })).status, "ADMISSION_REFRESH_UNSAFE");
  assert.deepEqual(fs.readFileSync(fx.manifest), original);
  fs.chmodSync(lockPath, 0o700);
  fs.rmdirSync(lockPath);
});

test("a replaced lock is neither released nor followed by publication", async () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.root, "guide.md"), "stable technical guide", { mode: 0o600 });
  const config = automaticConfig(fx);
  assert.equal((await refreshAdmissions(config)).ok, true);
  const original = fs.readFileSync(fx.manifest);
  const lockPath = `${fx.manifest}.lock`;
  const displaced = `${lockPath}.displaced`;
  const result = await revokeAdmission(config, "docs", "guide.md", { beforePublish: () => {
    fs.renameSync(lockPath, displaced);
    fs.mkdirSync(lockPath, { mode: 0o700 });
  } });
  assert.equal(result.status, "admissionLockOwnershipLost");
  assert.deepEqual(fs.readFileSync(fx.manifest), original);
  assert.equal(fs.existsSync(lockPath), true);
  fs.rmdirSync(lockPath);
  fs.rmdirSync(displaced);
});

test("an opted-in root can publish an empty deny-all manifest", async () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.root, "client-notes.md"), "client details", { mode: 0o600 });
  const config = automaticConfig(fx);
  const result = await refreshAdmissions(config);
  assert.equal(result.ok, true);
  const manifest = loadManifest(config.roots[0]);
  assert.equal(manifest.ok, true);
  assert.equal(manifest.entries.size, 0);
  assert.equal(readVerified(config.roots[0], path.join(fx.root, "client-notes.md")).ok, false);
});

test("manual roots are unchanged and incur no refresh source scans", async () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.root, "manual.md"), "manual", { mode: 0o600 });
  const config = normalizeConfig(input(fx));
  let opens = 0;
  const result = await refreshAdmissions(config, { beforeSourceOpen: () => { opens += 1; } });
  assert.equal(result.status, "notConfigured");
  assert.equal(opens, 0);
  assert.equal(fs.existsSync(fx.manifest), false);
});

test("failed, aborted, and raced refreshes preserve the previous valid manifest", async () => {
  const fx = fixture();
  const source = path.join(fx.root, "guide.md");
  fs.writeFileSync(source, "stable technical guide", { mode: 0o600 });
  const config = automaticConfig(fx);
  assert.equal((await refreshAdmissions(config)).ok, true);
  const original = fs.readFileSync(fx.manifest);

  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await refreshAdmissions(config, { signal: aborted.signal })).ok, false);
  assert.deepEqual(fs.readFileSync(fx.manifest), original);

  const expired = await refreshAdmissions(config, { deadline: Date.now() });
  assert.equal(expired.ok, false);
  assert.deepEqual(fs.readFileSync(fx.manifest), original);

  const raced = await refreshAdmissions(config, { beforePublish: () => fs.writeFileSync(source, "changed in place", { mode: 0o600 }) });
  assert.equal(raced.ok, false);
  assert.equal(raced.status, "sourceChangedDuringRefresh");
  assert.deepEqual(fs.readFileSync(fx.manifest), original);

  fs.writeFileSync(source, "stable technical guide", { mode: 0o600 });
  assert.equal((await refreshAdmissions(config)).ok, true);
  const revoked = await refreshAdmissions(config, { beforePublish: () => {
    const denyAll = JSON.parse(fs.readFileSync(fx.manifest, "utf8"));
    denyAll.files = [];
    fs.writeFileSync(fx.manifest, JSON.stringify(denyAll), { mode: 0o600 });
  } });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.status, "admissionRevokedDuringRefresh");
  assert.equal(loadManifest(config.roots[0]).entries.size, 0);
});

test("refresh fails closed on byte, file, and storage quotas", async () => {
  for (const [name, root, budgets, expected] of [
    ["bytes", {}, { maxContentScanBytes: 4 }, "contentScanLimit"],
    ["files", { maxFiles: 1 }, {}, "partialDiscovery"],
    ["storage", {}, { quotaBytes: 1 }, "quotaExceeded"],
  ]) {
    const fx = fixture();
    fs.writeFileSync(path.join(fx.root, "one.md"), "clean technical text", { mode: 0o600 });
    if (name === "files") fs.writeFileSync(path.join(fx.root, "two.md"), "more clean text", { mode: 0o600 });
    const result = await refreshAdmissions(automaticConfig(fx, root, budgets));
    assert.equal(result.ok, false, name);
    assert.equal(result.status, expected, name);
    assert.equal(fs.existsSync(fx.manifest), false, name);
  }
});

test("source symlinks and hardlinks are never automatically admitted", async () => {
  const fx = fixture();
  const clean = path.join(fx.root, "clean.md");
  fs.writeFileSync(clean, "technical text", { mode: 0o600 });
  fs.linkSync(clean, path.join(fx.root, "linked.md"));
  fs.symlinkSync(clean, path.join(fx.root, "symlink.md"));
  const outside = path.join(fx.base, "outside");
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.writeFileSync(path.join(outside, "outside.md"), "technical text", { mode: 0o600 });
  fs.symlinkSync(outside, path.join(fx.root, "linked-directory"));
  const config = automaticConfig(fx);
  const result = await refreshAdmissions(config);
  assert.equal(result.ok, true);
  assert.equal(loadManifest(config.roots[0]).entries.size, 0);
});

test("regular-file to FIFO swaps are bounded denials for manifests and source reads", () => {
  if (process.platform === "win32") return;
  const fx = fixture();
  const source = path.join(fx.root, "guide.md");
  fs.writeFileSync(source, "technical text", { mode: 0o600 });
  const manual = normalizeConfig(input(fx, { admissionManifest: undefined, admissionPolicySha256: undefined })).roots[0];
  const originalOpen = fs.openSync;
  let swapped = false;
  fs.openSync = function fifoSource(filePath, ...args) {
    if (!swapped && filePath === source) {
      swapped = true;
      fs.unlinkSync(source);
      execFileSync("mkfifo", [source]);
    }
    return originalOpen.call(this, filePath, ...args);
  };
  try { assert.equal(readVerified(manual, source).ok, false); } finally { fs.openSync = originalOpen; }

  fs.unlinkSync(source);
  fs.writeFileSync(source, "technical text", { mode: 0o600 });
  const automatic = automaticConfig(fx).roots[0];
  const rootStat = fs.lstatSync(fx.root, { bigint: true });
  fs.writeFileSync(fx.manifest, JSON.stringify({
    version: 1, rootId: "docs", rootPath: fs.realpathSync(fx.root),
    root: { dev: rootStat.dev.toString(), ino: rootStat.ino.toString() },
    policySha256: ADMISSION_REFRESH_POLICY_SHA256, files: [],
  }), { mode: 0o600 });
  swapped = false;
  fs.openSync = function fifoManifest(filePath, ...args) {
    if (!swapped && filePath === fx.manifest) {
      swapped = true;
      fs.unlinkSync(fx.manifest);
      execFileSync("mkfifo", [fx.manifest]);
    }
    return originalOpen.call(this, filePath, ...args);
  };
  try { assert.equal(loadManifest(automatic).ok, false); } finally { fs.openSync = originalOpen; }
});

test("the heavy maintenance worker stops before indexing after a failed refresh", () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.root, "large.md"), "clean technical text", { mode: 0o600 });
  const node = "/Users/myos/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node";
  const configured = input(fx, {
    admissionPolicySha256: ADMISSION_REFRESH_POLICY_SHA256,
    admissionRefreshPolicy: "technical-markdown-v1",
  }, { maxContentScanBytes: 4 });
  configured.qmd = {
    nodePath: node, packageRoot: path.join(fx.base, "missing-qmd"),
    modelPaths: { embed: path.join(fx.base, "missing.gguf") }, modelHashes: {},
  };
  const config = normalizeConfig(configured);
  const worker = path.join(__dirname, "../packages/local-search/maintenance-worker.mjs");
  const stdout = execFileSync(node, [worker], {
    input: JSON.stringify({ config, qmdStatus: { available: true, semanticAvailable: true, status: "available" } }),
    encoding: "utf8",
    timeout: 5000,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, false);
  assert.equal(result.status, "contentScanLimit");
  assert.equal(fs.existsSync(path.join(fx.state, "catalogue.json")), false);
});

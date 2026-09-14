"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { loadManifest, MAX_MANIFEST_BYTES } = require("./admission");
const { classify, hasSecretContent, readVerified } = require("./scope");
const { storageAdmission } = require("./resources");

const POLICY_NAME = "technical-markdown-v1";
const MAX_SCAN_BYTES = 8 * 1024 ** 2;
const PATH_DENY = /(?:finance|financial|bank|tax|billing|payment|invoice|participant|customer|client|identity|passport|contact|message|whatsapp|telegram|session|transcript|credential|secret|token|password|\.jsonl$)/i;
const CONTENT_DENY = /(?:\bparticipant\b|\bcustomer\b|\bclient\b|\bfinancial\b|\bfinance\b|\bbank\b|\btax[ -]?id\b|\bpassport\b|\bphone number\b|\btelephone\b|\bemail address\b|\bWhatsApp\b|\bTelegram\b|\binvoice\b|\bpayment\b|\bcredit card\b|\bSSN\b|\bdate of birth\b)/i;
const POLICY_CONTRACT = Object.freeze({
  name: POLICY_NAME,
  extension: ".md",
  pathDeny: PATH_DENY.source,
  contentDeny: CONTENT_DENY.source,
  fixedScopeExclusions: Object.freeze(["hiddenPath", "excludedDirectory", "protectedAbsolutePath", "sensitiveName", "symlinkDenied", "hardlinkDenied", "foreignOwner", "sizeLimit", "cloudPlaceholderOrFlagsUnavailable", "unsupportedBinary", "invalidUtf8", "secretPatternDenied"]),
});
const ADMISSION_REFRESH_POLICY_SHA256 = crypto.createHash("sha256").update(JSON.stringify(POLICY_CONTRACT)).digest("hex");

function pathIsDenied(relative, deniedPaths) {
  for (const candidate of deniedPaths) if (candidate === "*" || relative === candidate || relative.startsWith(`${candidate}/`)) return true;
  return false;
}

function sameDirectory(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid;
}

function sameSource(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function ownerControlledDirectory(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink() && (Number(stat.mode) & 0o022) === 0
    && (typeof process.getuid !== "function" || stat.uid === BigInt(process.getuid()) || stat.uid === 0n);
}

function inspectAncestors(target) {
  const result = [];
  let cursor = path.parse(target).root;
  for (const part of [null, ...target.slice(cursor.length).split(path.sep).filter(Boolean)]) {
    if (part !== null) cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor, { bigint: true });
    if (!ownerControlledDirectory(stat)) throw Object.assign(new Error("unsafe manifest ancestor"), { code: "ADMISSION_REFRESH_UNSAFE" });
    result.push({ path: cursor, stat });
  }
  return result;
}

function sameAncestors(a, b) {
  return a.length === b.length && a.every((entry, index) => entry.path === b[index].path && sameDirectory(entry.stat, b[index].stat));
}

function manifestGeneration(root) {
  try {
    const loaded = loadManifest(root);
    if (!loaded.ok) return { state: "invalid" };
    return { state: "present", generation: loaded.generation, loaded };
  } catch { return { state: "invalid" }; }
}

function sameGeneration(a, b) {
  return a.state === b.state && (a.state !== "present" || a.generation === b.generation);
}

function absentManifest(manifestPath) {
  try { fs.lstatSync(manifestPath); return false; }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
}

function initialGeneration(root) {
  if (absentManifest(root.admissionManifest)) return { state: "absent", revoked: new Set() };
  return manifestGeneration(root);
}

function currentGeneration(root) {
  if (absentManifest(root.admissionManifest)) return { state: "absent" };
  return manifestGeneration(root);
}

function sanitizedFailure(status, counts) {
  return { ok: false, status, complete: false, roots: counts.roots, scanned: counts.scanned, approved: counts.approved, denied: counts.denied };
}

function checkCancelled(options, deadline) {
  if (options.signal?.aborted) throw Object.assign(new Error("refresh aborted"), { code: "aborted" });
  if (Date.now() >= deadline) throw Object.assign(new Error("refresh deadline"), { code: "deadlineExpired" });
}

function privateLock(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink() && (Number(stat.mode) & 0o077) === 0
    && (typeof process.getuid !== "function" || stat.uid === BigInt(process.getuid()));
}

function assertManifestLock(lock) {
  let current;
  try { current = fs.lstatSync(lock.path, { bigint: true }); }
  catch (error) {
    if (error.code === "ENOENT") throw Object.assign(new Error("manifest lock disappeared"), { code: "admissionLockOwnershipLost" });
    throw error;
  }
  if (!privateLock(current) || !sameDirectory(lock.stat, current)) {
    throw Object.assign(new Error("manifest lock identity changed"), { code: "admissionLockOwnershipLost" });
  }
}

function releaseManifestLock(lock) {
  assertManifestLock(lock);
  fs.rmdirSync(lock.path);
}

async function acquireManifestLock(root, options, deadline) {
  // This coordinates supported refresh/revoke writers; it is not a security boundary
  // against a malicious process already running as the same account.
  const parent = path.dirname(root.admissionManifest);
  const canonical = path.join(fs.realpathSync(parent), path.basename(root.admissionManifest));
  if (canonical !== root.admissionManifest) throw Object.assign(new Error("manifest path noncanonical"), { code: "ADMISSION_REFRESH_UNSAFE" });
  const ancestors = inspectAncestors(parent);
  const lockPath = `${root.admissionManifest}.lock`;
  while (true) {
    checkCancelled(options, deadline);
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      const stat = fs.lstatSync(lockPath, { bigint: true });
      if (!privateLock(stat) || !sameAncestors(ancestors, inspectAncestors(parent))) {
        throw Object.assign(new Error("manifest lock unsafe"), { code: "ADMISSION_REFRESH_UNSAFE" });
      }
      if (options.signal?.aborted) {
        releaseManifestLock({ path: lockPath, stat });
        checkCancelled(options, deadline);
      }
      return { path: lockPath, stat };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let existing;
      try { existing = fs.lstatSync(lockPath, { bigint: true }); }
      catch (readError) { if (readError.code === "ENOENT") continue; throw readError; }
      if (!privateLock(existing)) throw Object.assign(new Error("manifest lock unsafe"), { code: "ADMISSION_REFRESH_UNSAFE" });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

function publishManifest(config, root, manifest, previous, lock) {
  assertManifestLock(lock);
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  if (bytes.length > MAX_MANIFEST_BYTES) throw Object.assign(new Error("manifest too large"), { code: "admissionManifestLimit" });
  const storage = storageAdmission(config, bytes.length);
  if (!storage.ok) throw Object.assign(new Error("storage denied"), { code: storage.status });
  const parent = path.dirname(root.admissionManifest);
  const ancestorsBefore = inspectAncestors(parent);
  if (path.join(fs.realpathSync(parent), path.basename(root.admissionManifest)) !== root.admissionManifest) {
    throw Object.assign(new Error("manifest path noncanonical"), { code: "ADMISSION_REFRESH_UNSAFE" });
  }
  if (!sameGeneration(previous, currentGeneration(root))) throw Object.assign(new Error("manifest changed"), { code: "admissionRevokedDuringRefresh" });
  const temporary = `${root.admissionManifest}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd;
  let parentFd;
  let created = false;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0), 0o600);
    created = true;
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const tempStat = fs.lstatSync(temporary, { bigint: true });
    if (!tempStat.isFile() || tempStat.isSymbolicLink() || tempStat.nlink !== 1n || (Number(tempStat.mode) & 0o077) !== 0
      || (typeof process.getuid === "function" && tempStat.uid !== BigInt(process.getuid()))) throw Object.assign(new Error("temp unsafe"), { code: "ADMISSION_REFRESH_UNSAFE" });
    const ancestorsAfter = inspectAncestors(parent);
    if (!sameAncestors(ancestorsBefore, ancestorsAfter) || !sameGeneration(previous, currentGeneration(root))) {
      throw Object.assign(new Error("publication race"), { code: "admissionRevokedDuringRefresh" });
    }
    parentFd = fs.openSync(parent, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    if (!sameDirectory(ancestorsBefore.at(-1).stat, fs.fstatSync(parentFd, { bigint: true }))) {
      throw Object.assign(new Error("manifest parent changed"), { code: "ADMISSION_REFRESH_UNSAFE" });
    }
    assertManifestLock(lock);
    fs.renameSync(temporary, root.admissionManifest);
    created = false;
    fs.fsyncSync(parentFd);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    if (parentFd !== undefined) try { fs.closeSync(parentFd); } catch {}
    if (created) try { fs.unlinkSync(temporary); } catch {}
  }
}

async function refreshRootLocked(config, root, options, deadline, counts, lock) {
  const maximumFiles = Math.min(root.maxFiles, 10_000);
  const maximumBytes = Math.min(config.budgets.maxContentScanBytes, MAX_SCAN_BYTES);
  const rootBefore = fs.lstatSync(root.path, { bigint: true });
  if (!ownerControlledDirectory(rootBefore)) throw Object.assign(new Error("root unsafe"), { code: "sourceRootUnsafe" });
  const realRoot = fs.realpathSync(root.path);
  if (realRoot !== root.path) throw Object.assign(new Error("root changed"), { code: "sourceRootUnsafe" });
  const previous = initialGeneration(root);
  if (previous.state === "invalid") throw Object.assign(new Error("manifest invalid"), { code: "admissionManifestInvalid" });
  const deniedPaths = new Set([...root.admissionExcludePaths, ...(previous.loaded?.revoked || [])]);
  const directories = [];
  const candidates = [];
  let rootScanned = 0;
  let scannedBytes = 0;
  const screenRoot = { ...root, admissionManifest: null, admissionPolicySha256: null, admissionRefreshPolicy: null };

  const visit = async (directory) => {
    checkCancelled(options, deadline);
    const before = fs.lstatSync(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw Object.assign(new Error("directory unsafe"), { code: "partialDiscovery" });
    const handle = await fs.promises.opendir(directory);
    try {
      for await (const entry of handle) {
        checkCancelled(options, deadline);
        const target = path.join(directory, entry.name);
        const relative = path.relative(root.path, target).split(path.sep).join("/");
        if (entry.isSymbolicLink()) { counts.denied += 1; continue; }
        if (entry.isDirectory()) {
          if (classify(screenRoot, target).ok) await visit(target);
          continue;
        }
        if (!entry.isFile() || path.posix.extname(relative).toLowerCase() !== ".md") continue;
        rootScanned += 1;
        counts.scanned += 1;
        if (rootScanned > maximumFiles) throw Object.assign(new Error("file bound"), { code: "partialDiscovery" });
        await new Promise((resolve) => setImmediate(resolve));
        checkCancelled(options, deadline);
        if (pathIsDenied(relative, deniedPaths) || PATH_DENY.test(relative)) { counts.denied += 1; continue; }
        const prospective = fs.lstatSync(target, { bigint: true });
        const prospectiveBytes = Number(prospective.size);
        const remainingBytes = maximumBytes - scannedBytes;
        if (!Number.isSafeInteger(prospectiveBytes) || prospectiveBytes < 0 || prospectiveBytes > remainingBytes) {
          throw Object.assign(new Error("byte bound"), { code: "contentScanLimit" });
        }
        scannedBytes += prospectiveBytes;
        options.beforeSourceOpen?.();
        const read = readVerified({ ...screenRoot, maxFileBytes: Math.min(screenRoot.maxFileBytes, remainingBytes) }, target, { afterRead: options.afterSourceRead });
        if (!read.ok) { counts.denied += 1; continue; }
        if (read.bytes !== prospectiveBytes) throw Object.assign(new Error("source changed"), { code: "sourceChangedDuringRefresh" });
        if (CONTENT_DENY.test(read.text) || hasSecretContent(read.text)) { counts.denied += 1; continue; }
        candidates.push({ path: relative, sha256: read.hash, dev: read.stat.dev, ino: read.stat.ino, identity: read.stat });
        counts.approved += 1;
      }
    } finally { try { await handle.close(); } catch {} }
    const after = fs.lstatSync(directory, { bigint: true });
    if (!sameDirectory(before, after)) throw Object.assign(new Error("directory changed"), { code: "sourceChangedDuringRefresh" });
    directories.push({ path: directory, stat: before });
  };

  await visit(root.path);
  checkCancelled(options, deadline);
  await options.beforePublish?.();
  checkCancelled(options, deadline);
  const rootAfter = fs.lstatSync(root.path, { bigint: true });
  if (!sameDirectory(rootBefore, rootAfter) || fs.realpathSync(root.path) !== realRoot) throw Object.assign(new Error("root changed"), { code: "sourceChangedDuringRefresh" });
  for (const directory of directories) {
    if (!sameDirectory(directory.stat, fs.lstatSync(directory.path, { bigint: true }))) throw Object.assign(new Error("directory changed"), { code: "sourceChangedDuringRefresh" });
  }
  for (const candidate of candidates) {
    checkCancelled(options, deadline);
    const reread = readVerified(screenRoot, path.join(root.path, ...candidate.path.split("/")));
    if (!reread.ok || reread.hash !== candidate.sha256 || reread.stat.dev !== candidate.dev || reread.stat.ino !== candidate.ino
      || !sameSource(candidate.identity, reread.stat)) throw Object.assign(new Error("source changed"), { code: "sourceChangedDuringRefresh" });
  }
  if (!sameGeneration(previous, currentGeneration(root))) throw Object.assign(new Error("manifest changed"), { code: "admissionRevokedDuringRefresh" });
  const manifest = {
    version: 1, rootId: root.id, rootPath: realRoot,
    root: { dev: rootBefore.dev.toString(), ino: rootBefore.ino.toString() },
    policySha256: ADMISSION_REFRESH_POLICY_SHA256,
    files: candidates.map(({ path: relative, sha256, dev, ino }) => ({ path: relative, sha256, dev, ino })),
    ...(previous.loaded?.revoked.size ? { revoked: [...previous.loaded.revoked] } : {}),
  };
  publishManifest(config, root, manifest, previous, lock);
  const loaded = loadManifest(root);
  if (!loaded.ok || loaded.entries.size !== candidates.length || loaded.revoked.size !== (previous.loaded?.revoked.size || 0)) {
    throw Object.assign(new Error("publication failed"), { code: "admissionPublicationFailed" });
  }
}

async function refreshRoot(config, root, options, deadline, counts) {
  const lock = await acquireManifestLock(root, options, deadline);
  try { await refreshRootLocked(config, root, options, deadline, counts, lock); }
  finally { releaseManifestLock(lock); }
}

async function refreshAdmissions(config, options = {}) {
  const roots = config.roots.filter((root) => root.admissionRefreshPolicy === POLICY_NAME);
  if (roots.length === 0) return { ok: true, status: "notConfigured", complete: true, roots: 0, scanned: 0, approved: 0, denied: 0 };
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + config.budgets.indexDeadlineMs);
  const totals = { roots: roots.length, scanned: 0, approved: 0, denied: 0 };
  try {
    for (const root of roots) {
      await refreshRoot(config, root, options, deadline, totals);
    }
    return { ok: true, status: "refreshed", complete: true, ...totals };
  } catch (error) {
    return sanitizedFailure(error.code || "admissionRefreshFailed", totals);
  }
}

function validRevocation(value) {
  return value === "*" || (typeof value === "string" && value.length > 0 && value.length <= 4096
    && !value.includes("\\") && value === path.posix.normalize(value) && !value.startsWith("/")
    && !value.split("/").some((part) => !part || part === "." || part === ".."));
}

async function revokeAdmission(config, rootId, relativeOrStar, options = {}) {
  const root = config.roots.find((candidate) => candidate.id === rootId);
  if (!root || root.admissionRefreshPolicy !== POLICY_NAME) return { ok: false, status: "admissionRevocationUnsupported" };
  if (!validRevocation(relativeOrStar)) return { ok: false, status: "invalidAdmissionRevocation" };
  const requestedWait = options.timeoutMs ?? config.budgets.indexDeadlineMs;
  const boundedWait = Number.isFinite(requestedWait) ? Math.max(1, Math.min(requestedWait, 30_000)) : 30_000;
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + boundedWait);
  let lock;
  let result;
  try {
    lock = await acquireManifestLock(root, options, deadline);
    const previous = initialGeneration(root);
    if (previous.state !== "present") throw Object.assign(new Error("manifest unavailable"), { code: "admissionManifestInvalid" });
    if (pathIsDenied(relativeOrStar, previous.loaded.revoked)) {
      result = { ok: true, status: "alreadyRevoked", rootId, revoked: relativeOrStar };
    } else {
      const revoked = relativeOrStar === "*" ? ["*"] : [...previous.loaded.revoked, relativeOrStar];
      if (revoked.length > 10_000) throw Object.assign(new Error("revocation limit"), { code: "admissionManifestLimit" });
      // Automatic refresh owns this manifest. Operators must use this API or config exclusions;
      // concurrent manual edits are unsupported and are only detected by generation checks.
      const manifest = { ...previous.loaded.document, revoked };
      await options.beforePublish?.();
      checkCancelled(options, deadline);
      publishManifest(config, root, manifest, previous, lock);
      const loaded = loadManifest(root);
      if (!loaded.ok || !pathIsDenied(relativeOrStar, loaded.revoked)) {
        throw Object.assign(new Error("revocation publication failed"), { code: "admissionPublicationFailed" });
      }
      result = { ok: true, status: "revoked", rootId, revoked: relativeOrStar };
    }
  } catch (error) {
    result = { ok: false, status: error.code || "admissionRevocationFailed" };
  } finally {
    if (lock) {
      try { releaseManifestLock(lock); }
      catch (error) { result = { ok: false, status: error.code || "admissionLockReleaseFailed" }; }
    }
  }
  return result;
}

module.exports = { ADMISSION_REFRESH_POLICY_SHA256, POLICY_CONTRACT, refreshAdmissions, revokeAdmission };

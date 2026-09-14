"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { runQmd } = require("./qmd");
const { hasSecretContent, readVerified, readVerifiedBytes } = require("./scope");
const { hydratedContent, isDocument, sameSourceIdentity } = require("./hydration");
const { admissionFor } = require("./admission");
const { maintenanceReservation, storageAdmission } = require("./resources");

function safeDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw Object.assign(new Error("unsafe staging directory"), { code: "UNSAFE_STATE" });
}

function inspectOwnedFiles(directory) {
  const targets = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const ownedCache = /^[a-f0-9]{64}\.md$/.test(entry.name);
    const interruptedTemp = /^[a-f0-9]{64}\.md\.[1-9][0-9]*\.tmp$/.test(entry.name);
    if (!entry.isFile() || (!ownedCache && !interruptedTemp)) throw Object.assign(new Error("staging contains an unowned or corrupt entry"), { code: "STAGING_CORRUPT" });
    const target = path.join(directory, entry.name);
    const stat = fs.lstatSync(target);
    const ownerMismatch = typeof process.getuid === "function" && stat.uid !== process.getuid();
    const unsafeMode = (stat.mode & 0o077) !== 0;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || ownerMismatch || unsafeMode) throw Object.assign(new Error("staging entry is unsafe"), { code: "STAGING_CORRUPT" });
    targets.push(target);
  }
  return targets;
}

function publishManifests(config, manifests, revision) {
  const target = path.join(config.stateDirectory, "staging-manifest.json");
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, revision, roots: manifests })}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, target);
}

function loadManifests(config) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(config.stateDirectory, "staging-manifest.json"), "utf8"));
    return parsed.version === 1 && parsed.roots && typeof parsed.roots === "object" ? parsed.roots : {};
  } catch { return {}; }
}

function quotaAllows(config, requestedBytes) {
  try { return storageAdmission(config, requestedBytes).ok; } catch { return false; }
}

function unavailable(record, reason) {
  return { ok: false, status: "sourceUnavailable", reason, path: record.path };
}

function currentStageContent(root, record, cached) {
  if (!isDocument(record)) return readVerified(root, record.path);
  const hydrated = hydratedContent(record, cached);
  if (!hydrated?.ok) return hydrated || unavailable(record, "documentNotHydrated");
  const source = readVerifiedBytes(root, record.path);
  if (!source.ok) return source;
  if (source.hash !== hydrated.hash || !sameSourceIdentity(source, hydrated)) return unavailable(record, "changedBeforeStage");
  return { ...hydrated, admissionGeneration: source.admissionGeneration };
}

function admissionIsCurrent(item) {
  if (!item.root.admissionManifest) return true;
  const current = admissionFor(item.root, item.record.relative);
  return current.ok && !current.legacy && current.entry
    && current.generation === item.current.admissionGeneration
    && current.entry.sha256 === item.current.hash
    && current.entry.dev === item.current.stat.dev && current.entry.ino === item.current.stat.ino;
}

function stage(config, catalogue, revision, currentReads = new Map()) {
  const stagingRoot = path.join(config.stateDirectory, "staging");
  safeDirectory(stagingRoot);
  const manifests = {};
  const staged = [];
  const skipped = [];
  let requestedBytes = 0;
  for (const root of config.roots) {
    const directory = path.join(stagingRoot, root.id);
    safeDirectory(directory);
    manifests[root.id] = {};
    for (const record of catalogue.records.filter((item) => item.rootId === root.id && item.contentEligible)) {
      const current = currentStageContent(root, record, currentReads.get(record.path));
      if (!current.ok) { skipped.push({ sourceId: record.sourceId, status: current.status, reason: current.reason }); continue; }
      if (hasSecretContent(current.text)) { skipped.push({ sourceId: record.sourceId, status: "secretPatternDenied" }); continue; }
      requestedBytes += Buffer.byteLength(current.text);
      const contentIdentity = current.extractionKey || current.hash;
      const filename = `${crypto.createHash("sha256").update(`${record.sourceId}:${contentIdentity}`).digest("hex")}.md`;
      staged.push({ root, record, current, filename, directory });
    }
  }
  const ownedFiles = config.roots.flatMap((root) => inspectOwnedFiles(path.join(stagingRoot, root.id)));
  const reservation = maintenanceReservation(config, staged.length, requestedBytes);
  if (!reservation.ok) return { ...reservation, manifests, staged: [], skipped };
  const admission = storageAdmission(config, reservation.stagingRequestedBytes);
  if (!admission.ok) return { ok: false, status: "storageReserveOrQuota", storage: admission, reservation, manifests, staged: [], skipped };
  for (const target of ownedFiles) fs.unlinkSync(target);
  const published = [];
  for (const item of staged) {
    const current = currentStageContent(item.root, item.record, item.current);
    if (!current.ok || current.hash !== item.current.hash || !sameSourceIdentity(current, item.current)
      || current.admissionGeneration !== item.current.admissionGeneration) {
      skipped.push({ sourceId: item.record.sourceId, status: current.status || "sourceUnavailable", reason: current.reason || "changedBeforeStage" });
      continue;
    }
    item.current = current;
    const target = path.join(item.directory, item.filename);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, item.current.text, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, target);
    item.record.observedHash = item.current.hash;
    manifests[item.root.id][item.filename] = {
      sourceId: item.record.sourceId,
      hash: item.current.hash,
      sourceHash: item.current.hash,
      parserFingerprint: item.current.parserFingerprint || null,
      extractionKey: item.current.extractionKey || null,
      revision,
    };
    published.push(item);
  }
  if (!published.every(admissionIsCurrent)) {
    let rollbackError = null;
    for (const item of published) {
      const target = path.join(item.directory, item.filename);
      try { fs.unlinkSync(target); } catch (error) {
        if (error.code !== "ENOENT" && !rollbackError) rollbackError = error;
      }
      skipped.push({ sourceId: item.record.sourceId, status: "sourceUnavailable", reason: "admissionRevokedBeforePublication" });
    }
    for (const rootId of Object.keys(manifests)) manifests[rootId] = {};
    published.length = 0;
    publishManifests(config, manifests, revision);
    if (rollbackError) return { ok: false, status: "stagingRollbackFailed", manifests, staged: published, skipped, reservation };
    return { ok: true, manifests, staged: published, skipped, reservation };
  }
  publishManifests(config, manifests, revision);
  return { ok: true, manifests, staged: published, skipped, reservation };
}

async function updateQmd(config, staged, adapters = {}) {
  if (!staged.ok) return staged;
  const storage = storageAdmission(config, staged.reservation?.requestedBytes || 0);
  if (!storage.ok) return { ok: false, status: storage.status, storage };
  if (adapters.updateIndex) return adapters.updateIndex(staged, { signal: adapters.signal });
  const registered = new Set();
  for (const item of staged.staged) {
    if (registered.has(item.root.id)) continue;
    registered.add(item.root.id);
    const invoke = adapters.runQmd || runQmd;
    const listed = await invoke(config, ["--index", "myos-search", "collection", "list"]);
    if (!listed.ok) return listed;
    if (!new RegExp(`(^|\\s)${item.root.id}(\\s|$)`, "m").test(listed.stdout)) {
      const added = await invoke(config, ["--index", "myos-search", "collection", "add", item.directory, "--name", item.root.id, "--mask", "**/*.md"]);
      if (!added.ok) return added;
    }
  }
  const updated = await (adapters.runQmd || runQmd)(config, ["--index", "myos-search", "update"]);
  if (!updated.ok) return updated;
  return { ok: true, status: "indexed", indexed: staged.staged.length };
}

async function embedQmd(config, rootIds, adapters = {}) {
  const results = [];
  for (const rootId of rootIds) {
    if (!adapters.embedCollection && config.qmd) {
      const storage = storageAdmission(config, config.budgets.writeScratchBytes);
      if (!storage.ok) { results.push({ ok: false, status: storage.status, storage }); break; }
    }
    results.push(adapters.embedCollection
      ? await adapters.embedCollection(rootId, { signal: adapters.signal })
      : await (adapters.runQmd || runQmd)(config, ["--index", "myos-search", "embed", "-c", rootId, "--max-docs-per-batch", "8", "--max-batch-mb", "8", "--timeout", "10"]));
  }
  return results;
}

module.exports = { embedQmd, loadManifests, quotaAllows, stage, updateQmd };

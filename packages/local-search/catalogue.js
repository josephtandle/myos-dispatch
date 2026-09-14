"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { discoverRoot, readVerified, readVerifiedBytes } = require("./scope");

function cataloguePath(config) { return path.join(config.stateDirectory, "catalogue.json"); }

function ensureState(config) {
  let cursor = path.parse(config.stateDirectory).root;
  for (const part of config.stateDirectory.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor)) {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw Object.assign(new Error("stateDirectory components cannot be symlinks"), { code: "UNSAFE_STATE" });
    } else {
      fs.mkdirSync(cursor, { mode: 0o700 });
    }
  }
  const stat = fs.lstatSync(config.stateDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw Object.assign(new Error("stateDirectory must be a private, ordinary directory"), { code: "UNSAFE_STATE" });
}

function loadCatalogue(config) {
  try {
    const data = JSON.parse(fs.readFileSync(cataloguePath(config), "utf8"));
    if (data.version !== 1 || !Array.isArray(data.records)) throw new Error("invalid catalogue");
    return data;
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, records: [], reconciledAt: null, roots: {} };
    return { version: 1, records: [], reconciledAt: null, roots: {}, degraded: "catalogueCorrupt" };
  }
}

function publish(config, catalogue) {
  ensureState(config);
  const target = cataloguePath(config);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(catalogue)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, target);
}

function sourceId(rootId, relative) {
  return crypto.createHash("sha256").update(`${rootId}\0${relative}`).digest("hex");
}

function reconcile(config, options = {}) {
  ensureState(config);
  const previous = loadCatalogue(config);
  if (previous.degraded === "catalogueCorrupt") return { catalogue: previous, unavailable: [{ status: "sourceUnavailable", reason: previous.degraded }], complete: false };
  const selectedRoots = options.roots || config.roots;
  const recordsByRoot = new Map(config.roots.map((root) => [root.id, []]));
  for (const record of previous.records) if (recordsByRoot.has(record.rootId)) recordsByRoot.get(record.rootId).push(record);
  const deadline = options.deadline || Date.now() + config.budgets.indexDeadlineMs;
  const rootStates = { ...(previous.roots || {}) };
  const unavailable = [];
  const currentReads = new Map();
  let contentBytes = 0;
  let budgetExceeded = false;
  for (const root of selectedRoots) {
    const discovered = discoverRoot(root, deadline);
    unavailable.push(...discovered.unavailableSources.map((item) => ({ ...item, rootId: root.id })));
    let rootIdentity = null;
    try {
      const stat = fs.lstatSync(root.path, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe root");
      rootIdentity = `${stat.dev}:${stat.ino}`;
    } catch {}
    const priorState = previous.roots && previous.roots[root.id];
    const inheritsIndex = Boolean(rootIdentity && priorState && priorState.identity === rootIdentity);
    const records = new Map(recordsByRoot.get(root.id).map((record) => [record.relative, record]));
    if (!inheritsIndex) for (const [relative, record] of records) records.set(relative, { ...record, indexedHash: null, indexedExtractionKey: null });
    const seen = new Set();
    let hashComplete = discovered.complete;
    for (const file of discovered.files) {
      if (Date.now() > deadline) { hashComplete = false; break; }
      let hash = null;
      let observedAt = new Date().toISOString();
      let observedIdentity = null;
      if (file.contentEligible) {
        if (contentBytes + file.size > (options.maxContentScanBytes || Infinity)) {
          hashComplete = false;
          budgetExceeded = true;
          break;
        }
        const read = file.documentEligible ? readVerifiedBytes(root, file.path) : readVerified(root, file.path);
        contentBytes += file.size;
        currentReads.set(file.path, read);
        if (read.ok) { hash = read.hash; observedAt = read.sourceReadAt; observedIdentity = `${read.stat.dev}:${read.stat.ino}`; } else unavailable.push({ ...read, rootId: root.id });
      }
      const old = recordsByRoot.get(root.id).find((item) => item.relative === file.relative);
      seen.add(file.relative);
      records.set(file.relative, {
        sourceId: sourceId(root.id, file.relative), rootId: root.id, relative: file.relative,
        path: file.path, extension: file.extension, textEligible: file.textEligible, documentEligible: file.documentEligible,
        contentType: file.documentEligible ? "document" : file.textEligible ? "text" : "metadata",
        contentEligible: file.contentEligible,
        size: file.size, mtimeMs: file.mtimeMs, observedHash: hash,
        observedIdentity,
        observedExtractionKey: null,
        indexedHash: inheritsIndex && old ? old.indexedHash || null : null,
        indexedExtractionKey: inheritsIndex && old ? old.indexedExtractionKey || null : null,
        observedAt,
      });
    }
    if (hashComplete) for (const relative of records.keys()) if (!seen.has(relative)) records.delete(relative);
    recordsByRoot.set(root.id, [...records.values()]);
    rootStates[root.id] = { complete: hashComplete, status: hashComplete ? "complete" : "partialOrOffline", identity: rootIdentity || (priorState && priorState.identity) || null, observedAt: new Date().toISOString() };
  }
  const rootsReplaced = selectedRoots.some((root) => previous.roots && previous.roots[root.id] && rootStates[root.id].identity !== previous.roots[root.id].identity);
  const catalogue = {
    version: 1, records: [...recordsByRoot.values()].flat(), reconciledAt: new Date().toISOString(), roots: rootStates,
    indexedRevision: rootsReplaced ? null : previous.indexedRevision || null,
    semanticPending: previous.semanticPending === true,
    ...(previous.degraded ? { degraded: previous.degraded } : {}),
  };
  if (options.publish !== false) publish(config, catalogue);
  return {
    catalogue, unavailable, currentReads, contentBytes, budgetExceeded,
    complete: selectedRoots.every((root) => rootStates[root.id] && rootStates[root.id].complete),
  };
}

module.exports = { ensureState, loadCatalogue, publish, reconcile, sourceId };

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadCatalogue, metadataFingerprint, metadataPolicyFingerprint, publish, sourceId } = require("./catalogue");
const { classify, verifyMetadata } = require("./scope");

const DEFAULT_BUDGETS = Object.freeze({ entries: 32, queuedDirectories: 64, directoryHandles: 8, rootFiles: 32, deletionChecks: 32, deletions: 16 });

function positiveBudget(value, fallback, ceiling = 10_000) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, ceiling) : fallback;
}

function sliceBudgets(options) {
  return {
    entries: positiveBudget(options.maxEntries, DEFAULT_BUDGETS.entries),
    queuedDirectories: positiveBudget(options.maxQueuedDirectories, DEFAULT_BUDGETS.queuedDirectories),
    directoryHandles: positiveBudget(options.maxDirectoryHandles, DEFAULT_BUDGETS.directoryHandles),
    rootFiles: positiveBudget(options.maxRootFiles, DEFAULT_BUDGETS.rootFiles),
    deletionChecks: positiveBudget(options.maxDeletionChecks, DEFAULT_BUDGETS.deletionChecks),
    deletions: positiveBudget(options.maxDeletions, DEFAULT_BUDGETS.deletions),
  };
}

function statIdentity(stat) { return `${stat.dev}:${stat.ino}`; }
function mutationIdentity(stat) { return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`; }

function inspectDirectory(root, directory, expectedIdentity) {
  const relative = path.relative(root.path, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return { ok: false, reason: "outsideApprovedRoot" };
  let cursor = path.parse(root.path).root;
  const rootParts = root.path.slice(cursor.length).split(path.sep).filter(Boolean);
  const relativeParts = relative === "" ? [] : relative.split(path.sep);
  try {
    for (const part of [...rootParts, ...relativeParts]) {
      cursor = path.join(cursor, part);
      const stat = fs.lstatSync(cursor, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, reason: "symlinkOrNonDirectory" };
    }
    const stat = fs.lstatSync(directory, { bigint: true });
    const identity = statIdentity(stat);
    if (expectedIdentity && expectedIdentity !== identity) return { ok: false, reason: "directoryIdentityChanged" };
    if (fs.realpathSync(directory) !== directory) return { ok: false, reason: "nonCanonicalDirectory" };
    return { ok: true, identity, mutation: mutationIdentity(stat) };
  } catch (error) {
    return { ok: false, reason: error.code === "ENOENT" ? "removed" : "directoryUnavailable" };
  }
}

function confinedAbsence(root, filePath, expectedRootIdentity) {
  const classification = classify(root, filePath);
  if (!classification.ok) return classification;
  try {
    fs.lstatSync(filePath, { bigint: true });
    return { ok: false, reason: "present" };
  } catch (error) {
    if (error.code !== "ENOENT") return { ok: false, reason: "statFailed" };
  }
  const rootCheck = inspectDirectory(root, root.path, expectedRootIdentity);
  if (!rootCheck.ok) return { ok: false, reason: rootCheck.reason };
  let parent = path.dirname(filePath);
  while (parent !== root.path) {
    const checked = inspectDirectory(root, parent);
    if (checked.ok) break;
    if (checked.reason !== "removed") return { ok: false, reason: checked.reason };
    parent = path.dirname(parent);
    if (path.relative(root.path, parent).startsWith("..")) return { ok: false, reason: "outsideApprovedRoot" };
  }
  return { ok: true, reason: "removed" };
}

function newRootState(root) {
  return {
    root, policyFingerprint: metadataPolicyFingerprint(root), queue: [{ path: root.path, expectedIdentity: null }], directory: null,
    seen: new Set(), visited: new Map(), directoryCount: 1, fileCount: 0, scanDone: false, unsafe: false,
    deletionCandidates: null, deletionIndex: 0,
    verificationPaths: null, verificationIndex: 0, complete: false,
    sweepRootIdentity: null,
  };
}

function createMetadataCursor(config) {
  return {
    roots: config.roots.map(newRootState), nextRoot: 0, metadataRefreshedAt: null,
    metadataSweepCompletedAt: null, metadataPending: true,
    pendingPolicyInvalidations: new Set(), closed: false,
  };
}

function closeDirectory(state) {
  try { state.directory?.handle.closeSync(); } catch {}
  state.directory = null;
}

function closeMetadataCursor(cursor) {
  if (!cursor || cursor.closed) return;
  cursor.closed = true;
  for (const state of cursor.roots || []) closeDirectory(state);
}

function resetSweep(state) {
  closeDirectory(state);
  Object.assign(state, newRootState(state.root));
}

function resetGeneration(cursor) {
  for (const state of cursor.roots) resetSweep(state);
  cursor.nextRoot = 0;
}

function synchronizeRoots(config, cursor) {
  if (!(cursor.pendingPolicyInvalidations instanceof Set)) cursor.pendingPolicyInvalidations = new Set();
  const existing = new Map(cursor.roots.map((state) => [state.root.id, state]));
  const changed = new Set();
  const next = [];
  for (const root of config.roots) {
    const prior = existing.get(root.id);
    const fingerprint = metadataPolicyFingerprint(root);
    if (!prior || prior.policyFingerprint !== fingerprint) {
      if (prior) closeDirectory(prior);
      if (prior) {
        changed.add(root.id);
        cursor.pendingPolicyInvalidations.add(root.id);
      }
      next.push(newRootState(root));
    } else {
      prior.root = root;
      next.push(prior);
    }
    existing.delete(root.id);
  }
  for (const removed of existing.values()) {
    closeDirectory(removed);
    changed.add(removed.root.id);
    cursor.pendingPolicyInvalidations.add(removed.root.id);
  }
  cursor.roots = next;
  if (cursor.roots.length === 0) cursor.nextRoot = 0;
  else cursor.nextRoot %= cursor.roots.length;
  return changed;
}

function invalidateSweep(state) {
  state.unsafe = true;
  state.scanDone = true;
  state.queue.length = 0;
  closeDirectory(state);
}

function openNextDirectory(state, usage, budgets) {
  if (state.directory || state.queue.length === 0 || usage.directoryHandles >= budgets.directoryHandles) return false;
  const queued = state.queue.shift();
  const checked = inspectDirectory(state.root, queued.path, queued.expectedIdentity);
  if (!checked.ok) { invalidateSweep(state); return false; }
  if (!state.sweepRootIdentity) state.sweepRootIdentity = inspectDirectory(state.root, state.root.path).identity;
  if (!state.sweepRootIdentity || inspectDirectory(state.root, state.root.path, state.sweepRootIdentity).ok !== true) { invalidateSweep(state); return false; }
  try {
    state.directory = { handle: fs.opendirSync(queued.path), path: queued.path, identity: checked.identity, mutation: checked.mutation };
    usage.directoryHandles += 1;
    return true;
  } catch { invalidateSweep(state); return false; }
}

function nextDirectoryEntry(state, usage, budgets) {
  if (state.scanDone || usage.entries >= budgets.entries) return null;
  if (!state.directory && !openNextDirectory(state, usage, budgets)) {
    if (!state.directory && state.queue.length === 0 && !state.unsafe) state.scanDone = true;
    return null;
  }
  const current = inspectDirectory(state.root, state.directory.path, state.directory.identity);
  if (!current.ok || current.mutation !== state.directory.mutation) { invalidateSweep(state); return null; }
  try {
    const entry = state.directory.handle.readSync();
    if (!entry) {
      state.visited.set(state.directory.path, state.directory.mutation);
      closeDirectory(state);
      if (state.queue.length === 0) state.scanDone = true;
      return null;
    }
    usage.entries += 1;
    return { entry, directory: state.directory.path };
  } catch { invalidateSweep(state); return null; }
}

function recordFor(root, admission, old, now) {
  const currentFingerprint = metadataFingerprint(root, admission.stat);
  const changed = !old || old.metadataFingerprint !== currentFingerprint;
  const record = {
    ...(old || {}), sourceId: sourceId(root.id, admission.relative), rootId: root.id,
    relative: admission.relative, path: admission.path, extension: admission.extension,
    textEligible: admission.textEligible, documentEligible: admission.documentEligible,
    contentEligible: admission.contentEligible,
    contentType: admission.documentEligible ? "document" : admission.textEligible ? "text" : "metadata",
    size: Number(admission.stat.size), mtimeMs: Number(admission.stat.mtimeMs),
    metadataFingerprint: currentFingerprint, metadataObservedAt: now,
  };
  if (!changed) return { record, changed: false };
  return { record: { ...record, observedHash: null, observedIdentity: null, observedExtractionKey: null, indexedHash: null, indexedExtractionKey: null }, changed: true };
}

function processEntry(state, item, records, usage, budgets, now) {
  const filePath = path.join(item.directory, item.entry.name);
  const classified = classify(state.root, filePath);
  if (!classified.ok) return 0;
  if (item.entry.isSymbolicLink()) { state.unsafe = true; return 0; }
  if (item.entry.isDirectory()) {
    if (state.queue.length >= budgets.queuedDirectories || state.directoryCount >= budgets.queuedDirectories) { invalidateSweep(state); return 0; }
    const checked = inspectDirectory(state.root, filePath);
    if (!checked.ok) { invalidateSweep(state); return 0; }
    state.queue.push({ path: filePath, expectedIdentity: checked.identity });
    state.directoryCount += 1;
    return 0;
  }
  if (!item.entry.isFile()) return 0;
  const admission = verifyMetadata(state.root, filePath);
  if (!admission.ok) { state.unsafe = true; return 0; }
  state.fileCount += 1;
  usage.rootFiles += 1;
  if (state.fileCount > state.root.maxFiles || usage.rootFiles > budgets.rootFiles) {
    if (state.fileCount > state.root.maxFiles) invalidateSweep(state);
    return 0;
  }
  state.seen.add(admission.relative);
  const key = `${state.root.id}\0${admission.relative}`;
  const next = recordFor(state.root, admission, records.get(key), now);
  records.set(key, next.record);
  return next.changed ? 1 : 0;
}

function processDeletions(state, catalogueRecords, records, usage, budgets) {
  if (!state.scanDone || state.unsafe) return 0;
  if (!state.verificationPaths) state.verificationPaths = [...state.visited.entries()];
  while (state.verificationIndex < state.verificationPaths.length && usage.deletionChecks < budgets.deletionChecks) {
    const [directory, mutation] = state.verificationPaths[state.verificationIndex++];
    usage.deletionChecks += 1;
    const checked = inspectDirectory(state.root, directory);
    if (!checked.ok || checked.mutation !== mutation) { invalidateSweep(state); return 0; }
  }
  if (state.verificationIndex < state.verificationPaths.length) return 0;
  if (!state.deletionCandidates) {
    state.deletionCandidates = [];
    for (const record of catalogueRecords) {
      if (record.rootId !== state.root.id || state.seen.has(record.relative)) continue;
      if (state.deletionCandidates.length >= state.root.maxFiles) { invalidateSweep(state); return 0; }
      state.deletionCandidates.push({ key: `${record.rootId}\0${record.relative}`, path: record.path });
    }
  }
  let changed = 0;
  while (state.deletionIndex < state.deletionCandidates.length && usage.deletionChecks < budgets.deletionChecks && usage.deletions < budgets.deletions) {
    const candidate = state.deletionCandidates[state.deletionIndex++];
    usage.deletionChecks += 1;
    const absent = confinedAbsence(state.root, candidate.path, state.sweepRootIdentity);
    if (absent.ok) {
      records.delete(candidate.key);
      usage.deletions += 1;
      changed += 1;
    } else {
      invalidateSweep(state);
      return changed;
    }
  }
  if (state.deletionIndex >= state.deletionCandidates.length) state.complete = true;
  return changed;
}

function immediate() { return new Promise((resolve) => setImmediate(resolve)); }

async function refreshMetadata(config, options = {}) {
  const cursor = options.cursor;
  if (!cursor || cursor.closed) return { complete: false, status: "closed", changed: 0 };
  synchronizeRoots(config, cursor);
  const policyAtStart = JSON.stringify(config.roots.map((root) => metadataPolicyFingerprint(root)));
  const budgets = sliceBudgets(options);
  const usage = {
    entries: 0, queuedDirectories: 0,
    directoryHandles: cursor.roots.filter((state) => state.directory).length,
    rootFiles: 0, deletionChecks: 0, deletions: 0,
  };
  const processedByRoot = Object.fromEntries(cursor.roots.map((state) => [state.root.id, 0]));
  const resultBudget = { budgets, usage, processedByRoot, budgetQualifier: "cooperativeBudgetNotHardDeadline" };
  const deadline = Math.min(options.deadline ?? Date.now() + 100, Date.now() + 100);
  if (options.signal?.aborted) return { complete: false, status: "aborted", changed: 0, ...resultBudget };
  await immediate();
  const { acquire } = require("./maintenance");
  let lock;
  try { lock = acquire(config); }
  catch (error) { return { complete: false, status: error.code === "MAINTENANCE_BUSY" ? "busy" : "failed", changed: 0, ...resultBudget }; }
  try {
    const catalogue = loadCatalogue(config);
    if (catalogue.degraded === "catalogueCorrupt") return { complete: false, status: "catalogueCorrupt", changed: 0, ...resultBudget };
    const activeRootIds = new Set(config.roots.map((root) => root.id));
    const pendingPolicyInvalidations = new Set(cursor.pendingPolicyInvalidations);
    const retainedRecords = catalogue.records.filter((record) => activeRootIds.has(record.rootId) && !pendingPolicyInvalidations.has(record.rootId));
    const records = new Map(retainedRecords.map((record) => [`${record.rootId}\0${record.relative}`, record]));
    const now = new Date().toISOString();
    let changed = catalogue.records.length - records.size;
    let idle = 0;
    while (usage.entries < budgets.entries && usage.rootFiles < budgets.rootFiles && Date.now() <= deadline && idle < cursor.roots.length && !options.signal?.aborted) {
      let state;
      for (let attempts = 0; attempts < cursor.roots.length; attempts += 1) {
        const candidate = cursor.roots[cursor.nextRoot++ % cursor.roots.length];
        if (!candidate.complete && !candidate.unsafe) { state = candidate; break; }
      }
      if (!state) break;
      const before = usage.entries;
      const item = nextDirectoryEntry(state, usage, budgets);
      if (item) {
        changed += processEntry(state, item, records, usage, budgets, now);
        processedByRoot[state.root.id] += 1;
      }
      idle = usage.entries === before ? idle + 1 : 0;
    }
    usage.queuedDirectories = Math.max(0, ...cursor.roots.map((state) => state.queue.length));
    for (const state of cursor.roots) if (!state.complete) changed += processDeletions(state, retainedRecords, records, usage, budgets);
    if (options.signal?.aborted) {
      resetGeneration(cursor);
      return { complete: false, status: "aborted", changed: 0, ...resultBudget };
    }
    const retainedRootStates = Object.fromEntries(Object.entries(catalogue.roots || {}).filter(([id]) => activeRootIds.has(id) && !pendingPolicyInvalidations.has(id)));
    const nextCatalogue = { ...catalogue, records: [...records.values()], roots: retainedRootStates };
    if (changed) nextCatalogue.semanticPending = true;
    for (const state of cursor.roots) nextCatalogue.roots[state.root.id] = {
      ...(nextCatalogue.roots[state.root.id] || {}), identity: state.sweepRootIdentity || nextCatalogue.roots[state.root.id]?.identity || null,
      metadataComplete: state.complete, metadataPolicy: metadataPolicyFingerprint(state.root), metadataObservedAt: now,
    };
    await immediate();
    if (options.signal?.aborted) {
      resetGeneration(cursor);
      return { complete: false, status: "aborted", changed: 0, ...resultBudget };
    }
    try { if (options.beforePublish) await options.beforePublish(); }
    catch {
      resetGeneration(cursor);
      return { complete: false, status: "failed", changed: 0, ...resultBudget };
    }
    const policyBeforePublish = JSON.stringify(config.roots.map((root) => metadataPolicyFingerprint(root)));
    if (options.signal?.aborted || policyBeforePublish !== policyAtStart) {
      synchronizeRoots(config, cursor);
      resetGeneration(cursor);
      return { complete: false, status: options.signal?.aborted ? "aborted" : "policyChanged", changed: 0, ...resultBudget };
    }
    const requestedBytes = Buffer.byteLength(`${JSON.stringify(nextCatalogue)}\n`);
    const { storageAdmission } = require("./resources");
    let storage;
    try { storage = storageAdmission(config, requestedBytes); } catch { storage = { ok: false, status: "unsafeState" }; }
    if (!storage.ok) {
      resetGeneration(cursor);
      return { complete: false, status: "storageRejected", storageStatus: storage.status, changed: 0, ...resultBudget };
    }
    try { publish(config, nextCatalogue); }
    catch { resetGeneration(cursor); return { complete: false, status: "failed", changed: 0, ...resultBudget }; }
    for (const rootId of pendingPolicyInvalidations) cursor.pendingPolicyInvalidations.delete(rootId);
    const completed = cursor.roots.every((state) => state.complete);
    cursor.metadataRefreshedAt = now;
    if (completed) cursor.metadataSweepCompletedAt = now;
    cursor.metadataPending = !completed;
    if (completed) resetGeneration(cursor);
    else for (const state of cursor.roots) if (state.unsafe) resetSweep(state);
    return {
      complete: completed, status: completed ? "ok" : "partial", changed, processed: usage.entries,
      ...resultBudget, metadataRefreshedAt: cursor.metadataRefreshedAt,
      metadataSweepCompletedAt: cursor.metadataSweepCompletedAt, metadataPending: cursor.metadataPending,
    };
  } finally { lock.release(); }
}

module.exports = { closeMetadataCursor, createMetadataCursor, refreshMetadata };

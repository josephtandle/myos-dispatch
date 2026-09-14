"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { sourceId } = require("./catalogue");
const { emitPacket } = require("./packet");
const { analyzeQuery, termOffsets } = require("./query");
const { classify, readVerified, verifyMetadata } = require("./scope");
const { primeResidency, runWithResidencyScope } = require("./residency");

const CACHE_RECORD_LIMIT = 512;
const DIRECTORY_QUEUE_LIMIT = 256;

function stopped(deadline, signal) { return signal?.aborted || Date.now() >= deadline; }
function later() { return new Promise((resolve) => setImmediate(resolve)); }
function compareRank(first, second) {
  if (first.score !== second.score) return second.score - first.score;
  if (first.rootId !== second.rootId) return first.rootId < second.rootId ? -1 : 1;
  return first.relative === second.relative ? 0 : (first.relative < second.relative ? -1 : 1);
}

async function rootIdentity(root) {
  try {
    const stat = await fsp.lstat(root.path, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() ? `${stat.dev}:${stat.ino}` : null;
  } catch { return null; }
}

function safeCatalogueStat(stat, limit) {
  return stat.isFile() && stat.size <= BigInt(limit) && Number(stat.nlink) === 1
    && (typeof process.getuid !== "function" || Number(stat.uid) === process.getuid())
    && (Number(stat.mode) & 0o077) === 0;
}

function sameCatalogueIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size
    && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs
    && first.mode === second.mode && first.uid === second.uid && first.nlink === second.nlink;
}

async function directorySnapshot(root, directory) {
  const relative = path.relative(root.path, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const snapshots = [];
  const filesystemRoot = path.parse(directory).root;
  let current = filesystemRoot;
  snapshots.push(await directoryIdentity(current));
  for (const part of directory.slice(filesystemRoot.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    snapshots.push(await directoryIdentity(current));
  }
  return snapshots.every(Boolean) ? snapshots : null;
}

async function directoryIdentity(directory) {
  try {
    const stat = await fsp.lstat(directory, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink()
      ? { path: directory, dev: stat.dev.toString(), ino: stat.ino.toString() }
      : null;
  } catch { return null; }
}

function sameDirectorySnapshot(first, second) {
  return first !== null && second !== null && first.length === second.length
    && first.every((item, index) => item.path === second[index].path
      && item.dev === second[index].dev && item.ino === second[index].ino);
}

function exactRelative(query) {
  if (typeof query !== "string" || query.includes("\0") || path.isAbsolute(query)) return null;
  const relative = path.normalize(query);
  const parts = relative.split(path.sep);
  return relative !== "." && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !parts.includes("..") ? relative : null;
}

function candidate(root, current, score = 2_000_000) {
  return {
    sourceId: sourceId(root.id, current.relative), rootId: root.id, path: current.path, relative: current.relative,
    contentEligible: false, includeContent: false, evidenceStat: current.stat, score, mode: "filename",
  };
}

function unavailable(root, relative, current) {
  return { sourceId: sourceId(root.id, relative), status: current.status || "sourceUnavailable", reason: current.reason };
}

async function boundedCatalogue(config, deadline, signal) {
  const target = path.join(config.stateDirectory, "catalogue.json");
  const limit = Math.min(1024 * 1024, config.budgets.maxContentScanBytes);
  let handle;
  try {
    const initial = await fsp.lstat(target, { bigint: true });
    if (initial.size > BigInt(limit)) return { records: [], complete: false, reason: "catalogueOversized" };
    if (!safeCatalogueStat(initial, limit)) return { records: [], complete: false, reason: "catalogueUnsafe" };
    if (stopped(deadline, signal)) return { records: [], complete: false, reason: "abortedOrDeadline" };
    handle = await fsp.open(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
    const before = await handle.stat({ bigint: true });
    const pathBefore = await fsp.lstat(target, { bigint: true });
    if (!safeCatalogueStat(before, limit) || !safeCatalogueStat(pathBefore, limit)
      || !sameCatalogueIdentity(initial, before) || !sameCatalogueIdentity(before, pathBefore)) {
      return { records: [], complete: false, reason: "catalogueUnstable" };
    }
    const bytes = Number(before.size);
    const buffer = Buffer.alloc(bytes);
    let offset = 0;
    while (offset < bytes) {
      if (stopped(deadline, signal)) return { records: [], complete: false, reason: "abortedOrDeadline" };
      const read = await handle.read(buffer, offset, bytes - offset, offset);
      if (read.bytesRead === 0) return { records: [], complete: false, reason: "catalogueUnstable" };
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await fsp.lstat(target, { bigint: true });
    if (!safeCatalogueStat(after, limit) || !safeCatalogueStat(pathAfter, limit)
      || !sameCatalogueIdentity(before, after) || !sameCatalogueIdentity(after, pathAfter)) {
      return { records: [], complete: false, reason: "catalogueUnstable" };
    }
    const data = JSON.parse(buffer.toString("utf8"));
    if (data.version !== 1 || !Array.isArray(data.records)) throw new Error("invalid catalogue");
    return { records: data.records, complete: true };
  } catch (error) {
    if (error.code === "ENOENT") return { records: [], complete: true };
    return { records: [], complete: false, reason: "catalogueCorrupt" };
  } finally { if (handle) await handle.close(); }
}

async function discover(root, deadline, signal) {
  const files = [];
  const unavailableSources = [];
  const initialSnapshot = await directorySnapshot(root, root.path);
  const queue = initialSnapshot ? [{ path: root.path, snapshot: initialSnapshot }] : [];
  const maxEntries = Math.min(8192, Math.max(64, root.maxFiles * 16));
  let entries = 0;
  let complete = initialSnapshot !== null;
  if (!complete) unavailableSources.push(unavailable(root, "", { reason: "rootOfflineOrUnreadable" }));
  while (queue.length && !stopped(deadline, signal)) {
    const queued = queue.shift();
    const directory = queued.path;
    const beforeSnapshot = await directorySnapshot(root, directory);
    if (!sameDirectorySnapshot(queued.snapshot, beforeSnapshot)) {
      unavailableSources.push(unavailable(root, path.relative(root.path, directory), { reason: "directoryIdentityChanged" }));
      complete = false;
      continue;
    }
    if (stopped(deadline, signal)) { complete = false; break; }
    let handle;
    try { handle = await fsp.opendir(directory); } catch {
      unavailableSources.push(unavailable(root, path.relative(root.path, directory), { reason: "rootOfflineOrUnreadable" })); complete = false; continue;
    }
    const directoryFiles = [];
    const directoryFilePaths = [];
    const directoryUnavailable = [];
    const nextDirectories = [];
    let enumerationFailed = false;
    try {
      for await (const entry of handle) {
        if (stopped(deadline, signal) || entries >= maxEntries || files.length + directoryFilePaths.length >= root.maxFiles) { complete = false; break; }
        entries += 1;
        const filePath = path.join(directory, entry.name);
        const classified = classify(root, filePath);
        if (!classified.ok) continue;
        if (entry.isSymbolicLink()) { directoryUnavailable.push(unavailable(root, classified.relative, { reason: "symlinkDenied" })); continue; }
        if (entry.isDirectory()) {
          if (queue.length + nextDirectories.length >= DIRECTORY_QUEUE_LIMIT) { complete = false; break; }
          const snapshot = await directorySnapshot(root, filePath);
          if (snapshot) nextDirectories.push({ path: filePath, snapshot });
          else {
            directoryUnavailable.push(unavailable(root, classified.relative, { reason: "directoryIdentityChanged" }));
            complete = false;
          }
        } else if (entry.isFile()) {
          directoryFilePaths.push(filePath);
        }
        if (entries % 32 === 0) await later();
      }
    } catch { enumerationFailed = true; }
    finally { await handle.close().catch(() => {}); }
    const afterSnapshot = await directorySnapshot(root, directory);
    if (enumerationFailed || !sameDirectorySnapshot(beforeSnapshot, afterSnapshot)) {
      unavailableSources.push(unavailable(root, path.relative(root.path, directory), { reason: "directoryIdentityChanged" }));
      complete = false;
      continue;
    }
    primeResidency(directoryFilePaths, deadline, signal);
    if (stopped(deadline, signal)) { complete = false; break; }
    for (const filePath of directoryFilePaths) {
      const current = verifyMetadata(root, filePath);
      const relative = path.relative(root.path, filePath);
      if (!current.ok) directoryUnavailable.push(unavailable(root, relative, current));
      else directoryFiles.push({ ...current, size: Number(current.stat.size) });
    }
    const verifiedSnapshot = await directorySnapshot(root, directory);
    if (!sameDirectorySnapshot(afterSnapshot, verifiedSnapshot)) {
      unavailableSources.push(unavailable(root, path.relative(root.path, directory), { reason: "directoryIdentityChanged" }));
      complete = false;
      continue;
    }
    files.push(...directoryFiles);
    unavailableSources.push(...directoryUnavailable);
    queue.push(...nextDirectories);
    if (!complete) break;
  }
  if (queue.length || stopped(deadline, signal)) complete = false;
  return { files, unavailableSources, complete };
}

function nativeResult(stage, partial, packet, unavailableSources, extra = {}) {
  return {
    ok: true, status: partial || packet.deadlineExpired ? "partial" : "completeAsOfSnapshot",
    taskClass: "cheap_routing", complianceLane: "unattended_local", nativeStage: stage,
    semanticStatus: "notInvokedNativeMode", semanticFallback: "use semantic mode for conceptual retrieval",
    semanticPending: false, lexicalStatus: "notInvokedNativeMode", negativeIsComplete: false,
    sourceUnavailable: [...unavailableSources, ...packet.omitted], ...packet, ...extra,
  };
}

async function emit(config, ranked, parsed, analysis, deadline, options) {
  const maxResults = Math.min(8, parsed.maxResults || config.budgets.maxResults);
  const maxBytes = Math.min(parsed.maxBytes || config.budgets.maxBytes, config.budgets.maxBytes);
  const maxTokens = parsed.maxTokens || config.budgets.maxTokens;
  const results = [];
  const omitted = [];
  let bytes = 0;
  let tokenEstimate = 0;
  let snapshotBoundary;
  for (let index = 0; index < ranked.length && results.length < maxResults; index += 1) {
    await later();
    if (stopped(deadline, options.signal)) return {
      results: [], omitted: [...omitted, { status: options.signal?.aborted ? "aborted" : "deadlineExpired" }],
      deadlineExpired: !options.signal?.aborted, bytes: 0, tokenEstimate: 0,
    };
    const slots = Math.max(1, Math.min(maxResults - results.length, ranked.length - index));
    const availableBytes = maxBytes - bytes;
    const availableTokens = maxTokens ? maxTokens - tokenEstimate : null;
    if (availableBytes <= 0 || availableTokens !== null && availableTokens <= 0) break;
    const packet = await emitPacket(config, [ranked[index]], parsed.query, {
      ...parsed, maxResults: 1, maxBytes: Math.max(1, Math.floor(availableBytes / slots)),
      ...(availableTokens === null ? {} : { maxTokens: Math.max(1, Math.floor(availableTokens / slots)) }),
      queryAnalysis: analysis, deadline, beforeEmit: options.beforeEmit, signal: options.signal,
    });
    await later();
    if (stopped(deadline, options.signal)) return {
      results: [], omitted: [...omitted, ...packet.omitted, { status: options.signal?.aborted ? "aborted" : "deadlineExpired" }],
      deadlineExpired: !options.signal?.aborted, bytes: 0, tokenEstimate: 0,
    };
    results.push(...packet.results);
    omitted.push(...packet.omitted);
    bytes += packet.bytes;
    tokenEstimate += packet.tokenEstimate;
    snapshotBoundary = packet.snapshotBoundary;
    if (packet.deadlineExpired) return { results: [], omitted, deadlineExpired: true, bytes: 0, tokenEstimate: 0, snapshotBoundary };
  }
  return {
    results, omitted, bytes, tokenEstimate,
    tokenEstimateMethod: "characters_divided_by_four_estimate_only",
    deadlineExpired: false, snapshotBoundary,
  };
}

async function finalEmissionGuard(roots, identities, packet, deadline, signal) {
  const current = await Promise.all(roots.map(async (root) => ({ root, identity: await rootIdentity(root) })));
  const replacedRootIds = new Set(current
    .filter(({ root, identity }) => identities.get(root.id) !== identity)
    .map(({ root }) => root.id));
  const halted = stopped(deadline, signal);
  return {
    packet: { ...packet, results: halted ? [] : packet.results.filter((result) => !replacedRootIds.has(result.rootId)) },
    partial: halted || replacedRootIds.size > 0,
    unavailable: [
      ...[...replacedRootIds].map((rootId) => ({ rootId, status: "rootReplaced" })),
      ...(halted ? [{ status: signal?.aborted ? "aborted" : "deadlineExpired" }] : []),
    ],
  };
}

async function nativeSearchScoped(config, parsed, options = {}) {
  const deadline = Date.now() + config.budgets.queryDeadlineMs;
  const analysis = analyzeQuery(parsed.query);
  const identities = new Map(await Promise.all(parsed.roots.map(async (root) => [root.id, await rootIdentity(root)])));
  const relative = exactRelative(parsed.query);
  const unavailableSources = [];
  if (relative) {
    const ranked = [];
    for (const root of parsed.roots) {
      if (stopped(deadline, options.signal)) break;
      const current = verifyMetadata(root, path.resolve(root.path, relative));
      if (current.ok && current.relative === relative) ranked.push(candidate(root, current));
    }
    if (ranked.length) {
      const packet = await emit(config, ranked.sort(compareRank), parsed, analysis, deadline, options);
      const guarded = await finalEmissionGuard(parsed.roots, identities, packet, deadline, options.signal);
      unavailableSources.push(...guarded.unavailable);
      const literalPacket = guarded.unavailable.some((item) => item.status === "rootReplaced")
        ? { ...guarded.packet, results: [] }
        : guarded.packet;
      return nativeResult("literalPath", guarded.partial, literalPacket, unavailableSources, { routeReason: "nativeLiteralPath" });
    }
  }

  const cached = await boundedCatalogue(config, deadline, options.signal);
  let partial = !cached.complete;
  const cacheMatches = [];
  const queryLower = parsed.query.toLowerCase();
  let examined = 0;
  for (const record of cached.records) {
    if (stopped(deadline, options.signal) || examined >= CACHE_RECORD_LIMIT) { partial = true; break; }
    examined += 1;
    if (examined % 32 === 0) await later();
    if (!record || typeof record.path !== "string" || typeof record.rootId !== "string") continue;
    const root = parsed.roots.find((item) => item.id === record.rootId);
    if (!root) continue;
    const computedRelative = exactRelative(path.relative(root.path, record.path));
    if (!computedRelative || !computedRelative.toLowerCase().includes(queryLower)) continue;
    const current = verifyMetadata(root, record.path);
    if (!current.ok) { unavailableSources.push(unavailable(root, path.basename(record.path), current)); continue; }
    if (current.relative.toLowerCase().includes(queryLower)) cacheMatches.push(candidate(root, current));
  }
  if (cached.records.length > CACHE_RECORD_LIMIT) partial = true;

  const cacheMatchIds = new Set(cacheMatches.map((item) => item.sourceId));
  const filenameMatches = new Map(cacheMatches.map((item) => [item.sourceId, item]));
  const discoveries = [];
  let hasFreshFilenameMatch = false;
  for (const root of parsed.roots) {
    const discovered = await discover(root, deadline, options.signal);
    discoveries.push({ root, ...discovered });
    partial ||= !discovered.complete;
    unavailableSources.push(...discovered.unavailableSources);
    for (const file of discovered.files) {
      if (!file.relative.toLowerCase().includes(queryLower)) continue;
      const current = candidate(root, file);
      filenameMatches.set(current.sourceId, current);
      if (!cacheMatchIds.has(current.sourceId)) hasFreshFilenameMatch = true;
    }
  }
  if (filenameMatches.size > 0) {
    const packet = await emit(config, [...filenameMatches.values()].sort(compareRank), parsed, analysis, deadline, options);
    const guarded = await finalEmissionGuard(parsed.roots, identities, packet, deadline, options.signal);
    unavailableSources.push(...guarded.unavailable);
    const current = hasFreshFilenameMatch ? "current" : "cached";
    return nativeResult(`${current}Filename`, partial || guarded.partial, guarded.packet, unavailableSources, {
      routeReason: `native${current[0].toUpperCase()}${current.slice(1)}Filename`,
    });
  }

  const terms = [...analysis.strongTerms, ...analysis.lexicalTerms.map((value) => ({ kind: "identifier", value }))]
    .filter((term, index, list) => list.findIndex((other) => other.value.toLowerCase() === term.value.toLowerCase()) === index);
  const ranked = [];
  let scannedBytes = 0;
  let actualByteExhaustion = false;
  let textCoverageComplete = terms.length > 0;
  for (const { root, ...discovered } of discoveries) {
    for (const file of discovered.files) {
      await later();
      if (stopped(deadline, options.signal)) { partial = true; break; }
      if (!file.textEligible) { textCoverageComplete = false; continue; }
      const remaining = config.budgets.maxContentScanBytes - scannedBytes;
      if (remaining <= 0) { partial = true; textCoverageComplete = false; actualByteExhaustion = true; break; }
      const boundedRoot = { ...root, maxFileBytes: Math.min(root.maxFileBytes, remaining) };
      const current = readVerified(boundedRoot, file.path);
      await later();
      if (stopped(deadline, options.signal)) { partial = true; break; }
      if (!current.ok) { unavailableSources.push(unavailable(root, file.relative, current)); textCoverageComplete = false; continue; }
      scannedBytes += current.bytes;
      const matched = terms.filter((term) => termOffsets(current.text, term).length > 0);
      if (matched.length) ranked.push({
        sourceId: sourceId(root.id, current.relative), rootId: root.id, path: current.path, relative: current.relative,
        contentEligible: true, includeContent: true, evidenceHash: current.hash, evidenceStat: current.stat,
        score: matched.length, mode: "keyword", exactRequired: true, matchTerms: matched,
      });
    }
  }
  const packet = await emit(config, ranked.sort(compareRank), parsed, analysis, deadline, options);
  const guarded = await finalEmissionGuard(parsed.roots, identities, packet, deadline, options.signal);
  unavailableSources.push(...guarded.unavailable);
  partial ||= guarded.partial;
  return nativeResult("currentText", partial, guarded.packet, unavailableSources, {
    routeReason: "nativeCurrentText", supportedTextCoverage: textCoverageComplete && !partial && unavailableSources.length === 0,
    contentScan: { bytes: scannedBytes, limit: config.budgets.maxContentScanBytes, exceeded: actualByteExhaustion },
  });
}

async function nativeSearch(config, parsed, options = {}) {
  return runWithResidencyScope(() => nativeSearchScoped(config, parsed, options));
}

module.exports = { nativeSearch };

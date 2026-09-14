"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { loadCatalogue, sourceId } = require("./catalogue");
const { emitPacket } = require("./packet");
const { qmdStatus, runSdkSearch, runSdkSearchCollections } = require("./qmd");
const { classify, readVerified } = require("./scope");

function rootIdentity(root) {
  try {
    const stat = fs.lstatSync(root.path, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() ? `${stat.dev}:${stat.ino}` : null;
  } catch { return null; }
}

function relativePath(root, relative) {
  if (typeof relative !== "string" || relative.length === 0 || path.isAbsolute(relative)) return null;
  if (relative.split(/[\\/]/).some((part) => part === ".." || part === "")) return null;
  const normalized = path.normalize(relative);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) return null;
  const target = path.resolve(root.path, normalized);
  return path.relative(root.path, target) === normalized ? target : null;
}

function stagedFilename(record) {
  return `${crypto.createHash("sha256").update(`${record.sourceId}:${record.indexedHash}`).digest("hex")}.md`;
}

function boundManifest(manifests, rootId, record, candidate) {
  if (record.rootId !== rootId || sourceId(rootId, record.relative) !== record.sourceId
    || typeof record.indexedHash !== "string" || !/^[a-f0-9]{64}$/i.test(record.indexedHash)) return null;
  const filename = stagedFilename(record);
  if (candidate && (candidate.collection !== rootId || candidate.filename !== filename)) return null;
  const manifest = manifests[rootId];
  const entry = manifest && !Array.isArray(manifest) && manifest[filename];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)
    || entry.sourceId !== record.sourceId || entry.hash !== record.indexedHash
    || entry.sourceHash !== record.indexedHash || entry.extractionKey !== null
    || (entry.relative !== undefined && entry.relative !== record.relative)) return null;
  return entry;
}

function parseIndexedCandidates(output) {
  let rows;
  try { rows = JSON.parse(output); } catch { return { ok: false, status: "malformedQmdJson", candidates: [] }; }
  if (!Array.isArray(rows)) return { ok: false, status: "malformedQmdJson", candidates: [] };
  const candidates = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.file !== "string"
      || !Number.isFinite(Number(row.score))) return { ok: false, status: "malformedQmdRow", candidates: [] };
    const match = /^qmd:\/\/([a-zA-Z0-9_-]+)\/([^/?#]+\.md)(?:\?.*)?$/.exec(row.file);
    if (!match) return { ok: false, status: "malformedQmdRow", candidates: [] };
    candidates.push({ collection: match[1], filename: match[2], score: Number(row.score) });
  }
  return { ok: true, candidates };
}

function qualifiers(catalogue, packet, unavailable = []) {
  return {
    ok: true, status: "indexedSubset", coverage: "indexedSubset", negativeIsComplete: false,
    fullScanRequiredForCompleteNegative: true, semanticPending: true, semanticCoverage: "unknownQualified",
    indexWatermark: catalogue.reconciledAt, indexedRevision: catalogue.indexedRevision || null,
    taskClass: "cheap_routing", complianceLane: "unattended_local",
    sourceUnavailable: [...unavailable, ...packet.omitted], ...packet,
  };
}

function fallback(catalogue, reason, unavailable = []) {
  return {
    ok: true, status: "fallbackRequired", coverage: "indexedSubset", negativeIsComplete: false,
    fullScanRequiredForCompleteNegative: true, semanticPending: true, semanticCoverage: "unknownQualified",
    indexWatermark: catalogue.reconciledAt || null, indexedRevision: catalogue.indexedRevision || null,
    sourceUnavailable: [...unavailable, { status: "sourceUnavailable", reason }], results: [], omitted: [],
    bytes: 0, tokenEstimate: 0, tokenEstimateMethod: "characters_divided_by_four_estimate_only",
    deadlineExpired: reason === "deadlineExpired", aborted: reason === "aborted",
    taskClass: "cheap_routing", complianceLane: "unattended_local",
  };
}

function currentCandidate(root, record) {
  const target = relativePath(root, record.relative);
  if (!target || sourceId(root.id, record.relative) !== record.sourceId) return { ok: false, status: "sourceUnavailable", reason: "invalidIndexedPath" };
  try { fs.lstatSync(target); } catch (error) {
    if (error.code === "ENOENT") return { ok: false, status: "sourceUnavailable", reason: "removed" };
  }
  const classified = classify(root, target);
  if (!classified.ok || !classified.textEligible || !record.contentEligible || record.documentEligible) {
    return { ok: false, status: "sourceUnavailable", reason: record.documentEligible ? "indexedDocumentUnsupported" : (classified.reason || "contentNotEnabled") };
  }
  const current = readVerified(root, target);
  if (!current.ok) return current;
  if (record.observedIdentity && record.observedIdentity !== `${current.stat.dev}:${current.stat.ino}`) return { ok: false, status: "sourceUnavailable", reason: "indexedIdentityMismatch" };
  if (!record.indexedHash || record.indexedHash !== current.hash) return { ok: false, status: "sourceUnavailable", reason: "indexedHashMismatch" };
  return { ok: true, current, target };
}

async function indexedSearch(config, parsed, options = {}) {
  const catalogue = loadCatalogue(config);
  if (catalogue.degraded || !catalogue.reconciledAt || !Array.isArray(catalogue.records)) return fallback(catalogue, catalogue.degraded || "indexedCatalogueUnavailable");
  if (!catalogue.records.every((record) => record && typeof record === "object" && !Array.isArray(record)
    && typeof record.relative === "string")) return fallback(catalogue, "indexedCatalogueUnavailable");
  if (options.signal?.aborted) return fallback(catalogue, "aborted");
  const roots = parsed.roots;
  const savedRootIdentities = new Map(roots.map((root) => [root.id, rootIdentity(root)]));
  const rootsIntact = () => roots.every((root) => savedRootIdentities.get(root.id) !== null
    && rootIdentity(root) === savedRootIdentities.get(root.id));
  for (const root of roots) if (!catalogue.roots || !catalogue.roots[root.id]
    || catalogue.roots[root.id].identity !== savedRootIdentities.get(root.id)) return fallback(catalogue, "indexedRootReplaced");
  const allowed = new Set(roots.map((root) => root.id));
  const records = catalogue.records.filter((record) => allowed.has(record.rootId));
  const bySourceId = new Map(records.map((record) => [record.sourceId, record]));
  const manifests = options.manifests || {};
  const deadline = Date.now() + config.budgets.queryDeadlineMs;
  let selected;
  if (parsed.mode === "indexed-filename") {
    const needle = parsed.query.toLowerCase();
    selected = records.filter((record) => record.relative.toLowerCase().includes(needle)).map((record) => ({ record, score: 1000 - record.relative.toLowerCase().indexOf(needle) }));
  } else {
    const status = (options.qmdStatus || qmdStatus)(config);
    if (!status.available || Date.now() >= deadline) return fallback(catalogue, !status.available ? status.status : "deadlineExpired");
    if (options.signal?.aborted) return fallback(catalogue, "aborted");
    if (!rootsIntact()) return fallback(catalogue, "indexedRootReplaced");
    const recordedRootIds = new Set(records.map((record) => record.rootId));
    const collections = roots.filter((root) => recordedRootIds.has(root.id)).map((root) => root.id);
    const response = await runSdkSearchCollections(config, { operation: "lexical", collections, query: parsed.query, limit: 8 }, {
      deadline, signal: options.signal, invoke: options.runSdkSearch || options.runQmd || runSdkSearch,
    });
    if (options.signal?.aborted) return fallback(catalogue, "aborted");
    if (!rootsIntact()) return fallback(catalogue, "indexedRootReplaced");
    if (Date.now() >= deadline) return fallback(catalogue, "deadlineExpired");
    if (!response.ok) return fallback(catalogue, response.status || "indexedSearchFailed");
    const parsedCandidates = parseIndexedCandidates(response.stdout);
    if (!parsedCandidates.ok) return fallback(catalogue, parsedCandidates.status);
    const requested = new Set(collections);
    if (parsedCandidates.candidates.some((candidate) => !requested.has(candidate.collection))) return fallback(catalogue, "indexedCollectionMismatch");
    const candidates = parsedCandidates.candidates;
    const seen = new Set();
    selected = candidates.map((candidate) => {
      const entry = manifests[candidate.collection] && manifests[candidate.collection][candidate.filename];
      const candidateSourceId = typeof entry === "string" ? entry : entry && entry.sourceId;
      return { record: bySourceId.get(candidateSourceId), score: candidate.score, candidate };
    }).filter((item) => {
      const key = item.record ? item.record.sourceId : `${item.candidate.collection}/${item.candidate.filename}`;
      return !seen.has(key) && seen.add(key);
    });
  }
  const ranked = [];
  const unavailable = [];
  for (const item of selected) {
    if (Date.now() >= deadline || options.signal?.aborted) return fallback(catalogue, options.signal?.aborted ? "aborted" : "deadlineExpired", unavailable);
    if (!rootsIntact()) return fallback(catalogue, "indexedRootReplaced", unavailable);
    const record = item.record;
    if (!record) { unavailable.push({ status: "sourceUnavailable", reason: "indexedSourceMissing" }); continue; }
    const root = roots.find((entry) => entry.id === record.rootId);
    const manifestEntry = root && boundManifest(manifests, root.id, record, item.candidate);
    if (!root || !manifestEntry || manifestEntry.revision !== catalogue.indexedRevision) {
      unavailable.push({ sourceId: record.sourceId, status: "sourceUnavailable", reason: "indexedManifestBindingInvalid" }); continue;
    }
    const verified = currentCandidate(root, record);
    if (!verified.ok) { unavailable.push({ sourceId: record.sourceId, status: verified.status, reason: verified.reason }); continue; }
    if (!rootsIntact()) return fallback(catalogue, "indexedRootReplaced", unavailable);
    ranked.push({ ...record, path: verified.target, evidenceHash: verified.current.hash, evidenceStat: verified.current.stat, score: item.score, mode: parsed.mode === "indexed-filename" ? "filename" : "keyword", includeContent: parsed.mode === "indexed-keyword", exactRequired: false });
  }
  const boundaryFailure = {};
  let packet;
  try {
    packet = await emitPacket(config, ranked.sort((a, b) => b.score - a.score), parsed.query, {
      ...parsed, deadline, signal: options.signal,
      beforeEmit(candidate) {
        if (options.signal?.aborted) throw Object.assign(boundaryFailure, { reason: "aborted" });
        if (Date.now() >= deadline) throw Object.assign(boundaryFailure, { reason: "deadlineExpired" });
        if (!rootsIntact()) throw Object.assign(boundaryFailure, { reason: "indexedRootReplaced" });
        if (options.beforeEmit) options.beforeEmit(candidate);
        if (options.signal?.aborted) throw Object.assign(boundaryFailure, { reason: "aborted" });
        if (Date.now() >= deadline) throw Object.assign(boundaryFailure, { reason: "deadlineExpired" });
        if (!rootsIntact()) throw Object.assign(boundaryFailure, { reason: "indexedRootReplaced" });
      },
    });
  } catch (error) {
    if (error === boundaryFailure) return fallback(catalogue, error.reason, unavailable);
    throw error;
  }
  if (options.signal?.aborted) return fallback(catalogue, "aborted", unavailable);
  if (Date.now() >= deadline || packet.deadlineExpired) return fallback(catalogue, "deadlineExpired", unavailable);
  if (!rootsIntact()) return fallback(catalogue, "indexedRootReplaced", unavailable);
  return qualifiers(catalogue, packet, unavailable);
}

module.exports = { indexedSearch };

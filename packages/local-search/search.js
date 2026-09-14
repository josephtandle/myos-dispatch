"use strict";

const path = require("node:path");
const { reconcile } = require("./catalogue");
const { indexedSearch } = require("./indexed-search");
const { hydrateRecords, hydratedContent, isDocument } = require("./hydration");
const { emitPacket } = require("./packet");
const { analyzeQuery, termOffsets } = require("./query");
const { parseCandidates, qmdStatus, runSdkSearch, runSdkSearchCollections, validatedSemanticPassage } = require("./qmd");
const { readVerified, selectRoots, verifyMetadata } = require("./scope");

const MODES = new Set(["filename", "keyword", "semantic", "auto", "indexed-keyword", "indexed-filename"]);

function invalid(message) { throw Object.assign(new Error(message), { code: "INVALID_REQUEST" }); }

function currentContent(root, record, reads) {
  const current = hydratedContent(record, reads.get(record.path));
  if (current) return current;
  if (isDocument(record)) return { ok: false, status: "sourceUnavailable", reason: "documentNotHydrated", path: record.path };
  const read = readVerified(root, record.path);
  reads.set(record.path, read);
  return read;
}

function validateRequest(config, request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) invalid("request must be an object");
  if (typeof request.query !== "string" || request.query.trim().length === 0 || request.query.length > 1000) invalid("query must be a non-empty string of at most 1000 characters");
  const mode = request.mode || "auto";
  if (!MODES.has(mode)) invalid("unsupported search mode");
  for (const [name, ceiling] of [["maxResults", 8], ["maxBytes", config.budgets.maxBytes]]) {
    if (request[name] !== undefined && (!Number.isSafeInteger(request[name]) || request[name] <= 0 || request[name] > ceiling)) invalid(`${name} is out of bounds`);
  }
  if (request.maxTokens !== undefined && (!Number.isSafeInteger(request.maxTokens) || request.maxTokens <= 0)) invalid("maxTokens is out of bounds");
  return { query: request.query.trim(), mode, roots: selectRoots(config, request.roots), maxResults: request.maxResults, maxBytes: request.maxBytes, maxTokens: request.maxTokens };
}

function lexical(config, records, query, mode, deadline, reads, scan) {
  const ranked = [];
  const unavailable = [];
  const needle = query.toLowerCase();
  for (const record of records) {
    if (Date.now() > deadline) return { ranked, unavailable, complete: false };
    if (mode === "filename") {
      const position = record.relative.toLowerCase().indexOf(needle);
      if (position >= 0) {
        const root = config.roots.find((item) => item.id === record.rootId);
        let current;
        if (record.contentEligible) {
          current = reads.get(record.path);
          if (!current) {
            if (scan.bytes + record.size > scan.limit) { scan.exceeded = true; return { ranked, unavailable, complete: false }; }
            current = currentContent(root, record, reads); scan.bytes += record.size;
          }
        } else current = verifyMetadata(root, record.path);
        if (!current.ok) { unavailable.push({ sourceId: record.sourceId, status: current.status, reason: current.reason }); continue; }
        ranked.push({ ...record, evidenceHash: current.hash || null, evidenceStat: current.stat, score: 1000 - position, mode: "filename", includeContent: false });
      }
      continue;
    }
    if (!record.contentEligible) continue;
    const root = config.roots.find((item) => item.id === record.rootId);
    let current = hydratedContent(record, reads.get(record.path));
    if (!current) {
      if (scan.bytes + record.size > scan.limit) { scan.exceeded = true; return { ranked, unavailable, complete: false }; }
      current = currentContent(root, record, reads); scan.bytes += record.size;
    }
    if (!current.ok) { unavailable.push({ sourceId: record.sourceId, status: current.status, reason: current.reason }); continue; }
    const lower = current.text.toLowerCase();
    const position = lower.indexOf(needle);
    if (position >= 0) {
      const occurrences = lower.split(needle).length - 1;
      ranked.push({ ...record, observedHash: current.hash, evidenceHash: current.hash, evidenceStat: current.stat, evidenceExtractionKey: current.extractionKey || null, score: occurrences * 1000 - position, mode: "keyword", includeContent: true });
    }
  }
  return { ranked, unavailable, complete: true };
}

function exactLocal(config, records, analysis, deadline, reads, scan) {
  const ranked = [];
  const unavailable = [];
  const covered = new Set();
  for (const record of records) {
    if (Date.now() > deadline) return { ranked, unavailable, covered, complete: false };
    const pathMatches = analysis.strongTerms.filter((term) => term.kind === "filename"
      && termOffsets(record.relative, term).length > 0);
    if (pathMatches.length > 0) {
      const root = config.roots.find((item) => item.id === record.rootId);
      let current = reads.get(record.path);
      if (!current && record.contentEligible) {
        if (scan.bytes + record.size > scan.limit) { scan.exceeded = true; return { ranked, unavailable, covered, complete: false }; }
        current = currentContent(root, record, reads); scan.bytes += record.size;
      }
      if (!current) current = verifyMetadata(root, record.path);
      if (!current.ok) unavailable.push({ sourceId: record.sourceId, status: current.status, reason: current.reason });
      else {
        pathMatches.forEach((term) => covered.add(term));
        ranked.push({ ...record, evidenceHash: current.hash || null, evidenceStat: current.stat, score: 2_000_000, mode: "filename", includeContent: false, matchTerms: pathMatches });
      }
      continue;
    }
    if (!record.contentEligible) continue;
    const root = config.roots.find((item) => item.id === record.rootId);
    let current = hydratedContent(record, reads.get(record.path));
    if (!current) {
      if (scan.bytes + record.size > scan.limit) { scan.exceeded = true; return { ranked, unavailable, covered, complete: false }; }
      current = currentContent(root, record, reads); scan.bytes += record.size;
    }
    if (!current.ok) { unavailable.push({ sourceId: record.sourceId, status: current.status, reason: current.reason }); continue; }
    const matches = analysis.strongTerms.filter((term) => term.kind !== "filename" && termOffsets(current.text, term).length > 0);
    if (matches.length === 0) continue;
    matches.forEach((term) => covered.add(term));
    const first = Math.min(...matches.flatMap((term) => termOffsets(current.text, term)));
    ranked.push({ ...record, observedHash: current.hash, evidenceHash: current.hash, evidenceStat: current.stat, evidenceExtractionKey: current.extractionKey || null, score: 1_000_000 + matches.length * 1000 - first, mode: "keyword", exactRequired: true, includeContent: true, matchTerms: matches });
  }
  return { ranked: ranked.sort((a, b) => b.score - a.score), unavailable, covered, complete: true };
}

async function sdkRank(config, records, query, manifests, deadline, operation, reads, scan, adapters = {}) {
  const status = (adapters.qmdStatus || qmdStatus)(config);
  if (!status.available || (operation === "semantic" && !status.semanticAvailable)) return { ranked: [], status: status.status };
  const rootIds = [...new Set(records.map((item) => item.rootId))];
  const ranked = [];
  let stale = 0;
  if (rootIds.length === 0) return { ranked, status: "available" };
  const invoke = adapters.runSdkSearch || adapters.runQmd || runSdkSearch;
  const response = await runSdkSearchCollections(config, { operation, collections: rootIds, query, limit: 8 }, {
    deadline, signal: adapters.signal, invoke,
  });
  if (adapters.signal?.aborted) return { ranked: [], status: "aborted" };
  if (Date.now() >= deadline) return { ranked: [], status: "deadlineExpired" };
  if (!response.ok) return { ranked: [], status: response.status };
  const parsed = parseCandidates(response.stdout, manifests, rootIds);
  if (!parsed.ok) return { ranked: [], status: parsed.status };
  for (const candidate of parsed.candidates) {
      const record = records.find((item) => item.sourceId === candidate.sourceId);
      if (!record || record.rootId !== candidate.collection || !record.contentEligible) continue;
      const rootId = candidate.collection;
      const root = config.roots.find((item) => item.id === record.rootId);
      let current = hydratedContent(record, reads.get(record.path));
      if (!current) {
        if (scan.bytes + record.size > scan.limit) { scan.exceeded = true; return { ranked, status: "contentScanExceeded" }; }
        current = currentContent(root, record, reads); scan.bytes += record.size;
      }
      if (!current.ok) continue;
      if (candidate.indexedHash && candidate.indexedHash !== record.indexedHash) { stale += 1; continue; }
      if (record.indexedHash !== current.hash) {
        stale += 1;
        continue;
      }
      const manifest = Object.values(manifests[rootId] || {}).find((entry) => entry && typeof entry === "object" && entry.sourceId === candidate.sourceId);
      if (isDocument(record) && (!manifest || manifest.extractionKey !== current.extractionKey
        || !record.indexedExtractionKey || record.indexedExtractionKey !== current.extractionKey)) { stale += 1; continue; }
      const semantic = operation === "semantic" ? validatedSemanticPassage(candidate.semantic, current.text) : null;
      ranked.push({
        ...record, evidenceHash: current.hash, evidenceStat: current.stat,
        evidenceExtractionKey: current.extractionKey || null, score: candidate.score,
        mode: operation === "lexical" ? "keyword" : "semantic", exactRequired: operation !== "lexical",
        includeContent: true, ...(semantic ? { semantic } : {}),
      });
  }
  return { ranked: ranked.sort((a, b) => b.score - a.score), status: stale > 0 ? "staleReevaluatedSemanticPending" : "available" };
}

function mergeRanks(first, second) {
  const merged = new Map();
  for (const list of [first, second]) list.forEach((item, index) => {
    const score = 1 / (60 + index + 1);
    const existing = merged.get(item.sourceId);
    merged.set(item.sourceId, existing ? {
      ...existing, score: existing.score + score, mode: "auto",
      ...(existing.semantic || !item.semantic ? {} : { semantic: item.semantic }),
    } : { ...item, score });
  });
  return [...merged.values()].sort((a, b) => b.score - a.score);
}

async function search(config, request, options = {}) {
  if (!config.enabled) return { ok: false, status: "disabled", taskClass: "cheap_routing", complianceLane: "unattended_local", results: [] };
  const parsed = validateRequest(config, request);
  if (parsed.mode === "indexed-keyword" || parsed.mode === "indexed-filename") return indexedSearch(config, parsed, options);
  const deadline = Date.now() + config.budgets.queryDeadlineMs;
  const freshness = reconcile(config, { roots: parsed.roots, deadline, publish: false, maxContentScanBytes: config.budgets.maxContentScanBytes });
  const allowedIds = new Set(parsed.roots.map((root) => root.id));
  const records = freshness.catalogue.records.filter((item) => allowedIds.has(item.rootId));
  const reads = freshness.currentReads || new Map();
  const hydration = parsed.mode === "filename"
    ? { complete: true, unavailable: [] }
    : await hydrateRecords(config, records, reads, { roots: parsed.roots, deadline, signal: options.signal, extractDocument: options.extractDocument });
  const scan = { bytes: freshness.contentBytes || 0, limit: config.budgets.maxContentScanBytes, exceeded: freshness.budgetExceeded === true };
  const analysis = analyzeQuery(parsed.query);
  const exact = parsed.mode === "auto" ? exactLocal(config, records, analysis, deadline, reads, scan)
    : { ranked: [], unavailable: [], covered: new Set(), complete: true };
  const exactFastPath = parsed.mode === "auto" && analysis.strongTerms.length > 0
    && analysis.strongTerms.every((term) => exact.covered.has(term));
  const live = lexical(config, records, parsed.query, parsed.mode === "filename" ? "filename" : "keyword", deadline, reads, scan);
  live.ranked.sort((a, b) => b.score - a.score);
  const manifests = options.manifests || {};
  const lexicalResult = exactFastPath ? { ranked: [], status: "localExactVerified" }
    : parsed.mode === "keyword" || parsed.mode === "auto"
    ? await sdkRank(config, records, parsed.query, manifests, deadline, "lexical", reads, scan, options)
    : { ranked: [], status: "notRequested" };
  const semanticResult = exactFastPath ? { ranked: [], status: "skippedForVerifiedExactSignal" }
    : (parsed.mode === "semantic" || parsed.mode === "auto")
    ? await sdkRank(config, records, parsed.query, manifests, deadline, "semantic", reads, scan, options)
    : { ranked: [], status: "notRequested" };
  const indexed = parsed.mode === "auto" ? mergeRanks(lexicalResult.ranked, semanticResult.ranked)
    : parsed.mode === "semantic" ? semanticResult.ranked : lexicalResult.ranked;
  const ranked = exactFastPath ? exact.ranked
    : parsed.mode === "filename" ? live.ranked.sort((a, b) => b.score - a.score) : mergeRanks(indexed, live.ranked);
  const packet = await emitPacket(config, ranked, parsed.query, { ...parsed, queryAnalysis: analysis, deadline, beforeEmit: options.beforeEmit, extractDocument: options.extractDocument, signal: options.signal });
  const partial = !freshness.complete || !hydration.complete || !live.complete || !exact.complete || scan.exceeded || packet.deadlineExpired || Date.now() > deadline;
  const semanticRequested = parsed.mode === "semantic" || parsed.mode === "auto";
  const semanticCoverageComplete = semanticResult.status === "available" && records
    .filter((record) => record.contentEligible)
    .every((record) => record.observedHash && record.observedHash === record.indexedHash
      && (!isDocument(record) || record.observedExtractionKey && record.observedExtractionKey === record.indexedExtractionKey));
  const unavailable = [...freshness.unavailable, ...hydration.unavailable, ...live.unavailable, ...exact.unavailable, ...packet.omitted];
  return {
    ok: true, status: partial ? "partial" : "completeAsOfSnapshot", taskClass: "cheap_routing", complianceLane: "unattended_local",
    semanticStatus: semanticResult.status, semanticPending: semanticRequested && !semanticCoverageComplete,
    lexicalStatus: lexicalResult.status,
    routeReason: exactFastPath ? "verifiedExactSignalFastPath" : "requestedModePipeline",
    contentScan: { bytes: scan.bytes, limit: scan.limit, exceeded: scan.exceeded },
    negativeIsComplete: semanticRequested || (parsed.mode === "keyword" && lexicalResult.status !== "available")
      ? false : !partial && unavailable.length === 0,
    sourceUnavailable: unavailable,
    reconciledAt: freshness.catalogue.reconciledAt, ...packet,
  };
}

module.exports = { search, validateRequest };

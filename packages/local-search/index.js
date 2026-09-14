"use strict";

const crypto = require("node:crypto");
const { loadConfig, normalizeConfig, writeConfig } = require("./config");
const { ensureState, loadCatalogue, publish, reconcile } = require("./catalogue");
const { acquire, watch: startWatch } = require("./maintenance");
const { qmdStatus, runMaintenanceWorker } = require("./qmd");
const { hydrateRecord, hydrateRecords, isDocument, sameSourceIdentity, sourceLocators } = require("./hydration");
const { readVerified, selectRoots } = require("./scope");
const { search: runSearch } = require("./search");
const { embedQmd, loadManifests, stage, updateQmd } = require("./staging");
const { truncateUtf8 } = require("./text");
const { loadResourceStatus, storageAdmission } = require("./resources");

function resolveConfig(value) {
  if (typeof value === "string") return loadConfig(value);
  if (value && typeof value.configPath === "string" && !value.stateDirectory) return loadConfig(value.configPath);
  return normalizeConfig(value);
}

async function configure(input) {
  if (input && typeof input.configPath === "string") return writeConfig(input.configPath, input.config);
  return normalizeConfig(input);
}

async function status(configInput) {
  const config = resolveConfig(configInput);
  if (!config.enabled) return { enabled: false, status: "disabled", taskClass: "cheap_routing", complianceLane: "unattended_local" };
  const catalogue = loadCatalogue(config);
  const roots = catalogue.roots || {};
  const complete = config.roots.every((root) => roots[root.id] && roots[root.id].complete);
  return {
    enabled: true,
    status: catalogue.degraded ? "degraded" : catalogue.reconciledAt ? (complete ? "passive" : "partial") : "notStarted",
    taskClass: "cheap_routing",
    complianceLane: "unattended_local",
    qmd: qmdStatus(config),
    semanticPending: catalogue.semanticPending === true,
    degraded: catalogue.degraded || null,
    recordCount: catalogue.records.length,
    reconciledAt: catalogue.reconciledAt,
    complete,
    resources: loadResourceStatus(config),
  };
}

function contentRevision(catalogue) {
  const rows = catalogue.records.filter((record) => record.contentEligible && record.observedHash)
    .map((record) => `${record.sourceId}:${record.observedExtractionKey || record.observedHash}`).sort();
  return crypto.createHash("sha256").update(rows.join("\n")).digest("hex");
}

async function performIndex(config, adapters = {}, lockHeld = false) {
  if (!config.enabled) return { ok: false, status: "disabled", taskClass: "default_automation", complianceLane: "unattended_local" };
  ensureState(config);
  const storage = storageAdmission(config, 0);
  if (!storage.ok) return { ok: false, status: storage.status, storage, complete: false, taskClass: "default_automation", complianceLane: "unattended_local" };
  const lock = lockHeld ? null : acquire(config);
  try {
    const deadline = Date.now() + config.budgets.indexDeadlineMs;
    const freshness = reconcile(config, { publish: false, deadline });
    const hydration = await hydrateRecords(config, freshness.catalogue.records, freshness.currentReads, {
      roots: config.roots, deadline, signal: adapters.signal, extractDocument: adapters.extractDocument,
    });
    freshness.unavailable.push(...hydration.unavailable);
    const revision = contentRevision(freshness.catalogue);
    if (!freshness.complete) {
      freshness.catalogue.semanticPending = true;
      freshness.catalogue.degraded = "partialDiscovery";
      publish(config, freshness.catalogue);
      return { ok: false, status: "partialDiscovery", catalogue: freshness.catalogue, complete: false, taskClass: "default_automation", complianceLane: "unattended_local" };
    }
    if (freshness.catalogue.indexedRevision === revision && !freshness.catalogue.semanticPending) {
      delete freshness.catalogue.degraded;
      publish(config, freshness.catalogue);
      return { ok: true, status: "unchanged", catalogue: freshness.catalogue, complete: true, taskClass: "default_automation", complianceLane: "unattended_local" };
    }
    const qmd = (adapters.qmdStatus || qmdStatus)(config, { writeProof: true });
    if (!qmd.available) {
      freshness.catalogue.semanticPending = true;
      freshness.catalogue.degraded = qmd.status;
      publish(config, freshness.catalogue);
      return { ok: true, status: "lexicalOnly", qmdStatus: qmd.status, staged: 0, skipped: hydration.unavailable, catalogue: freshness.catalogue, complete: freshness.complete && hydration.complete, taskClass: "default_automation", complianceLane: "unattended_local" };
    }
    freshness.catalogue.semanticPending = true;
    publish(config, freshness.catalogue);
    const staged = stage(config, freshness.catalogue, revision, freshness.currentReads);
    staged.catalogue = freshness.catalogue;
    if (!staged.ok) {
      freshness.catalogue.semanticPending = true;
      freshness.catalogue.degraded = staged.status;
      publish(config, freshness.catalogue);
      return { ...staged, catalogue: freshness.catalogue, taskClass: "default_automation", complianceLane: "unattended_local", complete: freshness.complete };
    }
    const updated = await updateQmd(config, staged, adapters);
    let embedding = [];
    if (updated.ok && qmd.semanticAvailable) embedding = await embedQmd(config, config.roots.map((root) => root.id), adapters);
    if (adapters.finish) {
      try {
        await adapters.finish();
      } catch (error) {
        freshness.catalogue.semanticPending = true;
        freshness.catalogue.degraded = "cleanupFailed";
        publish(config, freshness.catalogue);
        return { ok: false, status: "cleanupFailed", error: error.message, embedding, catalogue: freshness.catalogue, semanticPending: true, complete: false, taskClass: "default_automation", complianceLane: "unattended_local" };
      }
    }
    const memoryFallback = embedding.find((result) => result && (result.status === "memoryHeadroom" || result.status === "memoryProbeUnavailable"));
    if (updated.ok && qmd.semanticAvailable && memoryFallback) {
      freshness.catalogue.semanticPending = true;
      freshness.catalogue.degraded = memoryFallback.status;
      publish(config, freshness.catalogue);
      return { ...updated, ok: true, status: "lexicalOnly", qmdStatus: memoryFallback.status, embedding, skipped: staged.skipped, catalogue: freshness.catalogue, semanticPending: true, complete: freshness.complete, taskClass: "default_automation", complianceLane: "unattended_local" };
    }
    if (updated.ok && qmd.semanticAvailable && embedding.every((result) => result.ok)) {
      let stable = true;
      for (const item of staged.staged) {
        const current = isDocument(item.record)
          ? await hydrateRecord(config, item.root, item.record, { force: true, deadline, signal: adapters.signal, extractDocument: adapters.extractDocument })
          : readVerified(item.root, item.record.path);
        if (!current.ok || current.hash !== item.current.hash || !sameSourceIdentity(item.current, current)
          || isDocument(item.record) && current.extractionKey !== item.current.extractionKey) { stable = false; break; }
      }
      if (!stable) {
        freshness.catalogue.semanticPending = true;
        freshness.catalogue.degraded = "sourceChangedDuringIndex";
        publish(config, freshness.catalogue);
        return { ok: false, status: "sourceChangedDuringIndex", embedding, catalogue: freshness.catalogue, complete: false, taskClass: "default_automation", complianceLane: "unattended_local" };
      }
      for (const item of staged.staged) {
        item.record.indexedHash = item.current.hash;
        item.record.indexedExtractionKey = item.current.extractionKey || null;
      }
      freshness.catalogue.indexedRevision = revision;
      freshness.catalogue.semanticPending = !hydration.complete || staged.skipped.length > 0;
      if (freshness.catalogue.semanticPending) freshness.catalogue.degraded = "partialExtraction";
      else delete freshness.catalogue.degraded;
    } else {
      freshness.catalogue.semanticPending = true;
      freshness.catalogue.degraded = updated.ok ? (qmd.semanticAvailable ? "embeddingFailed" : "embeddingModelMissing") : updated.status;
    }
    publish(config, freshness.catalogue);
    const successful = updated.ok && (!qmd.semanticAvailable || embedding.every((result) => result.ok));
    const complete = freshness.complete && hydration.complete && staged.skipped.length === 0;
    return { ...updated, ok: successful, status: successful ? (complete ? updated.status : freshness.catalogue.degraded) : freshness.catalogue.degraded, embedding, skipped: staged.skipped, catalogue: freshness.catalogue, semanticPending: freshness.catalogue.semanticPending, complete, taskClass: "default_automation", complianceLane: "unattended_local" };
  } finally {
    if (lock) lock.release();
  }
}

async function index(configInput, options = {}) {
  const config = resolveConfig(configInput);
  if (options.signal?.aborted) return { ok: false, status: "aborted" };
  if (options.testOnlyInProcess === true || options.adapters) return performIndex(config, options.adapters || {}, false);
  return runMaintenanceWorker(config, { signal: options.signal });
}

async function search(configInput, request, options) {
  const config = resolveConfig(configInput);
  return runSearch(config, request, { manifests: loadManifests(config), ...options });
}

async function read(configInput, request, options = {}) {
  const config = resolveConfig(configInput);
  if (!config.enabled) return { ok: false, status: "disabled", taskClass: "cheap_routing", complianceLane: "unattended_local" };
  if (!request || typeof request.sourceId !== "string") throw Object.assign(new Error("sourceId is required"), { code: "INVALID_REQUEST" });
  const maxBytes = request.maxBytes === undefined ? config.budgets.maxBytes : request.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > config.budgets.maxBytes) throw Object.assign(new Error("maxBytes is out of bounds"), { code: "INVALID_REQUEST" });
  const maxTokens = request.maxTokens === undefined ? config.budgets.maxTokens : request.maxTokens;
  if (maxTokens !== null && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) throw Object.assign(new Error("maxTokens is out of bounds"), { code: "INVALID_REQUEST" });
  const deadline = Date.now() + config.budgets.queryDeadlineMs;
  const roots = selectRoots(config, request.roots);
  const freshness = reconcile(config, { roots, publish: false, deadline, maxContentScanBytes: config.budgets.maxContentScanBytes });
  const record = freshness.catalogue.records.find((item) => item.sourceId === request.sourceId && roots.some((root) => root.id === item.rootId));
  if (!record) {
    const negativeIsComplete = freshness.complete && freshness.unavailable.length === 0;
    return { ok: false, status: negativeIsComplete ? "notFound" : "partialUnknown", negativeIsComplete };
  }
  const root = roots.find((item) => item.id === record.rootId);
  let result = isDocument(record)
    ? await hydrateRecord(config, root, record, { currentReads: freshness.currentReads, deadline, signal: options.signal, extractDocument: options.extractDocument })
    : readVerified(root, record.path);
  if (result.ok && isDocument(record)) {
    const rankedSnapshot = result;
    result = await hydrateRecord(config, root, record, { force: true, deadline, signal: options.signal, extractDocument: options.extractDocument });
    if (result.ok && (!sameSourceIdentity(rankedSnapshot, result) || rankedSnapshot.extractionKey !== result.extractionKey)) {
      return { ok: false, status: "sourceUnavailable", reason: "changedBeforeEmission", path: record.path };
    }
  }
  if (!result.ok) return result;
  const characterLimited = result.text.slice(0, maxTokens === null ? undefined : maxTokens * 4);
  const text = truncateUtf8(characterLimited, maxBytes);
  return {
    ok: true,
    status: result.document && !result.complete ? "partialAsOfSnapshot" : "completeAsOfSnapshot",
    taskClass: "cheap_routing", complianceLane: "unattended_local", sourceId: record.sourceId, rootId: record.rootId,
    relative: record.relative, text, bytes: Buffer.byteLength(text), hash: result.hash, sourceReadAt: result.sourceReadAt,
    ...(!result.document ? { lineLocator: { firstLine: 1 } } : {}), tokenEstimate: Math.ceil(text.length / 4), tokenEstimateMethod: "characters_divided_by_four_estimate_only",
    truncated: text.length < result.text.length,
    ...(result.document ? {
      extractedTextLocator: { line: 1, byteOffset: 0 },
      sourceLocators: sourceLocators(result, 0, text.length),
      extractionKey: result.extractionKey,
      coverage: result.coverage,
      complete: result.complete,
      negativeIsComplete: result.complete,
    } : {}),
    snapshotBoundary: "verified through read completion only; the file may change afterward",
  };
}

async function watch(configInput, options) {
  return startWatch(resolveConfig(configInput), options);
}

module.exports = { configure, index, read, search, status, watch, _performIndex: performIndex, _internals: { loadCatalogue, reconcile, resolveConfig } };

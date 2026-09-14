"use strict";

const crypto = require("node:crypto");
const { DEFAULT_LIMITS, extractDocument: defaultExtractDocument } = require("./documents");
const { hasSecretContent, readVerified, readVerifiedBytes } = require("./scope");

const MAX_DOCUMENTS_PER_OPERATION = 32;

function unavailable(record, reason) {
  return { ok: false, status: "sourceUnavailable", reason, path: record.path };
}

function sameStat(first, second) {
  return first && second && first.dev === second.dev && first.ino === second.ino
    && first.size === second.size && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs;
}

function sameSourceIdentity(first, second) { return sameStat(first && first.stat, second && second.stat); }

function extractionKey(sourceHash, parserFingerprint) {
  return crypto.createHash("sha256").update(`${sourceHash}\0${parserFingerprint}`).digest("hex");
}

function isDocument(record) {
  return record.documentEligible === true || record.contentType === "document";
}

function hydratedContent(record, read) {
  if (!read || !read.ok) return read;
  if (!isDocument(record) || (read.document === true && typeof read.text === "string")) return read;
  return unavailable(record, "documentNotHydrated");
}

async function hydrateRecord(config, root, record, options = {}) {
  if (!record.contentEligible) return unavailable(record, "contentNotEnabled");
  if (!isDocument(record)) return readVerified(root, record.path, options.scopeOptions);
  if (!config.parser) return unavailable(record, "documentParserNotConfigured");
  if (options.signal?.aborted) return unavailable(record, "aborted");
  if (options.deadline && Date.now() >= options.deadline) return unavailable(record, "deadlineExpired");

  const prior = options.force !== true && options.currentReads?.get(record.path);
  const source = prior?.ok && prior.buffer ? prior : readVerifiedBytes(root, record.path, options.scopeOptions);
  if (!source.ok) return source;
  try {
    const invoke = options.extractDocument || defaultExtractDocument;
    const remaining = options.deadline ? Math.max(1, options.deadline - Date.now()) : DEFAULT_LIMITS.timeoutMs;
    const parsed = await invoke(source.buffer, {
      ...config.parser,
      timeoutMs: Math.min(config.parser.timeoutMs || DEFAULT_LIMITS.timeoutMs, remaining),
      extension: record.extension,
      signal: options.signal,
      deadline: options.deadline,
    });
    if (parsed.sourceHash !== source.hash) return unavailable(record, "parserSourceHashMismatch");
    const current = readVerifiedBytes(root, record.path, options.finalScopeOptions);
    if (!current.ok) return current;
    if (current.hash !== source.hash || !sameStat(current.stat, source.stat)) return unavailable(record, "changedDuringExtraction");
    if (hasSecretContent(parsed.text)) return unavailable(record, "secretPatternDenied");
    const key = extractionKey(source.hash, parsed.parserFingerprint);
    return {
      ok: true,
      path: record.path,
      relative: record.relative,
      extension: record.extension,
      text: parsed.text,
      bytes: source.bytes,
      hash: source.hash,
      sourceHash: source.hash,
      sourceReadAt: current.sourceReadAt,
      stat: current.stat,
      parserFingerprint: parsed.parserFingerprint,
      extractionKey: key,
      segments: parsed.segments,
      coverage: parsed.coverage,
      complete: parsed.complete === true,
      document: true,
    };
  } catch (error) {
    return unavailable(record, error && error.code ? `documentParser:${error.code}` : "documentParserFailed");
  }
}

async function hydrateRecords(config, records, currentReads, options = {}) {
  const unavailableSources = [];
  let complete = true;
  let documents = 0;
  let extractedBytes = 0;
  const outputLimit = Math.min(config.budgets.maxContentScanBytes, (config.parser?.extractedUtf8Bytes || DEFAULT_LIMITS.extractedUtf8Bytes) * MAX_DOCUMENTS_PER_OPERATION);
  for (const record of records) {
    if (!record.contentEligible || !isDocument(record)) continue;
    if (documents >= MAX_DOCUMENTS_PER_OPERATION || (options.deadline && Date.now() >= options.deadline)) {
      complete = false;
      const skipped = unavailable(record, "documentHydrationBudgetExceeded");
      currentReads.set(record.path, skipped);
      unavailableSources.push({ sourceId: record.sourceId, ...skipped });
      continue;
    }
    documents += 1;
    const hydrated = await hydrateRecord(config, options.roots.find((root) => root.id === record.rootId), record, { ...options, currentReads });
    currentReads.set(record.path, hydrated);
    if (!hydrated.ok) {
      complete = false;
      unavailableSources.push({ sourceId: record.sourceId, ...hydrated });
      continue;
    }
    extractedBytes += Buffer.byteLength(hydrated.text);
    if (extractedBytes > outputLimit) {
      currentReads.set(record.path, unavailable(record, "documentHydrationOutputBudgetExceeded"));
      complete = false;
      unavailableSources.push({ sourceId: record.sourceId, ...unavailable(record, "documentHydrationOutputBudgetExceeded") });
      continue;
    }
    record.observedHash = hydrated.hash;
    record.observedExtractionKey = hydrated.extractionKey;
    if (!hydrated.complete) complete = false;
  }
  return { currentReads, unavailable: unavailableSources, complete, documents, extractedBytes };
}

function sourceLocators(read, start = 0, end = read.text.length) {
  if (!read.document || !Array.isArray(read.segments)) return [];
  return read.segments.filter((segment) => segment.end > start && segment.start < end).map((segment) => segment.locator);
}

module.exports = { MAX_DOCUMENTS_PER_OPERATION, extractionKey, hydrateRecord, hydrateRecords, hydratedContent, isDocument, sameSourceIdentity, sourceLocators };

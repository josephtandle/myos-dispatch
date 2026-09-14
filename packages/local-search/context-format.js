"use strict";

const MIN_BYTES = 512;
const MAX_BYTES = 16384;
const KNOWN_UNAVAILABLE_REASONS = new Set([
  "catalogueCorrupt", "changedBeforeEmission", "deadlineExpired", "documentHydrationBudgetExceeded",
  "documentNotHydrated", "hardlinkDenied", "invalidUtf8", "rootOfflineOrUnreadable",
  "secretPatternDenied", "sizeLimit", "unsupportedBinary", "unknown",
]);
const RESULT_QUALIFIERS = [
  "ok", "status", "negativeIsComplete", "semanticPending", "semanticStatus", "deadlineExpired",
  "complete", "truncated", "contextIncomplete", "coverage", "indexedCoverage", "indexWatermark",
  "indexedRevision", "fullScanRequiredForCompleteNegative", "fallbackRequired", "semanticCoverage",
];
const CITATION_KEYS = [
  "sourceId", "rootId", "relative", "sourceReadAt", "locator", "lineLocator", "mode",
  "complete", "truncated", "contextIncomplete", "coverage", "extractionKey", "extractedTextLocator",
  "sourceLocators", "selectedSourceOnly", "anchorStatus", "indexedCoverage", "indexWatermark",
  "indexedRevision", "fullScanRequiredForCompleteNegative", "fallbackRequired", "semanticCoverage",
];

function escapedJson(value) {
  return JSON.stringify(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`);
}

function line(value) {
  return `${escapedJson(value)}\n`;
}

function candidatesFrom(result) {
  const parents = Array.isArray(result?.results) ? result.results : [];
  const expanded = [];
  for (const parent of parents) {
    if (Array.isArray(parent?.passages)) {
      for (const passage of parent.passages) {
        expanded.push(typeof passage === "string" ? { ...parent, passages: undefined, snippet: passage }
          : { ...parent, passages: undefined, ...passage });
      }
    } else expanded.push(parent);
  }
  if (expanded.length > 0) return expanded;
  if (Array.isArray(result?.passages)) {
    return result.passages.map((passage) => typeof passage === "string"
      ? { ...result, passages: undefined, text: passage }
      : { ...result, passages: undefined, ...passage });
  }
  return typeof result?.text === "string" ? [result] : [];
}

function sourceContent(source) {
  if (typeof source?.snippet === "string") return source.snippet;
  if (typeof source?.text === "string") return source.text;
  if (typeof source?.content === "string") return source.content;
  return null;
}

function longestFittingPrefix(value, fitsWith) {
  const codePoints = [...value];
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fitsWith(codePoints.slice(0, middle).join(""))) low = middle;
    else high = middle - 1;
  }
  return codePoints.slice(0, low).join("");
}

function boundedError(contextBytes) {
  const output = line({ ok: false, status: "budgetInsufficient", contextBytes });
  return Buffer.byteLength(output) <= contextBytes ? output : "{\"ok\":false}\n";
}

function copy(result, keys) {
  const output = {};
  for (const key of keys) if (Object.hasOwn(result, key)) output[key] = result[key];
  return output;
}

function unavailableReasonCounts(items) {
  const counts = new Map();
  for (const item of items) {
    const reason = typeof item?.reason === "string" ? item.reason : (typeof item?.status === "string" ? item.status : "unknown");
    const key = Buffer.byteLength(reason, "utf8") <= 64 && KNOWN_UNAVAILABLE_REASONS.has(reason) ? reason : "other";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function formatContext(result, { contextBytes = 4096, receipt, cancelled = false } = {}) {
  if (!Number.isSafeInteger(contextBytes) || contextBytes < MIN_BYTES || contextBytes > MAX_BYTES || !receipt || typeof receipt.name !== "string" || typeof receipt.resultSha256 !== "string") {
    throw Object.assign(new Error("context formatter options are invalid"), { code: "INVALID_ARGUMENT" });
  }
  const presentation = {
    status: "context", receipt: { name: receipt.name, resultSha256: receipt.resultSha256 },
    caveat: "Bounded context; receipt has the full result. sourceReadAt is not canonical.",
    additionalTruncation: false, emittedResultCount: 0, omittedResultCount: 0,
    ...(cancelled ? { cancelled: true } : {}),
  };
  const projected = result && typeof result === "object"
    ? copy(result, RESULT_QUALIFIERS)
    : { ok: false, status: "invalidResult" };
  const context = { presentation, result: projected };
  const fits = () => Buffer.byteLength(line(context)) <= contextBytes;
  if (!fits()) return boundedError(contextBytes);
  const add = (object, key, value) => {
    object[key] = value;
    if (!fits()) { delete object[key]; return false; }
    return true;
  };
  if (Array.isArray(result?.sourceUnavailable)) {
    if (!add(projected, "sourceUnavailableCount", result.sourceUnavailable.length)) return boundedError(contextBytes);
    if (!add(projected, "sourceUnavailableReasons", unavailableReasonCounts(result.sourceUnavailable))) return boundedError(contextBytes);
  }
  if (result?.contentScan && typeof result.contentScan === "object"
    && !add(projected, "contentScan", copy(result.contentScan, ["bytes", "limit", "exceeded"]))) return boundedError(contextBytes);
  const sourceEligible = result?.ok === true && !cancelled && !new Set(["aborted", "cancelled"]).has(result.status);
  const candidates = sourceEligible ? candidatesFrom(result) : [];
  const apiOmittedCount = Array.isArray(result?.omitted) ? result.omitted.length : 0;
  const sources = [];
  if (candidates.length > 0) projected.sources = sources;
  const setCounts = () => {
    presentation.emittedResultCount = sources.length;
    presentation.omittedResultCount = apiOmittedCount + candidates.length - sources.length;
    projected.resultOmittedCount = presentation.omittedResultCount;
  };
  setCounts();
  if (!fits()) return boundedError(contextBytes);
  let contentClipped = false;
  for (const candidate of candidates) {
    const sourceProjection = { citation: copy(candidate, CITATION_KEYS) };
    sources.push(sourceProjection);
    setCounts();
    if (!fits()) { sources.pop(); setCounts(); contentClipped = true; continue; }
    const content = sourceContent(candidate);
    if (content === null) continue;
    sourceProjection.content = content;
    if (fits()) continue;
    const clipped = longestFittingPrefix(content, (value) => {
      sourceProjection.content = value;
      return fits();
    });
    sourceProjection.content = clipped;
    if (!fits()) {
      delete sourceProjection.content;
      if (!fits()) {
        sources.pop();
        setCounts();
      }
    }
    contentClipped = true;
  }
  if (candidates.length === 0) {
    presentation.omittedResultCount = apiOmittedCount;
    projected.resultOmittedCount = apiOmittedCount;
  }
  presentation.additionalTruncation = contentClipped || sources.length < candidates.length;
  if (!fits()) return boundedError(contextBytes);
  return line(context);
}

module.exports = { MAX_BYTES, MIN_BYTES, formatContext, unavailableReasonCounts };

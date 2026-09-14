"use strict";

const FORMAT = "MYOS_LOCAL_EVIDENCE_V1";
const CAVEAT = "Any evidence content was verified only through its sourceReadAt or snapshot emission boundary; later changes are possible. This is source-backed evidence, not canonical authority.";
const OMITTED_DIAGNOSTICS = new Set([
  "bytes", "complianceLane", "lexicalStatus", "routeReason", "snapshotBoundary",
  "taskClass", "tokenEstimate", "tokenEstimateMethod",
]);

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function jsonFallback(result, status) {
  const fallback = result && typeof result === "object"
    ? { ...result, evidenceFormatStatus: status, evidenceCaveat: CAVEAT }
    : { ok: false, status: "evidenceFormatUnavailable", result, evidenceFormatStatus: status, evidenceCaveat: CAVEAT };
  return `${JSON.stringify(fallback)}\n`;
}

function terminalJsonFallback(result) {
  return jsonFallback(result, "jsonFallbackTTY").replace(/[\u007f-\u009f]/gu, (character) => {
    return `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`;
  });
}

function compactResult(result) {
  const compact = structuredClone(result);
  for (const key of OMITTED_DIAGNOSTICS) delete compact[key];
  return compact;
}

function formatEvidence(result, { isTTY = false } = {}) {
  if (isTTY) return terminalJsonFallback(result);
  if (!result || typeof result !== "object" || result.ok !== true) {
    return jsonFallback(result, "jsonFallbackNonEvidenceResult");
  }
  const isSearch = Array.isArray(result.results);
  const isRead = typeof result.text === "string";
  if (!isSearch && !isRead) return jsonFallback(result, "jsonFallbackUnknownShape");

  const bodies = [];
  const compact = compactResult(result);
  if (isSearch) {
    compact.results.forEach((item) => {
      if (typeof item.snippet !== "string") return;
      const body = item.snippet;
      delete item.snippet;
      item.body = { index: bodies.length, field: "snippet", utf8Bytes: byteLength(body) };
      bodies.push(body);
    });
  } else {
    const body = compact.text;
    delete compact.text;
    compact.body = { index: 0, field: "text", utf8Bytes: byteLength(body) };
    bodies.push(body);
  }
  const metadata = {
    presentation: {
      status: "evidence",
      framing: "utf8-byte-length-delimited",
      bodyCount: bodies.length,
      additionalTruncation: false,
      budgetScope: "Retrieval byte and token limits apply to API-provided text or snippets; the formatter adds no total-output hard limit.",
      caveat: CAVEAT,
    },
    result: compact,
  };
  const metadataJson = JSON.stringify(metadata);
  const bodyFrames = bodies.map((body) => `\n${byteLength(body)}\n${body}`).join("");
  return `${FORMAT}\n${byteLength(metadataJson)}\n${metadataJson}${bodyFrames}`;
}

module.exports = { FORMAT, formatEvidence };

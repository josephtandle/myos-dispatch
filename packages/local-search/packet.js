"use strict";

const { readVerified, readVerifiedBytes, verifyMetadata } = require("./scope");
const { hydrateRecord, isDocument, sameSourceIdentity, sourceLocators } = require("./hydration");
const { analyzeQuery, termOffsets } = require("./query");
const { validatedSemanticPassage } = require("./qmd");

function linesOf(text) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") continue;
    lines.push({ start, end: index + 1, text: text.slice(start, index + 1) });
    start = index + 1;
  }
  if (start < text.length || lines.length === 0) lines.push({ start, end: text.length, text: text.slice(start) });
  return lines;
}

function findAnchor(text, candidate, analysis) {
  const semantic = candidate.mode === "semantic" || candidate.mode === "auto"
    ? validatedSemanticPassage(candidate.semantic, text)
    : null;
  const exact = candidate.matchTerms || [];
  const terms = [];
  const seen = new Set();
  for (const term of [...exact, ...analysis.lexicalTerms.map((value) => ({ kind: "identifier", value }))]) {
    const key = term.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const offsets = termOffsets(text, term);
    if (offsets.length > 0) terms.push({ term, offsets, exact: exact.includes(term) });
  }
  const events = terms.flatMap((entry) => entry.offsets.map((offset) => ({ ...entry, offset })))
    .sort((a, b) => a.offset - b.offset);
  const eligible = exact.length > 0 ? events.filter((event) => event.exact) : events;
  let best = null;
  let left = 0;
  let right = 0;
  for (const event of eligible) {
    while (left < events.length && events[left].offset < event.offset - 256) left += 1;
    if (right < left) right = left;
    while (right < events.length && events[right].offset <= event.offset + 256) right += 1;
    const nearby = events.slice(left, right);
    const distinct = new Map();
    for (const other of nearby) {
      const key = other.term.value.toLowerCase();
      const distance = Math.abs(other.offset - event.offset);
      if (!distinct.has(key) || distance < distinct.get(key).distance) distinct.set(key, { ...other, distance });
    }
    const positions = [...distinct.values()].map((item) => item.offset);
    const rarity = [...distinct.values()].reduce((sum, item) => sum + 1 / item.offsets.length, 0);
    const span = positions.length > 1 ? Math.max(...positions) - Math.min(...positions) : 256;
    const score = distinct.size * 1000 + rarity * 100 + 100 / (1 + span);
    if (!best || score > best.score) best = { score, event };
  }
  if (best) return {
    offset: best.event.offset,
    term: best.event.exact ? best.event.term : null,
    status: best.event.exact ? "exactTerm" : "bestLexicalPassage",
  };
  if (semantic) return { offset: semantic.chunkPos, term: null, status: "semanticPassage" };
  return { offset: 0, term: null, status: "noLexicalAnchorBeginningFallback" };
}

function semanticClip(segments, offset) {
  let previous = null;
  for (const segment of segments) {
    if (!segment || !Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end)
      || segment.start < 0 || segment.end <= segment.start) continue;
    if (offset < segment.start) return { segment, offset: segment.start };
    if (offset < segment.end) return { segment, offset };
    previous = segment;
  }
  return previous ? { segment: previous, offset: previous.start } : null;
}

function fits(text, maxBytes, maxCharacters) {
  return Buffer.byteLength(text) <= maxBytes && Array.from(text).length <= maxCharacters;
}

function boundedSlice(text, line, anchor, maxBytes, maxCharacters) {
  const points = [];
  let utf16 = line.start;
  for (const value of text.slice(line.start, line.end)) {
    points.push({ value, start: utf16, bytes: Buffer.byteLength(value) });
    utf16 += value.length;
  }
  const anchorIndex = Math.max(0, points.findIndex((point) => point.start >= anchor.offset));
  const termEnd = anchor.term ? anchor.offset + anchor.term.value.length : anchor.offset;
  let right = anchorIndex;
  while (right < points.length && points[right].start < termEnd) right += 1;
  const required = points.slice(anchorIndex, right);
  const requiredBytes = required.reduce((sum, point) => sum + point.bytes, 0);
  const requiredFits = requiredBytes <= maxBytes && required.length <= maxCharacters;
  if (!requiredFits) right = anchorIndex;
  let left = anchorIndex;
  let bytes = requiredFits ? requiredBytes : 0;
  let characters = requiredFits ? required.length : 0;
  if (!requiredFits && right < points.length && points[right].bytes <= maxBytes && maxCharacters > 0) {
    bytes = points[right].bytes; characters = 1; right += 1;
  }
  for (;;) {
    let changed = false;
    if (left > 0 && bytes + points[left - 1].bytes <= maxBytes && characters + 1 <= maxCharacters) {
      left -= 1; bytes += points[left].bytes; characters += 1; changed = true;
    }
    if (right < points.length && bytes + points[right].bytes <= maxBytes && characters + 1 <= maxCharacters) {
      bytes += points[right].bytes; characters += 1; right += 1; changed = true;
    }
    if (!changed) break;
  }
  return {
    start: points[left] ? points[left].start : line.start,
    end: points[right] ? points[right].start : line.end,
    matchedTerm: requiredFits && anchor.term ? anchor.term.value : null,
  };
}

function excerpt(text, anchor, maxBytes, maxCharacters) {
  const lines = linesOf(text);
  const anchorLine = Math.max(0, lines.findIndex((line) => anchor.offset >= line.start && anchor.offset < line.end));
  let first = anchorLine;
  let last = anchorLine;
  if (fits(lines[anchorLine].text, maxBytes, maxCharacters)) {
    let selected = lines[anchorLine].text;
    for (;;) {
      let changed = false;
      if (first > 0 && fits(lines[first - 1].text + selected, maxBytes, maxCharacters)) {
        first -= 1; selected = lines[first].text + selected; changed = true;
      }
      if (last + 1 < lines.length && fits(selected + lines[last + 1].text, maxBytes, maxCharacters)) {
        last += 1; selected += lines[last].text; changed = true;
      }
      if (!changed) break;
    }
    const start = lines[first].start;
    const end = lines[last].end;
    const matchedTerm = anchor.term && termOffsets(selected, anchor.term).length > 0 ? anchor.term.value : null;
    return { snippet: text.slice(start, end), start, truncated: start > 0 || end < text.length, contextIncomplete: first > 0 || last + 1 < lines.length, matchedTerm };
  }
  const selected = boundedSlice(text, lines[anchorLine], anchor, maxBytes, maxCharacters);
  return {
    snippet: text.slice(selected.start, selected.end),
    start: selected.start,
    truncated: true,
    contextIncomplete: true,
    matchedTerm: selected.matchedTerm,
  };
}

async function emitPacket(config, ranked, query, limits = {}) {
  const maxResults = Math.min(8, limits.maxResults || config.budgets.maxResults);
  const maxBytes = Math.min(limits.maxBytes || config.budgets.maxBytes, config.budgets.maxBytes);
  const maxTokens = limits.maxTokens || config.budgets.maxTokens;
  const results = [];
  const omitted = [];
  let usedBytes = 0;
  let estimatedTokens = 0;
  let deadlineExpired = false;
  const analysis = limits.queryAnalysis || analyzeQuery(query);
  for (let candidateIndex = 0; candidateIndex < ranked.length; candidateIndex += 1) {
    const candidate = ranked[candidateIndex];
    if (limits.deadline && Date.now() > limits.deadline) { deadlineExpired = true; break; }
    if (results.length >= maxResults) break;
    const root = config.roots.find((item) => item.id === candidate.rootId);
    if (!root) { omitted.push({ sourceId: candidate.sourceId, status: "revoked" }); continue; }
    if (limits.beforeEmit) limits.beforeEmit(candidate);
    if (!candidate.includeContent) {
      const current = candidate.contentEligible
        ? (isDocument(candidate) ? readVerifiedBytes(root, candidate.path) : readVerified(root, candidate.path))
        : verifyMetadata(root, candidate.path);
      if (!current.ok || (candidate.evidenceHash && current.hash !== candidate.evidenceHash)) {
        omitted.push({ sourceId: candidate.sourceId, status: current.status || "changedBeforeEmission", reason: current.reason });
        continue;
      }
      if (candidate.evidenceStat && !sameSourceIdentity({ stat: candidate.evidenceStat }, current)) {
        omitted.push({ sourceId: candidate.sourceId, status: "changedBeforeEmission", reason: "sourceIdentityChanged" });
        continue;
      }
      results.push({ sourceId: candidate.sourceId, rootId: candidate.rootId, relative: candidate.relative, score: candidate.score, mode: candidate.mode });
      continue;
    }
    const current = isDocument(candidate)
      ? await hydrateRecord(config, root, candidate, { force: true, deadline: limits.deadline, signal: limits.signal, extractDocument: limits.extractDocument })
      : readVerified(root, candidate.path);
    if (!current.ok) { omitted.push({ sourceId: candidate.sourceId, status: current.status, reason: current.reason }); continue; }
    if (candidate.evidenceHash && current.hash !== candidate.evidenceHash) {
      omitted.push({ sourceId: candidate.sourceId, status: "changedBeforeEmission" });
      continue;
    }
    if (candidate.evidenceExtractionKey && current.extractionKey !== candidate.evidenceExtractionKey) {
      omitted.push({ sourceId: candidate.sourceId, status: "changedBeforeEmission", reason: "parserIdentityChanged" });
      continue;
    }
    if (candidate.evidenceStat && !sameSourceIdentity({ stat: candidate.evidenceStat }, current)) {
      omitted.push({ sourceId: candidate.sourceId, status: "changedBeforeEmission", reason: "sourceIdentityChanged" });
      continue;
    }
    const requiredTerms = candidate.matchTerms || [{ kind: "identifier", value: query }];
    if (candidate.mode === "keyword" && candidate.exactRequired !== false
      && !requiredTerms.some((term) => termOffsets(current.text, term).length > 0)) {
      omitted.push({ sourceId: candidate.sourceId, status: "changedBeforeEmission" });
      continue;
    }
    const available = maxBytes - usedBytes;
    const tokenAvailableChars = maxTokens ? Math.max(0, (maxTokens - estimatedTokens) * 4) : Infinity;
    if (tokenAvailableChars <= 0 || available <= 0) break;
    const slots = Math.max(1, Math.min(maxResults - results.length, ranked.length - candidateIndex));
    const byteShare = Math.max(1, Math.floor(available / slots));
    const characterShare = maxTokens ? Math.max(1, Math.floor(tokenAvailableChars / slots)) : Infinity;
    let anchor = findAnchor(current.text, candidate, analysis);
    const semanticSelection = anchor.status === "semanticPassage" && current.document && Array.isArray(current.segments)
      ? semanticClip(current.segments, anchor.offset)
      : null;
    if (anchor.status === "semanticPassage" && current.document && Array.isArray(current.segments)) {
      anchor = semanticSelection
        ? { ...anchor, offset: semanticSelection.offset }
        : findAnchor(current.text, { ...candidate, semantic: null }, analysis);
    }
    const segment = semanticSelection && anchor.status === "semanticPassage" ? semanticSelection.segment : null;
    const clipStart = segment ? segment.start : 0;
    const clipEnd = segment ? segment.end : current.text.length;
    const selectedWithinClip = excerpt(
      current.text.slice(clipStart, clipEnd),
      { ...anchor, offset: anchor.offset - clipStart },
      byteShare,
      characterShare,
    );
    const clipped = clipStart > 0 || clipEnd < current.text.length;
    const selected = {
      ...selectedWithinClip,
      start: selectedWithinClip.start + clipStart,
      truncated: selectedWithinClip.truncated || clipped,
      contextIncomplete: selectedWithinClip.contextIncomplete || clipped,
    };
    const { snippet } = selected;
    if (snippet.length === 0) break;
    const bytes = Buffer.byteLength(snippet);
    const estimate = Math.ceil(snippet.length / 4);
    usedBytes += bytes;
    estimatedTokens += estimate;
    results.push({
      sourceId: candidate.sourceId, rootId: candidate.rootId, relative: candidate.relative,
      score: candidate.score, mode: candidate.mode, snippet,
      ...(!current.document ? { locator: { line: current.text.slice(0, selected.start).split("\n").length, byteOffset: Buffer.byteLength(current.text.slice(0, selected.start)) } } : {}),
      ...(current.document ? {
        extractedTextLocator: { line: current.text.slice(0, selected.start).split("\n").length, byteOffset: Buffer.byteLength(current.text.slice(0, selected.start)) },
        sourceLocators: sourceLocators(current, selected.start, selected.start + snippet.length),
        extractionKey: current.extractionKey,
        coverage: current.coverage,
        complete: current.complete,
      } : {}),
      sourceReadAt: current.sourceReadAt, hash: current.hash,
      truncated: selected.truncated,
      contextIncomplete: selected.contextIncomplete,
      anchorStatus: anchor.status,
      ...(selected.matchedTerm ? { matchedTerm: selected.matchedTerm } : {}),
      ...(anchor.status === "noLexicalAnchorBeginningFallback" ? { selectedSourceOnly: true } : {}),
    });
  }
  return { results, omitted, bytes: usedBytes, tokenEstimate: estimatedTokens, tokenEstimateMethod: "characters_divided_by_four_estimate_only", deadlineExpired, snapshotBoundary: "Each result was re-opened and verified before packet emission; files may change after sourceReadAt." };
}

module.exports = { emitPacket };

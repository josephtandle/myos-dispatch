"use strict";

const STOP_WORDS = new Set([
  "about", "after", "before", "does", "file", "find", "from", "have", "into", "says", "that", "the", "this", "what", "when", "where", "which", "with", "would",
]);

function add(matches, seen, kind, value, span) {
  const normalized = `${kind}:${value.toLowerCase()}`;
  if (seen.has(normalized)) return;
  seen.add(normalized);
  matches.push({ kind, value, span });
}

function analyzeQuery(query) {
  const exactTerms = [];
  const seen = new Set();
  const specializedSpans = [];
  const capture = (pattern, kind, group = 0) => {
    for (const match of query.matchAll(pattern)) {
      const value = match[group];
      const start = match.index + match[0].indexOf(value);
      const span = [start, start + value.length];
      specializedSpans.push(span);
      add(exactTerms, seen, kind, value, span);
    }
  };
  capture(/\b[A-Za-z_$][A-Za-z0-9_$]*=[^\s,;!?]+/g, "assignment");
  capture(/(^|\s)(--[A-Za-z0-9][A-Za-z0-9-]*(?:=[^\s,;!?]+)?)/g, "cliFlag", 2);
  capture(/\b[A-Za-z_$][A-Za-z0-9_$]*(?=\s*\()/g, "functionCall");
  capture(/(?:\.{0,2}\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z][A-Za-z0-9]{0,11}\b/g, "filename");
  for (const match of query.matchAll(/\b(?:[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*)\b/g)) {
    const span = [match.index, match.index + match[0].length];
    if (!specializedSpans.some(([start, end]) => span[0] < end && span[1] > start)) add(exactTerms, seen, "identifier", match[0], span);
  }

  const filenameLookup = /\b(?:where|find|locate|location|path)\b/i.test(query);
  const strongTerms = exactTerms.filter((term) => term.kind !== "filename" || filenameLookup);
  const lexicalTerms = [];
  const lexicalSeen = new Set();
  for (const match of query.matchAll(/[\p{L}\p{N}_-]+/gu)) {
    const value = match[0].toLowerCase();
    if (value.length < 3 || STOP_WORDS.has(value) || lexicalSeen.has(value)) continue;
    lexicalSeen.add(value);
    lexicalTerms.push(match[0]);
  }
  return { exactTerms, strongTerms, lexicalTerms, filenameLookup };
}

function boundaryClass(kind) {
  if (kind === "cliFlag") return /[A-Za-z0-9-]/;
  if (kind === "filename") return /[A-Za-z0-9_./-]/;
  return /[A-Za-z0-9_$]/;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termOffsets(text, term) {
  const boundary = boundaryClass(term.kind);
  const offsets = [];
  const pattern = new RegExp(escapeRegex(term.value), "giu");
  for (const match of text.matchAll(pattern)) {
    const offset = match.index;
    const before = offset > 0 ? text[offset - 1] : "";
    const afterIndex = offset + match[0].length;
    const after = afterIndex < text.length ? text[afterIndex] : "";
    let valid = !boundary.test(before) && !boundary.test(after);
    if (term.kind === "assignment") valid = valid && !/[A-Za-z0-9_.-]/.test(after);
    if (term.kind === "functionCall") {
      const suffix = text.slice(afterIndex).match(/^\s*/)[0].length;
      valid = !boundary.test(before) && text[afterIndex + suffix] === "(";
    }
    if (valid) offsets.push(offset);
  }
  return offsets;
}

module.exports = { analyzeQuery, termOffsets };

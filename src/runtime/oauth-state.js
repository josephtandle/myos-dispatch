"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { acquireLock } = require("./oauth-lock");

function parseState(text) {
  const state = JSON.parse(text);
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 1 || !Array.isArray(state.models)) {
    throw new Error("Invalid OAuth registry");
  }
  const keys = new Set();
  for (const record of state.models) {
    if (!record || typeof record.provider !== "string" || typeof record.model !== "string") throw new Error("Invalid OAuth model");
    const key = `${record.provider}:${record.model}`;
    if (keys.has(key)) throw new Error("Duplicate OAuth model");
    keys.add(key);
  }
  return state;
}

function readState(file) {
  if (!file) return null;
  for (const candidate of [file, file + ".last-good"]) {
    try { return parseState(fs.readFileSync(candidate, "utf8")); } catch { /* Try last good snapshot. */ }
  }
  return null;
}

function atomicWrite(file, state) {
  const serialized = JSON.stringify(state, null, 2) + "\n";
  parseState(serialized);
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function updateState(file, change, expectedRevision) {
  if (!path.isAbsolute(file)) throw new Error("OAuth registry requires an absolute path");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = file + ".lock";
  const release = acquireLock(lock);
  try {
    const previous = readState(file);
    if (!previous && fs.existsSync(file)) throw new Error("OAuth registry has no valid recovery snapshot");
    if (expectedRevision !== undefined && (previous?.revision || 0) !== expectedRevision) throw new Error("OAuth registry revision conflict");
    const next = change(previous);
    if (next.revision !== (previous?.revision || 0) + 1) throw new Error("OAuth registry revision must increment once");
    parseState(JSON.stringify(next));
    if (previous) atomicWrite(file + ".last-good", previous);
    atomicWrite(file, next);
    return next;
  } finally {
    release();
  }
}
module.exports = { readState, updateState };

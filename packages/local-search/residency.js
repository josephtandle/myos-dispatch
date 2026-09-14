"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const childProcess = require("node:child_process");
const fs = require("node:fs");

const BATCH_PATH_LIMIT = 128;
const BATCH_ARGV_BYTES = 32 * 1024;
const CLOUD_PLACEHOLDER_FLAG = 0x40000000;
const BATCH_FORMAT = "%d:%i:%z:%l:%u:%p:%f";
const residencyStorage = new AsyncLocalStorage();

function statIdentity(stat) {
  if (stat.mtimeNs === undefined || stat.ctimeNs === undefined) return null;
  return {
    dev: BigInt(stat.dev), ino: BigInt(stat.ino), size: BigInt(stat.size),
    mtimeNs: BigInt(stat.mtimeNs), ctimeNs: BigInt(stat.ctimeNs), mode: BigInt(stat.mode),
    uid: BigInt(stat.uid), nlink: BigInt(stat.nlink),
  };
}

function sameIdentity(first, second) {
  return first !== null && second !== null && first.dev === second.dev && first.ino === second.ino && first.size === second.size
    && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs
    && first.mode === second.mode && first.uid === second.uid && first.nlink === second.nlink;
}

function parseDecimal(value) {
  if (!/^\d+$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

function parseFlags(value) {
  const parsed = parseDecimal(value);
  return parsed !== null && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
}

function parseBatchRow(row) {
  const fields = row.split(":");
  if (fields.length !== 7 || !/^[0-7]+$/.test(fields[5])) return null;
  const [dev, ino, size, nlink, uid] = fields.slice(0, 5).map(parseDecimal);
  const flags = parseFlags(fields[6]);
  if ([dev, ino, size, nlink, uid].some((value) => value === null) || flags === null) return null;
  return { dev, ino, size, nlink, uid, mode: BigInt(`0o${fields[5]}`), flags };
}

function outputRows(raw, expected) {
  if (typeof raw !== "string" || !raw.endsWith("\n")) return null;
  const rows = raw.slice(0, -1).split("\n");
  return rows.length === expected ? rows : null;
}

function batchPaths(paths) {
  const batches = [];
  let batch = [];
  let bytes = Buffer.byteLength(BATCH_FORMAT) + 4;
  for (const filePath of paths) {
    const pathBytes = Buffer.byteLength(filePath) + 1;
    if (pathBytes + Buffer.byteLength(BATCH_FORMAT) + 4 > BATCH_ARGV_BYTES) continue;
    if (batch.length >= BATCH_PATH_LIMIT || bytes + pathBytes > BATCH_ARGV_BYTES) {
      batches.push(batch); batch = []; bytes = Buffer.byteLength(BATCH_FORMAT) + 4;
    }
    batch.push(filePath); bytes += pathBytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function runWithResidencyScope(callback) {
  return residencyStorage.run(new Map(), callback);
}

function primeResidency(paths, deadline, signal) {
  const evidence = residencyStorage.getStore();
  if (process.platform !== "darwin" || !evidence) return;
  for (const batch of batchPaths(paths)) {
    if (signal?.aborted || Date.now() >= deadline) return;
    try {
      const before = batch.map((filePath) => statIdentity(fs.lstatSync(filePath, { bigint: true })));
      const raw = childProcess.execFileSync("/usr/bin/stat", ["-f", BATCH_FORMAT, ...batch], {
        encoding: "utf8", timeout: Math.max(1, Math.min(1000, deadline - Date.now())), maxBuffer: 64 * 1024,
      });
      if (signal?.aborted || Date.now() >= deadline) return;
      const rows = outputRows(raw, batch.length);
      if (!rows) continue;
      const parsed = rows.map(parseBatchRow);
      if (parsed.some((row) => row === null)) continue;
      const after = batch.map((filePath) => statIdentity(fs.lstatSync(filePath, { bigint: true })));
      for (let index = 0; index < batch.length; index += 1) {
        const row = parsed[index];
        if (sameIdentity(before[index], after[index])
          && row.dev === after[index].dev && row.ino === after[index].ino && row.size === after[index].size
          && row.nlink === after[index].nlink && row.uid === after[index].uid && row.mode === after[index].mode) {
          evidence.set(batch[index], { identity: after[index], flags: row.flags });
        }
      }
    } catch {
      // Provisional evidence is optional; callers perform a fresh fail-closed check.
    }
  }
}

function freshResidentOnMac(filePath, identity) {
  try {
    const before = identity || statIdentity(fs.lstatSync(filePath, { bigint: true }));
    const raw = childProcess.execFileSync("/usr/bin/stat", ["-f", "%f", filePath], {
      encoding: "utf8", timeout: 1000, maxBuffer: 1024,
    });
    const rows = outputRows(raw, 1);
    const flags = rows ? parseFlags(rows[0]) : null;
    const after = statIdentity(fs.lstatSync(filePath, { bigint: true }));
    return flags !== null && sameIdentity(before, after) && (flags & CLOUD_PLACEHOLDER_FLAG) === 0;
  } catch { return false; }
}

function residentOnMac(filePath, stat) {
  if (process.platform !== "darwin") return true;
  const identity = statIdentity(stat);
  const evidence = residencyStorage.getStore();
  const cached = evidence?.get(filePath);
  if (cached) {
    evidence.delete(filePath);
    if (identity !== null && sameIdentity(cached.identity, identity)) return (cached.flags & CLOUD_PLACEHOLDER_FLAG) === 0;
  }
  return freshResidentOnMac(filePath, identity);
}

module.exports = { primeResidency, residentOnMac, runWithResidencyScope };

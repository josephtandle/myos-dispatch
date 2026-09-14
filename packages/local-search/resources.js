"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { ensureState } = require("./catalogue");

function coded(message, code) { return Object.assign(new Error(message), { code }); }

function validateOwned(target, kind, options = {}) {
  const stat = fs.lstatSync(target, { bigint: true });
  const ownerMismatch = typeof process.getuid === "function" && Number(stat.uid) !== process.getuid();
  const rightKind = kind === "directory" ? stat.isDirectory() : stat.isFile();
  if (!rightKind || stat.isSymbolicLink() || (kind === "file" && Number(stat.nlink) !== 1) || ownerMismatch || (!options.allowReadAccess && (Number(stat.mode) & 0o077) !== 0)) {
    throw coded(`${kind} is not owner-controlled`, "UNSAFE_STATE");
  }
  return stat;
}

function initializeDatabase(file) {
  try { fs.closeSync(fs.openSync(file, "wx", 0o600)); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  validateOwned(file, "file");
  const database = new DatabaseSync(file);
  try {
    database.exec("PRAGMA busy_timeout=0");
    database.exec("BEGIN IMMEDIATE");
    database.exec("CREATE TABLE IF NOT EXISTS inference_mutex (id INTEGER PRIMARY KEY CHECK (id = 1))");
    database.exec("COMMIT");
    return database;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    database.close();
    throw error;
  }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(coded("resource admission aborted", "ABORTED"));
    const timer = setTimeout(done, ms);
    function done() { cleanup(); resolve(); }
    function aborted() { cleanup(); reject(coded("resource admission aborted", "ABORTED")); }
    function cleanup() { clearTimeout(timer); signal?.removeEventListener("abort", aborted); }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

/** Acquire the one heavy-inference slot for this explicit state directory. */
async function acquireInference(config, options = {}) {
  if (options.signal?.aborted) throw coded("resource admission aborted", "ABORTED");
  ensureState(config);
  const deadline = Math.min(
    options.deadline ?? Infinity,
    Date.now() + (options.timeoutMs ?? config.resourcePolicy.inferenceWaitMs),
  );
  const lockPath = path.join(config.stateDirectory, "resource-admission.sqlite");
  let database;
  while (Date.now() <= deadline) {
    if (options.signal?.aborted) throw coded("resource admission aborted", "ABORTED");
    try {
      database = initializeDatabase(lockPath);
      database.exec("BEGIN IMMEDIATE");
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try { database.exec("COMMIT"); } finally { database.close(); }
        },
      };
    } catch (error) {
      try { database?.close(); } catch {}
      database = undefined;
      if (!(error.code === "ERR_SQLITE_ERROR" && /locked|busy/i.test(error.message))) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(25, remaining), options.signal);
    }
  }
  throw coded("heavy inference admission timed out", "RESOURCE_ADMISSION_TIMEOUT");
}

function storageAdmission(config, requestedBytes = 0) {
  ensureState(config);
  const identities = new Set();
  let stateBytes = 0;
  let externalModelBytes = 0;
  const visit = (directory) => {
    validateOwned(directory, "directory");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target, { bigint: true });
      const ownerMismatch = typeof process.getuid === "function" && Number(stat.uid) !== process.getuid();
      if (stat.isSymbolicLink() || ownerMismatch || (entry.isFile() && Number(stat.nlink) !== 1)) {
        throw coded("state contains an unsafe entry", "UNSAFE_STATE");
      }
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) { identities.add(`${stat.dev}:${stat.ino}`); stateBytes += Number(stat.size); }
      else throw coded("state contains an unsupported entry", "UNSAFE_STATE");
    }
  };
  visit(config.stateDirectory);
  for (const modelPath of Object.values(config.qmd?.modelPaths || {})) {
    const stat = validateOwned(modelPath, "file", { allowReadAccess: true });
    const identity = `${stat.dev}:${stat.ino}`;
    if (!identities.has(identity)) { identities.add(identity); externalModelBytes += Number(stat.size); }
  }
  const fileSystem = fs.statfsSync(config.stateDirectory);
  const freeBytes = Number(fileSystem.bavail) * Number(fileSystem.bsize);
  const totalBytes = Number(fileSystem.blocks) * Number(fileSystem.bsize);
  const reserveBytes = Math.max(config.budgets.reserveBytes, Math.ceil(totalBytes * config.budgets.reserveFraction));
  const accountedBytes = stateBytes + externalModelBytes;
  const quotaAllows = accountedBytes + requestedBytes <= config.budgets.quotaBytes;
  const reserveAllows = freeBytes - requestedBytes >= reserveBytes;
  return {
    ok: reserveAllows && quotaAllows,
    status: reserveAllows ? (quotaAllows ? "admitted" : "quotaExceeded") : "freeSpaceReserve",
    stateBytes, externalModelBytes, accountedBytes, requestedBytes, freeBytes, totalBytes, reserveBytes,
    scope: "state directory files plus configured external model files counted once by filesystem identity",
    limitation: "concurrent external writes can overshoot between checks; admission never deletes or quarantines originals",
  };
}

function maintenanceReservation(config, sourceFiles, sourceBytes, vectorChunks = 0) {
  const bounded = Number.isSafeInteger(sourceFiles) && sourceFiles >= 0
    && Number.isSafeInteger(sourceBytes) && sourceBytes >= 0
    && Number.isSafeInteger(vectorChunks) && vectorChunks >= 0
    && sourceFiles <= config.budgets.maintenanceMaxFiles
    && sourceBytes <= config.budgets.maintenanceMaxSourceBytes;
  if (!bounded) return { ok: false, status: "maintenanceBatchLimit", sourceFiles, sourceBytes, vectorChunks };
  const modelBytes = Buffer.byteLength(config.qmd?.modelPaths?.embed || "", "utf8");
  const sequenceDigits = String(Math.max(0, vectorChunks - 1)).length;
  const contentVectorRowBytes = 64 + 8 + 8 + modelBytes + 64 + 8 + 32 + 64;
  const vecRowBytes = 64 + 1 + sequenceDigits + 64;
  const vectorRowBytes = vectorChunks * (contentVectorRowBytes + vecRowBytes);
  const vectorValueBytes = vectorChunks * config.budgets.embeddingDimensions * config.budgets.embeddingBytesPerDimension;
  const stagedAndIndexBytes = Math.ceil(sourceBytes * config.budgets.writeAmplification);
  const amplifiedVectorBytes = Math.ceil((vectorValueBytes + vectorRowBytes) * config.budgets.writeAmplification);
  const walAndScratchBytesPerPhase = config.qmd ? config.budgets.writeScratchBytes : 0;
  const stagingRequestedBytes = stagedAndIndexBytes + walAndScratchBytesPerPhase;
  const embeddingRequestedBytes = amplifiedVectorBytes + walAndScratchBytesPerPhase;
  const requestedBytes = stagedAndIndexBytes + amplifiedVectorBytes + walAndScratchBytesPerPhase;
  if (![vectorRowBytes, vectorValueBytes, stagedAndIndexBytes, amplifiedVectorBytes, stagingRequestedBytes, embeddingRequestedBytes, requestedBytes].every(Number.isSafeInteger)) {
    return { ok: false, status: "maintenanceBatchLimit", sourceFiles, sourceBytes, vectorChunks };
  }
  return {
    ok: true,
    sourceFiles,
    sourceBytes,
    vectorChunks,
    stagedAndIndexBytes,
    vectorValueBytes,
    vectorRowBytes,
    amplifiedVectorBytes,
    walAndScratchBytesPerPhase,
    stagingRequestedBytes,
    embeddingRequestedBytes,
    requestedBytes,
    limitation: "conservative admission estimate including logical QMD vector rows, configured dimensions, write amplification, and WAL/scratch per phase; native SQLite writes are not observable at sub-write granularity, so this is not a hard quota promise",
  };
}

function statusPath(config) { return path.join(config.stateDirectory, "resource-status.json"); }

function loadResourceStatus(config) {
  try {
    validateOwned(statusPath(config), "file");
    const value = JSON.parse(fs.readFileSync(statusPath(config), "utf8"));
    return value.version === 1 ? value : null;
  } catch { return null; }
}

function publishResourceStatus(config, value) {
  ensureState(config);
  const target = statusPath(config);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const previous = loadResourceStatus(config) || {};
  let descriptor;
  let temporaryCreated = false;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    temporaryCreated = true;
    fs.writeFileSync(descriptor, `${JSON.stringify({ ...previous, version: 1, ...value })}\n`);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
  } catch (error) {
    try { if (descriptor !== undefined) fs.closeSync(descriptor); } catch {}
    if (temporaryCreated) try {
      validateOwned(temporary, "file");
      fs.unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

function productionRead(command, args, timeoutMs, outputBytes = 64 * 1024) {
  return execFileSync(command, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: outputBytes, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
}

function memoryAdmission(config, options = {}) {
  const policy = config.resourcePolicy.memory;
  const modelPath = options.modelPath || config.qmd?.modelPaths?.embed;
  let modelBytes;
  try { modelBytes = Number(validateOwned(modelPath, "file", { allowReadAccess: true }).size); }
  catch {
    const result = { ok: false, status: "memoryProbeUnavailable", reason: "approvedModelUnavailable" };
    publishResourceStatus(config, { memory: result.status, memoryDetails: result });
    return result;
  }
  let availableBytes;
  let totalBytes;
  if (options.readings) {
    ({ availableBytes, totalBytes } = options.readings);
  } else if ((options.platform ?? process.platform) === "darwin") {
    const read = options.readCommand || productionRead;
    try {
      const total = read("/usr/sbin/sysctl", ["-n", "hw.memsize"], policy.probeTimeoutMs, policy.probeOutputBytes);
      const virtual = read("/usr/bin/vm_stat", [], policy.probeTimeoutMs, policy.probeOutputBytes);
      if (!/^\s*\d+\s*$/.test(total)) throw new Error("total memory unavailable");
      const pageSize = /page size of (\d+) bytes/.exec(virtual);
      const free = /^Pages free:\s*(\d+)\.\s*$/m.exec(virtual);
      const inactive = /^Pages inactive:\s*(\d+)\.\s*$/m.exec(virtual);
      const speculative = /^Pages speculative:\s*(\d+)\.\s*$/m.exec(virtual);
      if (!pageSize || !free || !inactive || !speculative) throw new Error("available memory unavailable");
      totalBytes = Number(total.trim());
      availableBytes = Number(pageSize[1]) * (Number(free[1]) + Number(inactive[1]) + Number(speculative[1]));
    } catch {
      availableBytes = NaN;
      totalBytes = NaN;
    }
  }
  const validReading = Number.isSafeInteger(availableBytes) && availableBytes >= 0
    && Number.isSafeInteger(totalBytes) && totalBytes > 0 && availableBytes <= totalBytes;
  const requiredBytes = Math.ceil(modelBytes * policy.modelSizeMultiplier + policy.fixedOverheadBytes);
  const ok = validReading && Number.isSafeInteger(requiredBytes) && availableBytes - requiredBytes >= policy.minimumAvailableBytes;
  const status = !validReading ? "memoryProbeUnavailable" : (ok ? "admitted" : "memoryHeadroom");
  const result = {
    ok,
    status,
    modelBytes,
    availableBytes: validReading ? availableBytes : null,
    totalBytes: validReading ? totalBytes : null,
    requiredBytes,
    minimumAvailableBytes: policy.minimumAvailableBytes,
    limitation: "admission-time estimate from sampled host memory; it is not a hard RSS ceiling",
  };
  publishResourceStatus(config, { memory: status, memoryDetails: result });
  return result;
}

async function acquireInferenceWithMemory(config, options = {}) {
  const admission = await acquireInference(config, options);
  try {
    const memory = memoryAdmission(config, options.memoryOptions);
    if (!memory.ok) {
      admission.release();
      return { ok: false, status: memory.status, memory };
    }
    return { ok: true, status: "admitted", memory, admission };
  } catch (error) {
    admission.release();
    throw error;
  }
}

async function prepareEmbeddingPlan(staged, chunkDocumentByTokens, options = {}) {
  if (typeof chunkDocumentByTokens !== "function") throw coded("QMD package does not expose its pinned token chunker", "QMD_API_MISMATCH");
  const byCollection = new Map();
  for (const item of staged.staged || []) {
    if (options.signal?.aborted) throw coded("maintenance aborted", "ABORTED");
    const chunks = await chunkDocumentByTokens(
      item.current.text,
      undefined,
      undefined,
      undefined,
      path.join(item.directory, item.filename),
      "regex",
      options.signal,
    );
    if (!Array.isArray(chunks)) throw coded("QMD chunker returned an invalid result", "QMD_API_MISMATCH");
    byCollection.set(item.root.id, (byCollection.get(item.root.id) || 0) + chunks.length);
  }
  return { byCollection, remainingChunks: [...byCollection.values()].reduce((sum, count) => sum + count, 0) };
}

function probeBackground(config, options = {}) {
  if (options.readings) {
    const { onBattery, thermalPressure, idleMs } = options.readings;
    if (typeof onBattery !== "boolean" || typeof thermalPressure !== "boolean" || !Number.isFinite(idleMs) || idleMs < 0) {
      return { available: false, reason: "backgroundProbeUnavailable" };
    }
    return { available: true, onBattery, thermalPressure, idleMs };
  }
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return { available: false, reason: "backgroundProbeUnavailable" };
  const read = options.readCommand || productionRead;
  try {
    const timeout = config.resourcePolicy.background.probeTimeoutMs;
    const outputBytes = config.resourcePolicy.background.probeOutputBytes || 64 * 1024;
    const battery = read("/usr/bin/pmset", ["-g", "batt"], timeout, outputBytes);
    const thermal = read("/usr/bin/pmset", ["-g", "therm"], timeout, outputBytes);
    const idle = read("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"], timeout, outputBytes);
    const power = /Now drawing from ['"](AC Power|Battery Power)['"]/i.exec(battery);
    if (!power) throw new Error("power source unavailable");
    const idleMatch = /"HIDIdleTime"\s*=\s*(\d+)/.exec(idle);
    if (!idleMatch) throw new Error("idle unavailable");
    const speed = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(thermal);
    const warning = /Thermal(?:Pressure|Warning)_Level\s*=\s*(\d+)/i.exec(thermal);
    if (!speed && !warning && !/No thermal warning level has been recorded/i.test(thermal)) throw new Error("thermal unavailable");
    return {
      available: true,
      onBattery: power[1].toLowerCase() === "battery power",
      thermalPressure: Boolean((speed && Number(speed[1]) < 100) || (warning && Number(warning[1]) > 0)),
      idleMs: Number(idleMatch[1]) / 1_000_000,
    };
  } catch { return { available: false, reason: "backgroundProbeUnavailable" }; }
}

function evaluateBackground(config, options = {}) {
  const now = options.now ? options.now() : Date.now();
  const session = options.session || {};
  const reading = probeBackground(config, options);
  let pausedReason = null;
  if (!reading.available) pausedReason = reading.reason || "backgroundProbeUnavailable";
  else if (reading.onBattery) pausedReason = "onBattery";
  else if (reading.thermalPressure) pausedReason = "thermalPressure";
  else if (reading.idleMs < config.resourcePolicy.background.idleDwellMs) pausedReason = "idleDwell";
  const staleSample = !Number.isFinite(session.lastSampleAt)
    || now < session.lastSampleAt
    || now - session.lastSampleAt > config.resourcePolicy.background.sampleGapMs;
  if (pausedReason || staleSample) session.healthySince = null;
  if (!pausedReason && !Number.isFinite(session.healthySince)) session.healthySince = now;
  const healthySince = session.healthySince;
  if (!pausedReason && now - healthySince < config.resourcePolicy.background.healthyDwellMs) pausedReason = "healthyDwell";
  session.lastSampleAt = now;
  const value = {
    background: pausedReason ? "paused" : "ready",
    pausedReason,
    lastCheck: new Date(now).toISOString(),
    healthySince,
    probeAvailable: reading.available,
  };
  publishResourceStatus(config, value);
  return value;
}

module.exports = { acquireInference, acquireInferenceWithMemory, evaluateBackground, loadResourceStatus, maintenanceReservation, memoryAdmission, prepareEmbeddingPlan, probeBackground, publishResourceStatus, storageAdmission };

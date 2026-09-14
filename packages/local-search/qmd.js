"use strict";

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ensureState } = require("./catalogue");

const POLICY = "(version 1)(allow default)(deny network*)";
const MODEL_HASH_CACHE = new Map();

function validatedSemanticPassage(value, text) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Number.isSafeInteger(value.chunkPos) || value.chunkPos < 0
    || typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/i.test(value.contentHash)) return null;
  const contentHash = value.contentHash.toLowerCase();
  if (text === undefined) return { chunkPos: value.chunkPos, contentHash };
  if (typeof text !== "string" || value.chunkPos >= text.length
    || (value.chunkPos > 0 && /[\uD800-\uDBFF]/.test(text[value.chunkPos - 1]) && /[\uDC00-\uDFFF]/.test(text[value.chunkPos]))
    || crypto.createHash("sha256").update(text).digest("hex") !== contentHash) return null;
  return { chunkPos: value.chunkPos, contentHash };
}

function coded(message, code) { return Object.assign(new Error(message), { code }); }

function qmdStatus(config, options = {}) {
  if (!config.qmd) return { available: false, status: "notConfigured", semanticAvailable: false };
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")) return { available: false, status: "strictNetworkEnforcementUnsupported", semanticAvailable: false };
  const probe = spawnSync("/usr/bin/sandbox-exec", ["-p", POLICY, "/usr/bin/true"], { timeout: 1000, stdio: "ignore" });
  if (probe.status !== 0) return { available: false, status: "strictNetworkEnforcementUnavailable", semanticAvailable: false };
  const sdkFiles = ["dist/index.js", "dist/llm.js", "dist/store.js"].map((relative) => path.join(config.qmd.packageRoot, relative));
  if (!fs.existsSync(config.qmd.nodePath) || sdkFiles.some((file) => !fs.existsSync(file))) return { available: false, status: "installationUnavailable", semanticAvailable: false };
  try {
    const nodeMajor = spawnSync(config.qmd.nodePath, ["-p", "process.versions.node.split('.')[0]"], { encoding: "utf8", timeout: 1000, env: { PATH: "/usr/bin:/bin" } });
    if (nodeMajor.status !== 0 || nodeMajor.stdout.trim() !== "24") throw coded("QMD requires Node 24", "NODE_VERSION_UNSUPPORTED");
    const qmdPackage = JSON.parse(fs.readFileSync(path.join(config.qmd.packageRoot, "package.json"), "utf8"));
    if (qmdPackage.name !== "@tobilu/qmd" || qmdPackage.version !== "2.8.3") throw coded("QMD package must be pinned to @tobilu/qmd 2.8.3", "QMD_VERSION_UNSUPPORTED");
    verifyModels(config, { writeProof: options.writeProof === true });
  } catch (error) {
    return { available: false, status: error.code || "modelVerificationFailed", semanticAvailable: false };
  }
  return { available: true, status: "available", semanticAvailable: Boolean(config.qmd.modelPaths.embed) };
}

function loadModelProof(config) {
  try {
    const target = path.join(config.stateDirectory, "model-integrity.json");
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return {};
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    return parsed.version === 1 && parsed.models && typeof parsed.models === "object" ? parsed.models : {};
  } catch { return {}; }
}

function publishModelProof(config, models) {
  ensureState(config);
  const target = path.join(config.stateDirectory, "model-integrity.json");
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, models })}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, target);
}

function verifyModels(config, options = { writeProof: true }) {
  const proofs = loadModelProof(config);
  let changed = false;
  for (const [name, modelPath] of Object.entries(config.qmd.modelPaths)) {
    const stat = fs.lstatSync(modelPath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink) > 1) throw coded(`model ${name} is unavailable or unsafe`, "MODEL_UNAVAILABLE");
    if (typeof process.getuid === "function" && Number(stat.uid) !== process.getuid()) throw coded(`model ${name} has a foreign owner`, "MODEL_UNAVAILABLE");
    const fd = fs.openSync(modelPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const header = Buffer.alloc(4);
    try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
    if (header.toString("ascii") !== "GGUF") throw coded(`model ${name} has no GGUF header`, "MODEL_INVALID_GGUF");
    const expected = config.qmd.modelHashes[name];
    if (expected) {
      const identity = `${modelPath}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${expected}`;
      if (proofs[name] && proofs[name].identity === identity && proofs[name].hash === expected.toLowerCase()) continue;
      if (!options.writeProof) throw coded(`model ${name} integrity proof is not established`, "MODEL_INTEGRITY_UNVERIFIED");
      let actual = MODEL_HASH_CACHE.get(identity);
      if (!actual) {
        actual = crypto.createHash("sha256").update(fs.readFileSync(modelPath)).digest("hex");
        MODEL_HASH_CACHE.clear();
        MODEL_HASH_CACHE.set(identity, actual);
      }
      if (actual.toLowerCase() !== expected.toLowerCase()) throw Object.assign(new Error(`model ${name} hash mismatch`), { code: "MODEL_HASH_MISMATCH" });
      proofs[name] = { identity, hash: actual.toLowerCase() };
      changed = true;
    }
  }
  if (changed) publishModelProof(config, proofs);
}

function environment(config) {
  ensureState(config);
  const base = path.join(config.stateDirectory, "qmd-runtime");
  for (const directory of [base, path.join(base, "home"), path.join(base, "cache"), path.join(base, "config")]) {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw coded("qmd runtime directory is unsafe", "UNSAFE_STATE");
  }
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: path.join(base, "home"),
    XDG_CACHE_HOME: path.join(base, "cache"),
    XDG_CONFIG_HOME: path.join(base, "config"),
    NO_COLOR: "1",
    QMD_SOURCE_MODE: "0",
  };
  for (const [name, modelPath] of Object.entries((config.qmd && config.qmd.modelPaths) || {})) env[`QMD_${name.toUpperCase()}_MODEL`] = modelPath;
  return env;
}

function runQmd(config, qmdArgs, options = {}) {
  if (options.signal?.aborted) return Promise.resolve({ ok: false, status: "aborted" });
  if (!options.skipStatus) {
    const status = qmdStatus(config, { writeProof: true });
    if (!status.available) return Promise.resolve({ ok: false, status: status.status });
  }
  const launcher = options.program || path.join(config.qmd.packageRoot, "bin", "qmd");
  const nodePath = options.nodePath || (config.qmd && config.qmd.nodePath);
  if (!nodePath) return Promise.resolve({ ok: false, status: "node24NotConfigured" });
  const args = ["-p", POLICY, nodePath, launcher, ...qmdArgs];
  const timeoutMs = options.timeoutMs || config.qmd.timeoutMs;
  const outputLimit = config.qmd ? config.qmd.outputBytes : 1024 ** 2;
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/sandbox-exec", args, { env: environment(config), shell: false, detached: true, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failureStatus = null;
    let killTimer;
    let settled = false;
    const signalGroup = (signal) => {
      try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") failureStatus ||= "processGroupSignalFailed"; }
    };
    const terminate = (statusName) => {
      failureStatus ||= statusName;
      signalGroup("SIGTERM");
      if (!killTimer) { killTimer = setTimeout(() => signalGroup("SIGKILL"), 250); killTimer.unref(); }
    };
    const abort = () => terminate("aborted");
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (options.signal) options.signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const collect = (target, chunk, stream) => {
      const used = stream === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, outputLimit - used);
      if (remaining) target.push(chunk.subarray(0, remaining));
      if (stream === "stdout") stdoutBytes += Math.min(chunk.length, remaining); else stderrBytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) terminate("outputLimit");
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(stderr, chunk, "stderr"));
    if (child.stdin) {
      child.stdin.on("error", (error) => terminate(error.code === "EPIPE" ? "stdinClosed" : "stdinFailed"));
      child.stdin.end(options.input);
    }
    child.on("error", (error) => finish({ ok: false, status: "spawnFailed", error: error.message }));
    child.on("close", (code, signal) => {
      const complete = () => finish(failureStatus
        ? { ok: false, status: failureStatus, code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }
        : code === 0
          ? { ok: true, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }
          : { ok: false, status: "qmdFailed", code, signal, stderr: Buffer.concat(stderr).toString("utf8") });
      try {
        process.kill(-child.pid, 0);
        terminate(failureStatus || "lingeringProcessGroup");
        const poll = setInterval(() => {
          try { process.kill(-child.pid, 0); signalGroup("SIGKILL"); }
          catch (error) { if (error.code === "ESRCH") { clearInterval(poll); complete(); } }
        }, 25);
      } catch (error) {
        if (error.code === "ESRCH") complete(); else finish({ ok: false, status: "processGroupStateUnknown" });
      }
    });
    if (options.signal) {
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
    }
    const timer = setTimeout(() => terminate("timeout"), timeoutMs);
    timer.unref();
  });
}

async function runMaintenanceWorker(config, options = {}) {
  if (options.signal?.aborted) return { ok: false, status: "aborted" };
  const verifiedStatus = config.qmd ? qmdStatus(config, { writeProof: true }) : { available: false, semanticAvailable: false, status: "notConfigured" };
  if (config.qmd && !verifiedStatus.available) return { ok: false, status: verifiedStatus.status };
  const nodePath = config.qmd ? config.qmd.nodePath : (process.versions.node.split(".")[0] === "24" ? process.execPath : null);
  const response = await runQmd(config, [], {
    ...options,
    skipStatus: true,
    nodePath,
    program: path.join(__dirname, "maintenance-worker.mjs"),
    input: JSON.stringify({ config, qmdStatus: verifiedStatus }),
    timeoutMs: config.budgets.indexDeadlineMs,
  });
  if (!response.ok) return response;
  try { return JSON.parse(response.stdout); }
  catch { return { ok: false, status: "malformedMaintenanceResult" }; }
}

function runSdkSearch(config, request, options = {}) {
  if (Object.hasOwn(request, "collection") && Object.hasOwn(request, "collections")) {
    return Promise.resolve({ ok: false, status: "invalidRequest" });
  }
  const payload = {
    operation: request.operation,
    packageRoot: config.qmd && config.qmd.packageRoot,
    dbPath: path.join(config.stateDirectory, "qmd-index.sqlite"),
    ...(request.collections === undefined ? { collection: request.collection } : { collections: request.collections }),
    query: request.query,
    limit: request.limit,
    modelPaths: config.qmd && config.qmd.modelPaths,
    stateDirectory: config.stateDirectory,
    resourcePolicy: config.resourcePolicy,
    admissionTimeoutMs: Math.min(options.timeoutMs || config.qmd.timeoutMs, config.resourcePolicy.inferenceWaitMs),
  };
  return runQmd(config, [], {
    ...options,
    program: path.join(__dirname, "qmd-sdk-child.mjs"),
    input: JSON.stringify(payload),
  });
}

async function runSdkSearchCollections(config, request, options = {}) {
  const { collections } = request;
  if (!Array.isArray(collections)) return { ok: false, status: "invalidRequest" };
  if (collections.length === 0) return { ok: true, stdout: "[]" };
  const invoke = options.invoke || runSdkSearch;
  const invokeWithinDeadline = async (nextRequest) => {
    if (options.signal?.aborted) return { ok: false, status: "aborted" };
    const remaining = options.deadline - Date.now();
    if (remaining <= 0) return { ok: false, status: "deadlineExpired" };
    const response = await invoke(config, nextRequest, { timeoutMs: remaining, signal: options.signal });
    if (options.signal?.aborted) return { ok: false, status: "aborted" };
    if (Date.now() >= options.deadline) return { ok: false, status: "deadlineExpired" };
    return response;
  };
  if (collections.length <= 64) return invokeWithinDeadline(request);

  const { collections: _collections, ...common } = request;
  const rows = [];
  for (const collection of collections) {
    const response = await invokeWithinDeadline({ ...common, collection });
    if (!response.ok) return response;
    let candidates;
    try { candidates = JSON.parse(response.stdout); } catch { return response; }
    if (!Array.isArray(candidates)) return response;
    rows.push(...candidates);
  }
  return { ok: true, stdout: JSON.stringify(rows) };
}

function parseCandidates(output, manifests, requestedCollections) {
  let rows;
  try { rows = JSON.parse(output); } catch { return { ok: false, status: "malformedQmdJson", candidates: [] }; }
  if (!Array.isArray(rows)) return { ok: false, status: "malformedQmdJson", candidates: [] };
  const candidates = [];
  const requested = requestedCollections === undefined ? null : new Set(requestedCollections);
  for (const row of rows) {
    if (!row || typeof row.file !== "string" || !Number.isFinite(Number(row.score))) continue;
    const match = /^qmd:\/\/([a-zA-Z0-9_-]+)\/([^/?#]+\.md)(?:\?.*)?$/.exec(row.file);
    if (!match) continue;
    if (requested && !requested.has(match[1])) return { ok: false, status: "qmdCollectionMismatch", candidates: [] };
    const manifest = manifests[match[1]];
    const entry = manifest && manifest[match[2]];
    const sourceId = typeof entry === "string" ? entry : entry && entry.sourceId;
    if (sourceId) {
      const semantic = validatedSemanticPassage(row.semantic);
      candidates.push({
        sourceId, indexedHash: entry && entry.hash, revision: entry && entry.revision,
        score: Number(row.score), collection: match[1], ...(semantic ? { semantic } : {}),
      });
    }
  }
  return { ok: true, candidates };
}

module.exports = { POLICY, environment, parseCandidates, qmdStatus, runMaintenanceWorker, runQmd, runSdkSearch, runSdkSearchCollections, validatedSemanticPassage, verifyModels };

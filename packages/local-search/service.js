"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { loadConfig } = require("./config");

const PUBLIC_FIELDS = Object.freeze([
  "version", "id", "name", "enabled", "taskClass", "complianceLane", "scheduler",
  "phase", "lastHeartbeat", "lastRun", "lastStatus", "nextReconciliationAt", "errorCode",
]);
const PUBLIC_PHASES = new Set(["disabled", "offline", "starting", "watching", "paused", "recovering", "degraded", "stopped"]);
const PUBLIC_ERROR_CODES = new Set([
  "configurationDisabled", "serviceNotEnabled", "registrationMissing", "missingHeartbeat",
  "staleHeartbeat", "futureHeartbeat", "invalidStatus", "ownershipCollision",
  "watchStartupFailed", "watchStopped", "watchError", "reconcileFailed", "clockGap",
  "resourcePaused", "indexNotReady", "wakeNoop", "wakeFailed", "serviceFailed",
  "heartbeatPublicationFailed", "rollbackIncomplete", "stopVerificationFailed", "registrationUnknown",
  "invalidRuntime",
]);
const PUBLIC_OPERATION_STATUSES = new Set([
  ...PUBLIC_ERROR_CODES, "invalidArgument", "wrongRuntimeMajor", "unsupportedPlatform",
  "confirmationRequired", "registrationFailed", "startupAckTimeout", "runtimeSpawnFailed",
  "invalidRuntimeOutput",
]);
const MAX_PRIVATE_BYTES = 8 * 1024;
const MAX_CLOCK_SKEW_MS = 1_000;
const HEALTHY_ACK_PHASES = new Set(["starting", "watching"]);

function coded(message, code, details = {}) { return Object.assign(new Error(message), { code, ...details }); }
function safeErrorCode(value, fallback = "serviceFailed") { return typeof value === "string" && PUBLIC_ERROR_CODES.has(value) ? value : fallback; }
function safeOperationStatus(value) {
  if (value === "INVALID_ARGUMENT") return "invalidArgument";
  return typeof value === "string" && PUBLIC_OPERATION_STATUSES.has(value) ? value : "serviceFailed";
}
function operationError(error) {
  return { ok: false, status: safeOperationStatus(error && error.code), taskClass: "cheap_routing", complianceLane: "unattended_local" };
}

function projection(identity, values = {}) {
  const source = {
    version: 1, id: identity.label, name: "local-search-freshness", enabled: false,
    taskClass: "default_automation", complianceLane: "unattended_local", scheduler: "launchd",
    phase: "disabled", lastHeartbeat: null, lastRun: null, lastStatus: null,
    nextReconciliationAt: null, errorCode: null, ...values,
  };
  if (!PUBLIC_PHASES.has(source.phase)) source.phase = "degraded";
  if (source.errorCode !== null) source.errorCode = safeErrorCode(source.errorCode);
  return Object.fromEntries(PUBLIC_FIELDS.map((field) => [field, source[field] ?? null]));
}

function deriveIdentity(configPath, config, dependencies = {}) {
  const installationRoot = path.resolve(dependencies.installationRoot || path.join(__dirname, "../.."));
  const digest = crypto.createHash("sha256").update(`${installationRoot}\0${path.normalize(configPath)}`).digest("hex").slice(0, 20);
  const label = `com.myos.local-search.${digest}`;
  const serviceDirectory = path.join(config.stateDirectory, "service");
  const launchAgentsDirectory = path.join(dependencies.homeDirectory || os.homedir(), "Library", "LaunchAgents");
  return Object.freeze({
    id: label, label, serviceDirectory, launchAgentsDirectory,
    plistPath: path.join(launchAgentsDirectory, `${label}.plist`),
    receiptPath: path.join(serviceDirectory, "owner-receipt.json"),
    markerPath: path.join(serviceDirectory, "enabled"), statusPath: path.join(serviceDirectory, "status.json"),
    runnerPath: path.join(installationRoot, "packages", "local-search", "service-runner.js"),
  });
}

function currentUid() { return typeof process.getuid === "function" ? process.getuid() : null; }
function isTrustedOwner(stat) { const uid = currentUid(); return uid === null || stat.uid === uid || stat.uid === 0; }

function assertPrivateFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  const uid = currentUid();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (uid !== null && stat.uid !== uid) || (stat.mode & 0o077) !== 0) throw coded(`${label} is not an owner-only ordinary file`, "ownershipCollision");
  return stat;
}

function assertTrustedExecutable(filePath, label) {
  let stat;
  try { stat = fs.lstatSync(filePath); }
  catch { throw coded(`${label} is unavailable`, "invalidRuntime"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !isTrustedOwner(stat) || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0) throw coded(`${label} is not a trusted ordinary executable`, "invalidRuntime");
  return stat;
}

function assertTrustedReadableCode(filePath, label) {
  let stat;
  try { stat = fs.lstatSync(filePath); }
  catch { throw coded(`${label} is unavailable`, "invalidRuntime"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !isTrustedOwner(stat) || (stat.mode & 0o022) !== 0 || (stat.mode & 0o444) === 0) {
    throw coded(`${label} is not trusted readable code`, "invalidRuntime");
  }
  try { fs.accessSync(filePath, fs.constants.R_OK); }
  catch { throw coded(`${label} is not readable`, "invalidRuntime"); }
  return stat;
}

function aliasAllowed(cursor, stat) {
  if (!stat.isSymbolicLink()) return false;
  const aliases = process.platform === "darwin" ? new Map([["/tmp", "/private/tmp"], ["/var", "/private/var"], ["/etc", "/private/etc"]]) : new Map([["/var/run", "/run"]]);
  const expected = aliases.get(cursor);
  if (!expected) return false;
  try { return fs.realpathSync.native(cursor) === expected; } catch { return false; }
}

function assertSafeDirectory(directory, label, options = {}) {
  const normalized = path.resolve(directory);
  const parsed = path.parse(normalized);
  let cursor = parsed.root;
  for (const part of normalized.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) {
      if (!options.create) throw coded(`${label} does not exist`, "ownershipCollision");
      fs.mkdirSync(cursor, { mode: 0o700 });
    }
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      if (aliasAllowed(cursor, stat)) continue;
      throw coded(`${label} contains a symbolic-link component`, "ownershipCollision");
    }
    if (!stat.isDirectory() || !isTrustedOwner(stat)) throw coded(`${label} has an untrusted ancestor`, "ownershipCollision");
    if ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0)) throw coded(`${label} has a writable ancestor`, "ownershipCollision");
  }
  const leaf = fs.lstatSync(normalized);
  if (options.privateLeaf && ((leaf.mode & 0o077) !== 0 || (currentUid() !== null && leaf.uid !== currentUid()))) throw coded(`${label} must be an owner-only directory`, "ownershipCollision");
  return leaf;
}

function prepareDirectories(config, identity) {
  if (fs.existsSync(config.stateDirectory)) assertSafeDirectory(config.stateDirectory, "state directory", { privateLeaf: true });
  else assertSafeDirectory(config.stateDirectory, "state directory", { create: true, privateLeaf: true });
  assertSafeDirectory(identity.serviceDirectory, "service directory", { create: true, privateLeaf: true });
  assertSafeDirectory(identity.launchAgentsDirectory, "LaunchAgents directory", { create: true });
}

function readBoundedPrivate(filePath, label) {
  assertPrivateFile(filePath, label);
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_PRIVATE_BYTES) throw coded(`${label} is malformed`, "ownershipCollision");
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) { const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset); if (count === 0) break; offset += count; }
    if (offset !== buffer.length) throw coded(`${label} changed while reading`, "ownershipCollision");
    return buffer.toString("utf8");
  } finally { fs.closeSync(fd); }
}

function writeExclusive(filePath, content) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
  const directory = path.dirname(filePath);
  const directoryBefore = assertSafeDirectory(directory, "private file directory");
  let fd;
  let created = false;
  let stableDirectory = true;
  try {
    fd = fs.openSync(filePath, flags, 0o600);
    created = true;
    const directoryAfterOpen = fs.lstatSync(directory);
    stableDirectory = directoryAfterOpen.dev === directoryBefore.dev && directoryAfterOpen.ino === directoryBefore.ino;
    if (!stableDirectory) throw coded("private file directory changed during creation", "ownershipCollision");
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    assertPrivateFile(filePath, "new private file");
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    if (created && stableDirectory) try { fs.unlinkSync(filePath); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") error.cleanupCode = cleanupError.code; }
    throw error;
  }
}

function replacePrivate(filePath, content, label) {
  const before = assertPrivateFile(filePath, label);
  const directory = path.dirname(filePath);
  const directoryBefore = fs.lstatSync(directory);
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let created = false;
  try {
    writeExclusive(temporary, content);
    created = true;
    const current = assertPrivateFile(filePath, label);
    const directoryNow = fs.lstatSync(directory);
    if (current.dev !== before.dev || current.ino !== before.ino || directoryNow.dev !== directoryBefore.dev || directoryNow.ino !== directoryBefore.ino) throw coded(`${label} changed before publication`, "ownershipCollision");
    fs.renameSync(temporary, filePath);
  } finally {
    if (created) try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  assertPrivateFile(filePath, label);
}

function validateTimestamp(value) { return value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value); }
function validatePublicStatus(raw, identity) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== PUBLIC_FIELDS.length || PUBLIC_FIELDS.some((field) => !Object.hasOwn(raw, field))) throw new Error("invalid fields");
  if (raw.version !== 1 || raw.id !== identity.label || raw.name !== "local-search-freshness" || typeof raw.enabled !== "boolean") throw new Error("invalid identity");
  if (!new Set(["cheap_routing", "default_automation"]).has(raw.taskClass) || raw.complianceLane !== "unattended_local" || raw.scheduler !== "launchd" || !PUBLIC_PHASES.has(raw.phase)) throw new Error("invalid enum");
  if (![raw.lastHeartbeat, raw.lastRun, raw.nextReconciliationAt].every(validateTimestamp)) throw new Error("invalid timestamp");
  if (raw.lastStatus !== null && (typeof raw.lastStatus !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.lastStatus))) throw new Error("invalid last status");
  if (raw.errorCode !== null && !PUBLIC_ERROR_CODES.has(raw.errorCode)) throw new Error("invalid error code");
  return raw;
}

function writeStatus(identity, value) {
  assertSafeDirectory(identity.serviceDirectory, "service directory", { privateLeaf: true });
  const projected = projection(identity, value);
  const output = `${JSON.stringify(projected)}\n`;
  if (Buffer.byteLength(output) > MAX_PRIVATE_BYTES) throw coded("service status exceeds its bound", "heartbeatPublicationFailed");
  if (fs.existsSync(identity.statusPath)) replacePrivate(identity.statusPath, output, "service status");
  else writeExclusive(identity.statusPath, output);
  return projected;
}

function readStatus(identity) {
  try { return projection(identity, validatePublicStatus(JSON.parse(readBoundedPrivate(identity.statusPath, "service status")), identity)); }
  catch (error) { if (error.code === "ENOENT") return null; return projection(identity, { enabled: true, phase: "degraded", errorCode: "invalidStatus" }); }
}

function xml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
function plistFor(identity, configPath, node24) {
  const strings = [node24, identity.runnerPath, "--config", configPath].map((value) => `      <string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(identity.label)}</string>
  <key>ProgramArguments</key><array>
${strings}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>PathState</key><dict><key>${xml(identity.markerPath)}</key><true/></dict></dict>
  <key>ThrottleInterval</key><integer>30</integer><key>ProcessType</key><string>Background</string>
</dict></plist>
`;
}

function isExactPrintAbsence(error, target) {
  const match = /^gui\/(\d+)\/([^/]+)$/.exec(target);
  if (!match || error.status !== 113) return false;
  const expected = `Bad request.\nCould not find service "${match[2]}" in domain for user gui: ${match[1]}\n`;
  const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8") : error.stderr;
  return stderr === expected;
}

function defaultLaunchctl(execute = execFileSync) {
  const call = (args) => {
    try { execute("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000, maxBuffer: MAX_PRIVATE_BYTES }); return { ok: true }; }
    catch (error) { return { ok: false, errorCode: "launchctlFailed", status: Number.isInteger(error.status) ? error.status : null }; }
  };
  return {
    async print({ target }) {
      try {
        execute("/bin/launchctl", ["print", target], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000, maxBuffer: MAX_PRIVATE_BYTES });
        return { loaded: true };
      } catch (error) { return { loaded: isExactPrintAbsence(error, target) ? false : null }; }
    },
    async bootstrap({ domain, plistPath }) { return call(["bootstrap", domain, plistPath]); },
    async bootout({ target }) { return call(["bootout", target]); },
  };
}

function dependenciesFor(input = {}) {
  return {
    platform: input.platform || process.platform, uid: input.uid ?? currentUid(), launchctl: input.launchctl || defaultLaunchctl(input.execFileSync || execFileSync),
    now: input.now || Date.now, sleep: input.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    ackDeadlineMs: input.ackDeadlineMs || 5_000, ackPollIntervalMs: input.ackPollIntervalMs || 50,
    heartbeatFreshMs: input.heartbeatFreshMs, probeNode: input.probeNode, ...input,
  };
}

function validateNode24(node24, dependencies) {
  if (typeof node24 !== "string" || !path.isAbsolute(node24)) throw coded("--node24 must be an absolute path", "invalidRuntime");
  assertTrustedExecutable(node24, "Node 24 runtime");
  let version;
  if (dependencies.probeNode) version = dependencies.probeNode(node24);
  else try { version = execFileSync(node24, ["--version"], { encoding: "utf8", timeout: 5_000, maxBuffer: MAX_PRIVATE_BYTES }).trim(); } catch { throw coded("unable to execute Node 24 runtime", "invalidRuntime"); }
  if (!/^v24\./.test(String(version).trim())) throw coded("--node24 must report Node major version 24", "wrongRuntimeMajor");
}

function markerFor(identity, generation, acknowledgedGeneration = null) { return { version: 1, id: identity.label, launchGeneration: generation, acknowledgedGeneration }; }
function receiptFor(identity, configPath, node24, plist, generation) {
  return {
    version: 1, id: identity.label, configPath, node24, launchGeneration: generation, runnerPath: identity.runnerPath,
    plistPath: identity.plistPath, markerPath: identity.markerPath, statusPath: identity.statusPath,
    plistSha256: crypto.createHash("sha256").update(plist).digest("hex"),
  };
}

function readMarker(identity) {
  const marker = JSON.parse(readBoundedPrivate(identity.markerPath, "service marker"));
  if (!marker || marker.version !== 1 || marker.id !== identity.label || typeof marker.launchGeneration !== "string" || !/^[a-f0-9-]{36}$/.test(marker.launchGeneration)) throw coded("service marker is malformed", "ownershipCollision");
  if (marker.acknowledgedGeneration !== null && marker.acknowledgedGeneration !== marker.launchGeneration) throw coded("service marker acknowledgement does not match", "ownershipCollision");
  return marker;
}

function validateReceipt(identity, expected = {}, options = {}) {
  const receipt = JSON.parse(readBoundedPrivate(identity.receiptPath, "service receipt"));
  const fixed = { version: 1, id: identity.label, runnerPath: identity.runnerPath, plistPath: identity.plistPath, markerPath: identity.markerPath, statusPath: identity.statusPath, ...expected };
  for (const [key, value] of Object.entries(fixed)) if (receipt[key] !== value) throw coded(`service receipt ${key} does not match`, "ownershipCollision");
  if (typeof receipt.launchGeneration !== "string" || !/^[a-f0-9-]{36}$/.test(receipt.launchGeneration)) throw coded("service receipt generation is malformed", "ownershipCollision");
  if (typeof receipt.node24 !== "string" || !path.isAbsolute(receipt.node24)) throw coded("service receipt runtime is malformed", "ownershipCollision");
  const hash = crypto.createHash("sha256").update(readBoundedPrivate(identity.plistPath, "service plist")).digest("hex");
  if (receipt.plistSha256 !== hash) throw coded("service plist does not match its receipt", "ownershipCollision");
  if (options.requireReadiness) {
    assertTrustedExecutable(receipt.node24, "Node 24 runtime");
    assertTrustedReadableCode(receipt.runnerPath, "service runner");
  }
  if (fs.existsSync(identity.markerPath)) {
    if (readMarker(identity).launchGeneration !== receipt.launchGeneration) throw coded("service marker generation does not match", "ownershipCollision");
  } else if (options.requireMarker) throw coded("service marker is missing", "ownershipCollision");
  return receipt;
}

function acknowledgeLaunch(identity, receipt) {
  const marker = readMarker(identity);
  if (marker.launchGeneration !== receipt.launchGeneration) throw coded("service launch generation does not match", "ownershipCollision");
  replacePrivate(identity.markerPath, `${JSON.stringify(markerFor(identity, receipt.launchGeneration, receipt.launchGeneration))}\n`, "service marker");
}

function disabled(identity, errorCode = null) { return projection(identity, { enabled: false, phase: "disabled", taskClass: "cheap_routing", errorCode }); }

async function waitForAck(identity, dependencies, generation, launchedAt, target) {
  const deadline = launchedAt + dependencies.ackDeadlineMs;
  do {
    const registration = await dependencies.launchctl.print({ target, identity });
    let marker; try { marker = readMarker(identity); } catch { marker = null; }
    const current = readStatus(identity);
    const heartbeat = current && Date.parse(current.lastHeartbeat);
    const now = dependencies.now();
    const freshLaunch = Number.isFinite(heartbeat) && heartbeat >= launchedAt && heartbeat <= now + MAX_CLOCK_SKEW_MS;
    const healthy = current && ((current.errorCode === null && HEALTHY_ACK_PHASES.has(current.phase)) || (current.phase === "paused" && current.errorCode === "resourcePaused"));
    if (registration.loaded && marker && marker.launchGeneration === generation && marker.acknowledgedGeneration === generation && current.enabled && freshLaunch && healthy) return current;
    await dependencies.sleep(dependencies.ackPollIntervalMs);
  } while (dependencies.now() <= deadline);
  return null;
}

async function verifyStopped(identity, dependencies, target) {
  const deadline = dependencies.now() + dependencies.ackDeadlineMs;
  do {
    if ((await dependencies.launchctl.print({ target, identity })).loaded === false) return true;
    await dependencies.sleep(dependencies.ackPollIntervalMs);
  } while (dependencies.now() <= deadline);
  return false;
}

async function enable(options, inputDependencies = {}) {
  const config = loadConfig(options.configPath);
  const dependencies = dependenciesFor(inputDependencies);
  const identity = deriveIdentity(options.configPath, config, dependencies);
  if (!config.enabled) throw coded("configuration is disabled", "configurationDisabled");
  if (dependencies.platform !== "darwin") throw coded("persistent freshness is available only for macOS logged-in users", "unsupportedPlatform");
  if (options.confirm !== true) throw coded("enable requires --confirm", "confirmationRequired");
  validateNode24(options.node24, dependencies);
  assertTrustedReadableCode(identity.runnerPath, "service runner");
  prepareDirectories(config, identity);
  const domain = `gui/${dependencies.uid}`;
  const target = `${domain}/${identity.label}`;
  const receiptExists = fs.existsSync(identity.receiptPath);
  const artifactsExist = [identity.plistPath, identity.markerPath].some((item) => fs.existsSync(item));
  if (!receiptExists && artifactsExist) throw coded("service path already exists without an owned receipt", "ownershipCollision");
  let receipt = receiptExists ? validateReceipt(identity, { configPath: options.configPath, node24: options.node24 }, { requireReadiness: true }) : null;
  const registration = await dependencies.launchctl.print({ target, identity });
  if (registration.loaded !== true && registration.loaded !== false) throw coded("launchctl registration state is unknown", "registrationUnknown");
  if (registration.loaded === true && !receipt) throw coded("launchd label is already registered without an owned receipt", "ownershipCollision");
  if (registration.loaded === true) {
    const freshWindow = dependencies.heartbeatFreshMs || Math.max(config.budgets.pollIntervalMs * 3, 60_000);
    const current = await waitForAck(identity, dependencies, receipt.launchGeneration, dependencies.now() - freshWindow, target);
    if (current) return current;
    throw coded("owned registration did not acknowledge startup", "startupAckTimeout");
  }

  const generation = crypto.randomUUID();
  const launchedAt = dependencies.now();
  const plist = plistFor(identity, options.configPath, options.node24);
  const created = [];
  try {
    if (!receiptExists) {
      writeExclusive(identity.plistPath, plist); created.push(identity.plistPath);
      receipt = receiptFor(identity, options.configPath, options.node24, plist, generation);
      writeExclusive(identity.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`); created.push(identity.receiptPath);
      writeExclusive(identity.markerPath, `${JSON.stringify(markerFor(identity, generation))}\n`); created.push(identity.markerPath);
    } else {
      receipt = { ...receipt, launchGeneration: generation };
      replacePrivate(identity.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "service receipt");
      if (fs.existsSync(identity.markerPath)) replacePrivate(identity.markerPath, `${JSON.stringify(markerFor(identity, generation))}\n`, "service marker");
      else { writeExclusive(identity.markerPath, `${JSON.stringify(markerFor(identity, generation))}\n`); created.push(identity.markerPath); }
    }
    const bootstrapped = await dependencies.launchctl.bootstrap({ domain, plistPath: identity.plistPath, identity });
    if (!bootstrapped.ok) throw coded("launchctl bootstrap failed", "registrationFailed");
    const acknowledged = await waitForAck(identity, dependencies, generation, launchedAt, target);
    if (!acknowledged) throw coded("registered service did not acknowledge startup", "startupAckTimeout");
    return acknowledged;
  } catch (error) {
    const stopped = await dependencies.launchctl.bootout({ target, identity });
    const verified = stopped.ok && await verifyStopped(identity, dependencies, target);
    if (!verified) throw coded("service rollback could not verify process termination", "rollbackIncomplete", { causeCode: error.code || "serviceFailed" });
    for (const filePath of created.reverse()) {
      try { assertPrivateFile(filePath, "created service artifact"); fs.unlinkSync(filePath); }
      catch (cleanupError) { if (cleanupError.code !== "ENOENT") throw coded("service rollback could not remove owned artifacts", "rollbackIncomplete", { causeCode: error.code || "serviceFailed" }); }
    }
    throw error;
  }
}

async function status(options, inputDependencies = {}) {
  const config = loadConfig(options.configPath);
  const dependencies = dependenciesFor(inputDependencies);
  const identity = deriveIdentity(options.configPath, config, dependencies);
  if (!config.enabled) return disabled(identity, "configurationDisabled");
  if (!fs.existsSync(identity.receiptPath)) return projection(identity, { phase: "offline", taskClass: "cheap_routing", errorCode: "serviceNotEnabled" });
  let receipt;
  try { receipt = validateReceipt(identity, { configPath: options.configPath }, { requireMarker: true }); }
  catch (error) { return projection(identity, { enabled: true, phase: "degraded", taskClass: "cheap_routing", errorCode: error.code || "ownershipCollision" }); }
  const marker = readMarker(identity);
  if (marker.acknowledgedGeneration !== receipt.launchGeneration) return projection(identity, { enabled: true, phase: "degraded", taskClass: "cheap_routing", errorCode: "missingHeartbeat" });
  const domain = `gui/${dependencies.uid}`;
  const registration = await dependencies.launchctl.print({ target: `${domain}/${identity.label}`, identity });
  if (registration.loaded !== true && registration.loaded !== false) return projection(identity, { enabled: true, phase: "degraded", taskClass: "cheap_routing", errorCode: "registrationUnknown" });
  if (registration.loaded === false) return projection(identity, { enabled: true, phase: "offline", taskClass: "cheap_routing", errorCode: "registrationMissing" });
  const current = readStatus(identity);
  if (!current) return projection(identity, { enabled: true, phase: "degraded", taskClass: "cheap_routing", errorCode: "missingHeartbeat" });
  const heartbeat = Date.parse(current.lastHeartbeat);
  const freshFor = dependencies.heartbeatFreshMs || Math.max(config.budgets.pollIntervalMs * 3, 60_000);
  const age = dependencies.now() - heartbeat;
  if (!Number.isFinite(heartbeat)) return projection(identity, { ...current, enabled: true, taskClass: "cheap_routing", phase: "degraded", errorCode: "invalidStatus" });
  if (age < -MAX_CLOCK_SKEW_MS) return projection(identity, { ...current, enabled: true, taskClass: "cheap_routing", phase: "degraded", errorCode: "futureHeartbeat" });
  if (age > freshFor) return projection(identity, { ...current, enabled: true, taskClass: "cheap_routing", phase: "degraded", errorCode: "staleHeartbeat" });
  return projection(identity, { ...current, enabled: true, taskClass: "cheap_routing" });
}

async function disable(options, inputDependencies = {}) {
  const config = loadConfig(options.configPath);
  const dependencies = dependenciesFor(inputDependencies);
  const identity = deriveIdentity(options.configPath, config, dependencies);
  const receiptExists = fs.existsSync(identity.receiptPath);
  const otherArtifactsExist = [identity.plistPath, identity.markerPath].some((item) => fs.existsSync(item));
  if (receiptExists || otherArtifactsExist) {
    assertSafeDirectory(config.stateDirectory, "state directory", { privateLeaf: true });
    assertSafeDirectory(identity.serviceDirectory, "service directory", { privateLeaf: true });
    assertSafeDirectory(identity.launchAgentsDirectory, "LaunchAgents directory");
  }
  if (!receiptExists) {
    if (otherArtifactsExist) throw coded("refusing to disable unowned service artifacts", "ownershipCollision");
    return disabled(identity);
  }
  validateReceipt(identity, { configPath: options.configPath });
  const target = `gui/${dependencies.uid}/${identity.label}`;
  const registration = await dependencies.launchctl.print({ target, identity });
  if (registration.loaded) {
    const stopped = await dependencies.launchctl.bootout({ target, identity });
    if (!stopped.ok) throw coded("launchctl bootout failed", "stopVerificationFailed");
  }
  if (!await verifyStopped(identity, dependencies, target)) throw coded("service stop could not be verified", "stopVerificationFailed");
  if (fs.existsSync(identity.markerPath)) { assertPrivateFile(identity.markerPath, "service marker"); fs.unlinkSync(identity.markerPath); }
  assertPrivateFile(identity.plistPath, "service plist"); fs.unlinkSync(identity.plistPath);
  assertPrivateFile(identity.receiptPath, "service receipt"); fs.unlinkSync(identity.receiptPath);
  return writeStatus(identity, { enabled: false, taskClass: "cheap_routing", phase: "disabled", lastHeartbeat: new Date(dependencies.now()).toISOString(), errorCode: null });
}

module.exports = { PUBLIC_FIELDS, acknowledgeLaunch, defaultLaunchctl, deriveIdentity, disable, enable, operationError, plistFor, projection, readMarker, readStatus, safeErrorCode, status, validateReceipt, writeStatus };

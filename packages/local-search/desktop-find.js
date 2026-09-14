"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const TASK_CLASS = "cheap_routing";
const COMPLIANCE_LANE = "unattended_local";
const USAGE = "myos-find --settings ABSOLUTE <status|search> [--query QUERY] [--mode native|semantic|filename|keyword|auto] [--roots IDS] [--max-results N] [--max-bytes N] [--context-bytes N]";
const MAX_SETTINGS_BYTES = 16_384;
const SETTINGS_FIELDS = new Set(["version", "enabled", "node24", "configPath", "exportToAssistant"]);
const MODES = new Set(["native", "semantic", "filename", "keyword", "auto"]);
const LOCAL_SEARCH_WRAPPER = path.resolve(__dirname, "../../bin/myos-local-search.js");
const DEFAULT_CONTEXT_BYTES = 4096;
const DEFAULT_MAX_RESULTS = 3;
const DEFAULT_MAX_BYTES = 1024;
const SEARCH_TIMEOUT_MS = 10_000;
const CLEANUP_GRACE_MS = 1_000;

function response(status, taskClass = TASK_CLASS) {
  return { ok: false, status, taskClass, complianceLane: COMPLIANCE_LANE };
}

function isNormalizedAbsolute(value) {
  return typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeSettingsMetadata(stat, expectedUid) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === expectedUid
    && (stat.mode & 0o177) === 0 && (stat.mode & 0o400) !== 0 && stat.size <= MAX_SETTINGS_BYTES;
}

function hasSafeAncestry(filePath, expectedUid) {
  let current = path.dirname(filePath);
  while (true) {
    let stat;
    try { stat = fs.lstatSync(current); } catch { return false; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const writable = (stat.mode & 0o022) !== 0;
    const protectedShared = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (stat.uid !== expectedUid && stat.uid !== 0) return false;
    if (writable && !protectedShared) return false;
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { help: true };
  if (argv[0] !== "--settings" || !argv[1] || !isNormalizedAbsolute(argv[1])) return { error: "invalidArguments" };
  const operation = argv[2];
  if (operation !== "status" && operation !== "search") return { error: "operationDenied" };
  const values = {};
  const allowed = new Set(["--query", "--roots", "--mode", "--max-results", "--max-bytes", "--context-bytes"]);
  for (let index = 3; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!allowed.has(flag) || index + 1 >= argv.length || Object.hasOwn(values, flag)) return { error: "invalidArguments" };
    values[flag] = argv[index + 1];
  }
  if (operation === "status" && Object.keys(values).length !== 0) return { error: "invalidArguments" };
  if (operation === "search" && (typeof values["--query"] !== "string" || values["--query"].trim().length === 0 || values["--query"].length > 1000)) {
    return { error: "invalidArguments" };
  }
  const mode = values["--mode"] || "auto";
  if (!MODES.has(mode)) return { error: "invalidArguments" };
  const bounds = [["--max-results", 1, 8], ["--max-bytes", 1, 65_536], ["--context-bytes", 512, 16_384]];
  const numbers = {};
  for (const [flag, minimum, maximum] of bounds) {
    if (values[flag] === undefined) continue;
    const number = Number(values[flag]);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) return { error: "invalidArguments" };
    numbers[flag] = number;
  }
  let roots;
  if (values["--roots"] !== undefined) {
    roots = values["--roots"].split(",");
    if (roots.length === 0 || roots.length > 16 || new Set(roots).size !== roots.length
      || roots.some((root) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(root))) return { error: "invalidArguments" };
  }
  return { settingsPath: argv[1], operation, query: values["--query"]?.trim(), mode, roots, numbers };
}

function loadSettings(settingsPath) {
  let before;
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  try {
    before = fs.lstatSync(settingsPath);
    const uid = expectedUid === null ? before.uid : expectedUid;
    if (!safeSettingsMetadata(before, uid) || !hasSafeAncestry(settingsPath, uid)) return { error: "unsafeSettings" };
  } catch (error) {
    return { error: error?.code === "ENOENT" ? "missingSettings" : "unsafeSettings" };
  }
  let descriptor;
  try {
    descriptor = fs.openSync(settingsPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch { return { error: "unsafeSettings" }; }
  let result = { error: "unsafeSettings" };
  try {
    const first = fs.fstatSync(descriptor);
    if (!sameIdentity(before, first) || first.size > MAX_SETTINGS_BYTES) return result;
    const buffer = Buffer.allocUnsafe(MAX_SETTINGS_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    const after = fs.fstatSync(descriptor);
    let leafAfter;
    try { leafAfter = fs.lstatSync(settingsPath); } catch { return result; }
    if (bytesRead > MAX_SETTINGS_BYTES || !sameIdentity(first, after) || !sameIdentity(first, leafAfter)
      || !safeSettingsMetadata(after, first.uid) || !safeSettingsMetadata(leafAfter, first.uid)
      || first.size !== after.size || after.size !== bytesRead
      || first.mode !== after.mode || first.mode !== leafAfter.mode) return result;
    const parsed = JSON.parse(buffer.toString("utf8", 0, bytesRead));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).length !== SETTINGS_FIELDS.size
      || Object.keys(parsed).some((key) => !SETTINGS_FIELDS.has(key))
      || parsed.version !== 1 || typeof parsed.enabled !== "boolean"
      || typeof parsed.exportToAssistant !== "boolean"
      || !isNormalizedAbsolute(parsed.node24) || !isNormalizedAbsolute(parsed.configPath)) {
      return { error: "invalidSettings" };
    }
    result = { settings: parsed };
  } catch {
    result = { error: "invalidSettings" };
  } finally {
    try { fs.closeSync(descriptor); } catch { result = { error: "unsafeSettings" }; }
  }
  return result;
}

function inspectFile(filePath, kind) {
  if (!isNormalizedAbsolute(filePath)) return false;
  try {
    const stat = fs.lstatSync(filePath);
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !hasSafeAncestry(filePath, expectedUid)) return false;
    if (kind === "runtime") return (stat.mode & 0o111) !== 0 && (stat.mode & 0o022) === 0;
    return stat.uid === expectedUid && (stat.mode & 0o077) === 0 && (stat.mode & 0o400) !== 0;
  } catch { return false; }
}

function fixedWrapperAvailable() {
  try {
    const stat = fs.lstatSync(LOCAL_SEARCH_WRAPPER);
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
      && (stat.mode & 0o022) === 0 && hasSafeAncestry(LOCAL_SEARCH_WRAPPER, expectedUid);
  } catch { return false; }
}

function searchArgs(parsed, settings) {
  const args = [
    LOCAL_SEARCH_WRAPPER,
    "--node24", settings.node24,
    "search", "--config", settings.configPath,
    "--query", parsed.query,
    "--mode", parsed.mode,
  ];
  if (parsed.roots) args.push("--roots", parsed.roots.join(","));
  args.push("--max-results", String(parsed.numbers["--max-results"] || DEFAULT_MAX_RESULTS));
  args.push("--max-bytes", String(parsed.numbers["--max-bytes"] || DEFAULT_MAX_BYTES));
  return args;
}

function taskClassFor(mode) {
  return mode === "semantic" || mode === "auto" ? "default_automation" : TASK_CLASS;
}

function runSearch(parsed, settings, adapters = {}) {
  const launch = adapters.spawn || spawn;
  const timeoutMs = adapters.timeoutMs || SEARCH_TIMEOUT_MS;
  const cleanupGraceMs = adapters.cleanupGraceMs || CLEANUP_GRACE_MS;
  const contextBytes = parsed.numbers["--context-bytes"] || DEFAULT_CONTEXT_BYTES;
  const taskClass = taskClassFor(parsed.mode);
  return new Promise((resolve) => {
    let child;
    try {
      child = launch(process.execPath, searchArgs(parsed, settings), {
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      });
    } catch { resolve(response("spawnFailed", taskClass)); return; }
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let overflow = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let stopping = false;
    let cleanupTimer;
    let drainTimer;
    let closeCode;
    let childClosed = false;
    let stdoutDrained = !child.stdout;
    let stderrDrained = !child.stderr;
    const resultAfterDrain = () => {
      if (overflow) return response("budgetExceeded", taskClass);
      if (timedOut) return response("timedOut", taskClass);
      if (cancelled) return response("cancelled", taskClass);
      if (stderrBytes > 4096 || closeCode !== 0) return response("searchFailed", taskClass);
      let value;
      try { value = JSON.parse(stdout.toString("utf8")); } catch { return response("invalidSearchOutput", taskClass); }
      if (!value || typeof value !== "object" || Array.isArray(value)) return response("invalidSearchOutput", taskClass);
      const result = { ...value, taskClass, complianceLane: COMPLIANCE_LANE };
      return Buffer.byteLength(`${JSON.stringify(result)}\n`) > contextBytes ? response("budgetExceeded", taskClass) : result;
    };
    const maybeFinish = () => {
      if (childClosed && stdoutDrained && stderrDrained) finish(resultAfterDrain());
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(cleanupTimer);
      clearTimeout(drainTimer);
      process.removeListener("SIGINT", onCancel);
      process.removeListener("SIGTERM", onCancel);
      resolve(value);
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      const signalGroup = (signal) => {
        if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return false;
        try {
          if (adapters.killProcessGroup) adapters.killProcessGroup(child.pid, signal);
          else process.kill(-child.pid, signal);
          return true;
        } catch { return false; }
      };
      signalGroup("SIGTERM");
      cleanupTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        drainTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(resultAfterDrain());
        }, cleanupGraceMs);
        drainTimer.unref?.();
      }, cleanupGraceMs);
      cleanupTimer.unref?.();
    };
    const onCancel = () => { cancelled = true; stop(); };
    process.once("SIGINT", onCancel);
    process.once("SIGTERM", onCancel);
    const timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    timeout.unref?.();
    child.stdout?.on("data", (chunk) => {
      if (overflow) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stdout.length + value.length > contextBytes) {
        overflow = true;
        stdout = Buffer.alloc(0);
        stop();
      } else stdout = Buffer.concat([stdout, value]);
    });
    child.stdout?.once("end", () => { stdoutDrained = true; maybeFinish(); });
    child.stderr?.on("data", (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > 4096) stop();
    });
    child.stderr?.once("end", () => { stderrDrained = true; maybeFinish(); });
    child.once("error", () => finish(response("spawnFailed", taskClass)));
    child.once("close", (code) => {
      closeCode = code;
      childClosed = true;
      maybeFinish();
    });
  });
}

function help() {
  return { ok: true, status: "help", taskClass: TASK_CLASS, complianceLane: COMPLIANCE_LANE, usage: USAGE };
}

async function main(argv = process.argv.slice(2)) {
  const result = await execute(argv);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

async function execute(argv = process.argv.slice(2), adapters = {}) {
  const parsed = parseArgs(argv);
  if (parsed.help) return help();
  if (parsed.error) return response(parsed.error);
  const loaded = loadSettings(parsed.settingsPath);
  if (loaded.error) return response(loaded.error);
  const settings = loaded.settings;
  if (parsed.operation === "status") {
    const optedIn = settings.enabled && settings.exportToAssistant;
    const runtimeAvailable = optedIn && inspectFile(settings.node24, "runtime");
    const configAvailable = optedIn && inspectFile(settings.configPath, "config");
    return {
      ok: true,
      status: !settings.enabled ? "disabled"
        : !settings.exportToAssistant ? "notOptedIn"
        : runtimeAvailable && configAvailable ? "available" : "unavailable",
      taskClass: TASK_CLASS,
      complianceLane: COMPLIANCE_LANE,
      enabled: settings.enabled,
      exportToAssistant: settings.exportToAssistant,
      runtimeAvailable,
      configAvailable,
    };
  }
  if (!settings.enabled) return response("disabled");
  if (!settings.exportToAssistant) return response("notOptedIn");
  const runtimeAvailable = inspectFile(settings.node24, "runtime");
  const configAvailable = inspectFile(settings.configPath, "config");
  if (!runtimeAvailable) return response("unsafeRuntime");
  if (!configAvailable) return response("unsafeConfig");
  if (!fixedWrapperAvailable()) return response("unsafeSearchBoundary");
  return runSearch(parsed, settings, adapters);
}

module.exports = { execute, fixedWrapperAvailable, help, inspectFile, loadSettings, main, parseArgs, runSearch, searchArgs, taskClassFor };

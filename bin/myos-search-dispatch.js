#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TASK_CLASS = "cheap_routing";
const COMPLIANCE_LANE = "unattended_local";
const USAGE = "myos-search-dispatch --dispatch-root ABSOLUTE_PATH --settings ABSOLUTE_PATH <describe|status|open>";
const OPERATIONS = new Set(["describe", "status", "open"]);
const SETTINGS_FIELDS = new Set(["version", "enabled", "node24", "configPath"]);
const DISPATCH_FILES = Object.freeze([
  "src/workspace-context.js",
  "src/capability-router.js",
]);
const LAUNCHER_PATH = path.resolve(__dirname, "myos-search.js");
const CAPABILITY_ID = "local:search-launcher";
const FIXED_CAPABILITY = Object.freeze({
  id: CAPABILITY_ID,
  type: "tool",
  execution_lane: "worker_skill",
  source_path: "bin/myos-search.js",
  aliases: Object.freeze(["local search describe", "local search status", "open local search"]),
  use_when: Object.freeze(["local search describe", "local search status", "open local search"]),
  description: "Explicit local launcher",
  avoid_when: Object.freeze(["content export"]),
  priority: 40,
});
const OPERATION_PHRASES = Object.freeze({
  describe: "local search describe",
  status: "local search status",
  open: "open local search",
});
const LOCAL_STATUS_VALUES = new Set(["disabled", "notStarted", "partial", "passive", "degraded", "runtimeUnavailable", "statusUnavailable", "malformedStatus"]);
const MAX_SETTINGS_BYTES = 16_384;

function response(status, extra = {}) {
  return { ok: false, status, taskClass: TASK_CLASS, complianceLane: COMPLIANCE_LANE, ...extra };
}

function success(status, extra) {
  return { ok: true, status, taskClass: TASK_CLASS, complianceLane: COMPLIANCE_LANE, ...extra };
}

function isNormalizedAbsolute(value) {
  return typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value;
}

function isRegularNonSymlink(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync(filePath) === filePath;
  } catch {
    return false;
  }
}

function validateDispatchRoot(dispatchRoot) {
  try {
    const stat = fs.lstatSync(dispatchRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dispatchRoot) !== dispatchRoot) return false;
  } catch {
    return false;
  }
  return DISPATCH_FILES.every((relativePath) => isRegularNonSymlink(path.join(dispatchRoot, relativePath)));
}

function validateSettingsPaths(settings, operation) {
  if (operation === "describe") return true;
  if (!isRegularNonSymlink(settings.node24) || !isRegularNonSymlink(settings.configPath)) return false;
  try {
    return (fs.statSync(settings.node24).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function loadRouting(dispatchRoot) {
  const { resolveDispatchPlan } = require(path.join(dispatchRoot, "src/workspace-context.js"));
  const { CAPABILITIES_INDEX_PATH, loadCapabilityIndex } = require(path.join(dispatchRoot, "src/capability-router.js"));
  if (typeof resolveDispatchPlan !== "function" || typeof loadCapabilityIndex !== "function"
    || !isNormalizedAbsolute(CAPABILITIES_INDEX_PATH)) {
    throw new Error("invalid routing exports");
  }
  return { capabilitiesIndexPath: CAPABILITIES_INDEX_PATH, loadCapabilityIndex, resolveDispatchPlan };
}

function loadBaseline(routing) {
  if (!isNormalizedAbsolute(routing.capabilitiesIndexPath)) throw new Error("invalid capability index authority");
  const authority = JSON.parse(fs.readFileSync(routing.capabilitiesIndexPath, "utf8"));
  if (!authority || typeof authority !== "object" || !Array.isArray(authority.capabilities)) {
    throw new Error("invalid capability index");
  }
  const baseline = routing.loadCapabilityIndex();
  if (!baseline || typeof baseline !== "object" || !Array.isArray(baseline.capabilities)) {
    throw new Error("invalid capability index");
  }
  return baseline;
}

function privateTempBase(settingsPath) {
  const settingsParent = path.dirname(settingsPath);
  try {
    const stat = fs.lstatSync(settingsParent);
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === expectedUid && (stat.mode & 0o077) === 0) {
      return settingsParent;
    }
  } catch {}
  const temporary = fs.realpathSync(os.tmpdir());
  const stat = fs.lstatSync(temporary);
  if (!path.isAbsolute(temporary) || path.normalize(temporary) !== temporary || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("unsafe temporary directory");
  }
  return temporary;
}

function createOverlay(settingsPath, baseline) {
  const directory = fs.mkdtempSync(path.join(privateTempBase(settingsPath), "myos-search-dispatch-"));
  fs.chmodSync(directory, 0o700);
  const directoryStat = fs.lstatSync(directory);
  const indexPath = path.join(directory, "capabilities-index.json");
  try {
    fs.writeFileSync(indexPath, `${JSON.stringify({
      ...baseline,
      capabilities: [...baseline.capabilities, FIXED_CAPABILITY],
    })}\n`, { flag: "wx", mode: 0o600 });
    const fileStat = fs.lstatSync(indexPath);
    return {
      directory,
      directoryIdentity: { dev: directoryStat.dev, ino: directoryStat.ino },
      indexPath,
      fileIdentity: { dev: fileStat.dev, ino: fileStat.ino },
    };
  } catch (error) {
    try {
      let indexMissing = false;
      try {
        const fileStat = fs.lstatSync(indexPath);
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("cleanup failed");
        fs.unlinkSync(indexPath);
      } catch (cleanupError) {
        if (cleanupError && cleanupError.code === "ENOENT") indexMissing = true;
        else throw cleanupError;
      }
      if (!indexMissing && fs.existsSync(indexPath)) throw new Error("cleanup failed");
      const currentDirectoryStat = fs.lstatSync(directory);
      if (!currentDirectoryStat.isDirectory() || currentDirectoryStat.isSymbolicLink()
        || !sameIdentity(currentDirectoryStat, { dev: directoryStat.dev, ino: directoryStat.ino })
        || fs.readdirSync(directory).length !== 0) {
        throw new Error("cleanup failed");
      }
      fs.rmdirSync(directory);
      if (fs.existsSync(directory)) throw new Error("cleanup failed");
    } catch {
      const cleanupFailure = new Error("cleanup failed");
      cleanupFailure.code = "CLEANUP_FAILED";
      throw cleanupFailure;
    }
    throw error;
  }
}

function sameIdentity(stat, identity) {
  return stat.dev === identity.dev && stat.ino === identity.ino;
}

function cleanupOverlay(overlay) {
  if (!overlay) return;
  let fileMissing = false;
  try {
    const fileStat = fs.lstatSync(overlay.indexPath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || !sameIdentity(fileStat, overlay.fileIdentity)) {
      throw new Error("cleanup failed");
    }
    fs.unlinkSync(overlay.indexPath);
  } catch (error) {
    if (error && error.code === "ENOENT") fileMissing = true;
    else throw new Error("cleanup failed");
  }
  if (!fileMissing && fs.existsSync(overlay.indexPath)) throw new Error("cleanup failed");

  let directoryMissing = false;
  try {
    const directoryStat = fs.lstatSync(overlay.directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
      || !sameIdentity(directoryStat, overlay.directoryIdentity)
      || fs.readdirSync(overlay.directory).length !== 0) {
      throw new Error("cleanup failed");
    }
    fs.rmdirSync(overlay.directory);
  } catch (error) {
    if (error && error.code === "ENOENT") directoryMissing = true;
    else throw new Error("cleanup failed");
  }
  if (!directoryMissing && fs.existsSync(overlay.directory)) throw new Error("cleanup failed");
}

function selectedFixedCapability(plan) {
  const top = plan?.route?.candidates?.[0];
  const topId = top?.capability?.id || top?.id || null;
  return plan?.branch === "capability"
    && plan?.capabilityId === CAPABILITY_ID
    && plan?.route?.lane === "worker_skill"
    && topId === CAPABILITY_ID;
}

function childArgs(operation, settings) {
  const args = [LAUNCHER_PATH, operation];
  if (operation !== "describe") args.push("--node24", settings.node24, "--config", settings.configPath);
  return args;
}

function validatedLauncherOutput(operation, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (operation === "describe") {
    const expectedCommands = ["describe", "status", "open"];
    if (value.id !== "local-search" || value.version !== 1 || value.optional !== true
      || value.taskClass !== TASK_CLASS || value.resultExport !== "none/local_ui_only"
      || value.automaticRouting !== false || value.entrypoint !== "myos-search"
      || value.localInterface !== "native_terminal"
      || !Array.isArray(value.commands) || value.commands.length !== expectedCommands.length
      || value.commands.some((command, index) => command !== expectedCommands[index])) return null;
    return success("described", { descriptor: {
      id: value.id,
      version: value.version,
      optional: value.optional,
      taskClass: value.taskClass,
      commands: [...value.commands],
      resultExport: value.resultExport,
      automaticRouting: value.automaticRouting,
      entrypoint: value.entrypoint,
      localInterface: value.localInterface,
    } });
  }
  if (operation === "status") {
    if (typeof value.installed !== "boolean" || typeof value.runtimeReady !== "boolean"
      || typeof value.enabled !== "boolean" || typeof value.localUiAvailable !== "boolean"
      || !LOCAL_STATUS_VALUES.has(value.status)) return null;
    return success("statusRead", { localSearchStatus: {
      installed: value.installed,
      runtimeReady: value.runtimeReady,
      enabled: value.enabled,
      localUiAvailable: value.localUiAvailable,
      status: value.status,
    } });
  }
  if (operation === "open" && value.ok === true && value.status === "launchRequested") {
    return success("openRequested", { openAck: { ok: true, status: "launchRequested" } });
  }
  return null;
}

function runLauncher(operation, settings, adapters) {
  const run = adapters.runProcess || ((command, args, options) => spawnSync(command, args, options));
  let child;
  try {
    child = run(process.execPath, childArgs(operation, settings), {
      encoding: "utf8",
      shell: false,
      timeout: 10_000,
      maxBuffer: 16_384,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
  } catch {
    return response("launcherFailed");
  }
  if (!child || child.error || child.status !== 0 || typeof child.stdout !== "string" || child.stdout.length > 16_384) {
    return response("launcherFailed");
  }
  let parsed;
  try {
    parsed = JSON.parse(child.stdout.trim());
  } catch {
    return response("invalidLauncherOutput");
  }
  return validatedLauncherOutput(operation, parsed) || response("invalidLauncherOutput");
}

function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { help: true };
  if (argv.length !== 5) return { error: "invalidArguments" };
  const operation = argv[4];
  if (!OPERATIONS.has(operation)) {
    return { error: /^[a-z]+$/i.test(operation || "") ? "operationDenied" : "invalidArguments" };
  }
  const values = {};
  for (let index = 0; index < 4; index += 2) {
    const flag = argv[index];
    if ((flag !== "--dispatch-root" && flag !== "--settings") || Object.hasOwn(values, flag)) {
      return { error: "invalidArguments" };
    }
    values[flag] = argv[index + 1];
  }
  if (!isNormalizedAbsolute(values["--dispatch-root"]) || !isNormalizedAbsolute(values["--settings"])) {
    return { error: "invalidArguments" };
  }
  return {
    dispatchRoot: values["--dispatch-root"],
    settingsPath: values["--settings"],
    operation,
  };
}

function loadSettings(settingsPath) {
  let descriptor;
  try {
    descriptor = fs.openSync(settingsPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    return { error: error && error.code === "ENOENT" ? "missingSettings" : "unsafeSettings" };
  }
  let result;
  try {
    const stat = fs.fstatSync(descriptor);
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.uid !== expectedUid || (stat.mode & 0o077) !== 0 || stat.size > MAX_SETTINGS_BYTES) {
      result = { error: "unsafeSettings" };
    } else {
      const contents = Buffer.allocUnsafe(MAX_SETTINGS_BYTES);
      let bytesRead = 0;
      while (bytesRead < contents.length) {
        const count = fs.readSync(descriptor, contents, bytesRead, contents.length - bytesRead, null);
        if (count === 0) break;
        bytesRead += count;
      }
      const overflow = Buffer.allocUnsafe(1);
      if (bytesRead === MAX_SETTINGS_BYTES && fs.readSync(descriptor, overflow, 0, 1, null) !== 0) {
        result = { error: "unsafeSettings" };
      } else {
        const parsed = JSON.parse(contents.toString("utf8", 0, bytesRead));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
          || Object.keys(parsed).some((key) => !SETTINGS_FIELDS.has(key))
          || parsed.version !== 1 || typeof parsed.enabled !== "boolean") {
          result = { error: "invalidSettings" };
        } else if (parsed.enabled !== true) {
          result = { error: "disabled" };
        } else if (!isNormalizedAbsolute(parsed.node24) || !isNormalizedAbsolute(parsed.configPath)) {
          result = { error: "invalidSettings" };
        } else {
          result = { settings: parsed };
        }
      }
    }
  } catch {
    result = { error: "invalidSettings" };
  }
  try {
    fs.closeSync(descriptor);
  } catch {
    return { error: "unsafeSettings" };
  }
  return result;
}

function help() {
  return {
    ok: true,
    status: "help",
    taskClass: TASK_CLASS,
    complianceLane: COMPLIANCE_LANE,
    usage: USAGE,
  };
}

function main(argv = process.argv.slice(2)) {
  const result = execute(argv);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok === false ? 1 : 0;
}

function execute(argv = process.argv.slice(2), adapters = {}) {
  const parsed = parseArgs(argv);
  if (parsed.help) return help();
  if (parsed.error) return response(parsed.error);
  const loaded = (adapters.loadSettings || loadSettings)(parsed.settingsPath);
  if (loaded.error) return response(loaded.error);
  if (!(adapters.validateSettingsPaths || validateSettingsPaths)(loaded.settings, parsed.operation)) {
    return response("unsafeSettingsPath");
  }
  if (!(adapters.validateDispatchRoot || validateDispatchRoot)(parsed.dispatchRoot)) {
    return response("unsafeDispatchRoot");
  }
  if (!isRegularNonSymlink(LAUNCHER_PATH)) return response("unsafeLauncher");
  let routing;
  try {
    routing = (adapters.loadRouting || loadRouting)(parsed.dispatchRoot);
  } catch {
    return response("routingUnavailable");
  }
  let baseline;
  try {
    baseline = loadBaseline(routing);
  } catch {
    return response("invalidCapabilityIndex");
  }
  if (baseline.capabilities.some((capability) => capability?.id === CAPABILITY_ID)) {
    return response("capabilityCollision");
  }
  let overlay;
  let result;
  try {
    overlay = (adapters.createOverlay || createOverlay)(parsed.settingsPath, baseline);
    const plan = routing.resolveDispatchPlan(OPERATION_PHRASES[parsed.operation], {
      indexPath: overlay.indexPath,
      hookSurface: "local_interactive",
    });
    result = selectedFixedCapability(plan)
      ? runLauncher(parsed.operation, loaded.settings, adapters)
      : response("notSelected");
  } catch (error) {
    result = response(error && error.code === "CLEANUP_FAILED" ? "cleanupFailed" : "routingFailed");
  }
  try {
    (adapters.cleanupOverlay || cleanupOverlay)(overlay);
  } catch {
    return response("cleanupFailed");
  }
  return result;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  cleanupOverlay,
  createOverlay,
  execute,
  help,
  loadSettings,
  main,
  parseArgs,
  validateDispatchRoot,
  validateSettingsPaths,
};

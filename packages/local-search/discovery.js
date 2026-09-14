"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { verifyRuntime: verifyNode24 } = require("../../bin/myos-local-search.js");

const NESTED_CLI = path.resolve(__dirname, "bin/local-search.js");
const LOCAL_UI = path.resolve(__dirname, "local-ui.js");
const STATUS_VALUES = new Set(["disabled", "notStarted", "partial", "passive", "degraded"]);
const DESCRIPTOR = Object.freeze({
  id: "local-search",
  version: 1,
  optional: true,
  taskClass: "cheap_routing",
  commands: Object.freeze(["describe", "status", "open"]),
  resultExport: "none/local_ui_only",
  automaticRouting: false,
  entrypoint: "myos-search",
  localInterface: "native_terminal",
});

function describe() {
  return { ...DESCRIPTOR, commands: [...DESCRIPTOR.commands] };
}

function help() {
  return {
    ok: true,
    status: "help",
    usage: [
      "myos-search describe",
      "myos-search status --node24 ABSOLUTE_PATH --config ABSOLUTE_PATH",
      "myos-search open --node24 ABSOLUTE_PATH --config ABSOLUTE_PATH",
    ],
    boundary: {
      optional: true,
      defaultEnabled: false,
      localTerminalOnly: true,
      automaticRouting: false,
      hostedOperations: ["describe", "status", "open"],
      universalSameAccountContainment: false,
      watchMode: "manual_foreground_not_daemon",
    },
  };
}

function isNormalizedAbsolute(value) {
  return typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value;
}

function status(input, adapters = {}) {
  const result = {
    installed: true,
    runtimeReady: false,
    enabled: false,
    localUiAvailable: false,
    status: "runtimeUnavailable",
  };
  if (!input || !isNormalizedAbsolute(input.node24) || !isNormalizedAbsolute(input.configPath)) {
    result.status = "invalidArguments";
    return result;
  }
  try {
    (adapters.verifyRuntime || verifyNode24)(input.node24);
  } catch {
    return result;
  }
  result.runtimeReady = true;
  const exists = adapters.fileExists || fs.existsSync;
  result.localUiAvailable = (adapters.platform || process.platform) === "darwin" && exists(LOCAL_UI);
  let child;
  try {
    const run = adapters.runProcess || ((command, args, options) => spawnSync(command, args, options));
    child = run(input.node24, [NESTED_CLI, "status", "--config", input.configPath], {
      encoding: "utf8",
      shell: false,
      timeout: 5_000,
      maxBuffer: 8_192,
      env: {},
    });
  } catch {
    result.status = "statusUnavailable";
    return result;
  }
  if (!child || child.error || child.status !== 0 || typeof child.stdout !== "string") {
    result.status = "statusUnavailable";
    return result;
  }
  try {
    const parsed = JSON.parse(child.stdout.trim());
    if (!parsed || typeof parsed !== "object" || !STATUS_VALUES.has(parsed.status)) {
      result.status = "malformedStatus";
      return result;
    }
    result.enabled = parsed.enabled === true;
    result.status = parsed.status;
    return result;
  } catch {
    result.status = "malformedStatus";
    return result;
  }
}

function parsePaths(argv) {
  if (argv.length !== 4) return null;
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if ((flag !== "--node24" && flag !== "--config") || Object.hasOwn(values, flag)) return null;
    values[flag] = argv[index + 1];
  }
  if (!isNormalizedAbsolute(values["--node24"]) || !isNormalizedAbsolute(values["--config"])) return null;
  return { node24: values["--node24"], configPath: values["--config"] };
}

function quotePosix(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function open(input, adapters = {}) {
  if ((adapters.platform || process.platform) !== "darwin") return { ok: false, status: "unsupportedPlatform" };
  if (!input || !isNormalizedAbsolute(input.node24) || !isNormalizedAbsolute(input.configPath)) {
    return { ok: false, status: "invalidArguments" };
  }
  try {
    (adapters.verifyRuntime || verifyNode24)(input.node24);
  } catch {
    return { ok: false, status: "runtimeUnavailable" };
  }
  if (!(adapters.fileExists || fs.existsSync)(LOCAL_UI)) return { ok: false, status: "launchUnavailable" };
  const terminalCommand = `${quotePosix(input.node24)} ${quotePosix(LOCAL_UI)} --config ${quotePosix(input.configPath)}`;
  let child;
  try {
    const run = adapters.runProcess || ((command, args, options) => spawnSync(command, args, options));
    child = run("/usr/bin/osascript", [
      "-e", "on run argv",
      "-e", "tell application \"Terminal\" to do script (item 1 of argv)",
      "-e", "tell application \"Terminal\" to activate",
      "-e", "end run",
      "--", terminalCommand,
    ], { encoding: "utf8", shell: false, timeout: 5_000, maxBuffer: 8_192 });
  } catch {
    return { ok: false, status: "launchFailed" };
  }
  if (!child || child.error || child.status !== 0) return { ok: false, status: "launchFailed" };
  return { ok: true, status: "launchRequested" };
}

function execute(argv, adapters = {}) {
  if (argv.length === 1 && argv[0] === "describe") return describe();
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return help();
  const operation = argv[0];
  if (operation !== "status" && operation !== "open") return { ok: false, status: "operationDenied" };
  const input = parsePaths(argv.slice(1));
  if (!input) return { ok: false, status: "invalidArguments" };
  if (operation === "status") return status(input, adapters);
  return open(input, adapters);
}

module.exports = { describe, execute, help, open, status };

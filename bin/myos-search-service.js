#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const NESTED_CLI = path.resolve(__dirname, "../packages/local-search/service-cli.js");
const USAGE = "myos-search-service --node24 /absolute/path/to/node <enable|disable|status> --config /absolute/path [--confirm]";
const OUTPUT_LIMIT = 8 * 1024;
const SERVICE_FIELDS = Object.freeze([
  "version", "id", "name", "enabled", "taskClass", "complianceLane", "scheduler",
  "phase", "lastHeartbeat", "lastRun", "lastStatus", "nextReconciliationAt", "errorCode",
  "metadataRefreshedAt", "metadataSweepCompletedAt", "metadataPending",
]);
const REQUIRED_SERVICE_FIELDS = Object.freeze(SERVICE_FIELDS.filter((field) => !field.startsWith("metadata")));
const SERVICE_PHASES = new Set(["disabled", "offline", "starting", "watching", "paused", "recovering", "degraded", "stopped"]);
const SERVICE_ERROR_CODES = new Set([
  "configurationDisabled", "serviceNotEnabled", "registrationMissing", "missingHeartbeat",
  "staleHeartbeat", "futureHeartbeat", "invalidStatus", "ownershipCollision", "watchStartupFailed",
  "watchStopped", "watchError", "reconcileFailed", "clockGap", "resourcePaused", "indexNotReady",
  "wakeNoop", "wakeFailed", "serviceFailed", "heartbeatPublicationFailed", "rollbackIncomplete",
  "stopVerificationFailed", "registrationUnknown", "invalidRuntime",
]);
const OPERATION_STATUSES = new Set([
  ...SERVICE_ERROR_CODES, "invalidArgument", "wrongRuntimeMajor", "unsupportedPlatform",
  "confirmationRequired", "registrationFailed", "startupAckTimeout", "runtimeSpawnFailed",
  "invalidRuntimeOutput",
]);

function response(status) {
  return { ok: false, status: OPERATION_STATUSES.has(status) ? status : "serviceFailed", taskClass: "cheap_routing", complianceLane: "unattended_local" };
}

function exactFields(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function allowedFields(value, required, allowed) {
  return value && typeof value === "object" && !Array.isArray(value)
    && required.every((field) => Object.hasOwn(value, field))
    && Object.keys(value).every((field) => allowed.includes(field));
}

function validTimestamp(value) {
  return value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value);
}

function sanitizePublicOutput(value, operation) {
  const operationFields = ["ok", "status", "taskClass", "complianceLane"];
  if (exactFields(value, operationFields) && value.ok === false && OPERATION_STATUSES.has(value.status) && value.taskClass === "cheap_routing" && value.complianceLane === "unattended_local") {
    return Object.fromEntries(operationFields.map((field) => [field, value[field]]));
  }
  const expectedTaskClass = operation === "enable" ? "default_automation" : "cheap_routing";
  if (!allowedFields(value, REQUIRED_SERVICE_FIELDS, SERVICE_FIELDS) || value.version !== 1 || typeof value.id !== "string" || !/^com\.myos\.local-search\.[a-f0-9]{20}$/.test(value.id)) return null;
  if (value.name !== "local-search-freshness" || typeof value.enabled !== "boolean" || value.taskClass !== expectedTaskClass || value.complianceLane !== "unattended_local" || value.scheduler !== "launchd" || !SERVICE_PHASES.has(value.phase)) return null;
  if (![value.lastHeartbeat, value.lastRun, value.nextReconciliationAt].every(validTimestamp)) return null;
  if (![value.metadataRefreshedAt ?? null, value.metadataSweepCompletedAt ?? null].every(validTimestamp)) return null;
  if (value.metadataPending !== undefined && value.metadataPending !== null && typeof value.metadataPending !== "boolean") return null;
  if (value.lastStatus !== null && (typeof value.lastStatus !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.lastStatus))) return null;
  if (value.errorCode !== null && !SERVICE_ERROR_CODES.has(value.errorCode)) return null;
  return Object.fromEntries(SERVICE_FIELDS.filter((field) => Object.hasOwn(value, field)).map((field) => [field, value[field]]));
}

function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { help: true };
  if (argv[0] !== "--node24" || !argv[1] || !path.isAbsolute(argv[1])) throw Object.assign(new Error("--node24 requires an explicit absolute Node 24 executable"), { code: "invalidRuntime" });
  return { node24: argv[1], args: argv.slice(2) };
}

function verifyRuntime(node24) {
  let stat;
  try { stat = fs.lstatSync(node24); }
  catch { throw Object.assign(new Error("--node24 executable does not exist"), { code: "invalidRuntime" }); }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const trustedOwner = uid === null || stat.uid === uid || stat.uid === 0;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !trustedOwner || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0) throw Object.assign(new Error("--node24 must name a trusted ordinary executable"), { code: "invalidRuntime" });
  const probe = spawnSync(node24, ["--version"], { encoding: "utf8", shell: false, timeout: 5_000, maxBuffer: OUTPUT_LIMIT });
  if (probe.error || probe.status !== 0) throw Object.assign(new Error("unable to execute --node24"), { code: "invalidRuntime" });
  if (!/^v24\./.test(probe.stdout.trim())) throw Object.assign(new Error("--node24 executable must report Node major version 24"), { code: "wrongRuntimeMajor" });
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(`${JSON.stringify({ ok: true, status: "help", taskClass: "cheap_routing", complianceLane: "unattended_local", usage: USAGE })}\n`);
      return 0;
    }
    verifyRuntime(options.node24);
    const nestedArgs = options.args[0] === "enable" ? [...options.args, "--node24", options.node24] : options.args;
    const child = spawnSync(options.node24, [NESTED_CLI, ...nestedArgs], {
      encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"], timeout: 15_000, maxBuffer: OUTPUT_LIMIT,
    });
    if (child.error || typeof child.stdout !== "string" || Buffer.byteLength(child.stdout) > OUTPUT_LIMIT) {
      process.stdout.write(`${JSON.stringify(response("runtimeSpawnFailed"))}\n`);
      return 1;
    }
    let output;
    try { output = JSON.parse(child.stdout); }
    catch { output = null; }
    const publicOutput = sanitizePublicOutput(output, options.args[0]);
    if (!publicOutput) {
      process.stdout.write(`${JSON.stringify(response("invalidRuntimeOutput"))}\n`);
      return 1;
    }
    process.stdout.write(`${JSON.stringify(publicOutput)}\n`);
    return child.status === null ? 1 : child.status;
  } catch (error) {
    const status = error && error.code === "INVALID_ARGUMENT" ? "invalidArgument" : error && error.code;
    process.stdout.write(`${JSON.stringify(response(status || "invalidArgument"))}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, parseArgs, sanitizePublicOutput, verifyRuntime };

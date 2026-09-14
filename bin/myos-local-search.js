#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const NESTED_CLI = path.resolve(__dirname, "../packages/local-search/bin/local-search.js");
const USAGE = "myos-local-search --node24 /absolute/path/to/node <configure|status|index|search|read|watch> --config /absolute/path [options]";

function response(status, error) {
  return { ok: false, status, taskClass: "cheap_routing", complianceLane: "unattended_local", error };
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { help: true };
  if (argv[0] !== "--node24" || !argv[1]) throw Object.assign(new Error("--node24 requires an explicit absolute Node 24 executable"), { code: "invalidRuntime" });
  if (!path.isAbsolute(argv[1])) throw Object.assign(new Error("--node24 must be an absolute path"), { code: "invalidRuntime" });
  return { node24: argv[1], args: argv.slice(2) };
}

function verifyRuntime(node24) {
  let stat;
  try {
    stat = fs.statSync(node24);
  } catch {
    throw Object.assign(new Error("--node24 executable does not exist"), { code: "invalidRuntime" });
  }
  if (!stat.isFile()) throw Object.assign(new Error("--node24 must name a file"), { code: "invalidRuntime" });
  const probe = spawnSync(node24, ["--version"], { encoding: "utf8", shell: false, timeout: 5000 });
  if (probe.error) throw Object.assign(new Error(`unable to execute --node24: ${probe.error.message}`), { code: "invalidRuntime" });
  if (probe.status !== 0 || !/^v24\./.test(probe.stdout.trim())) {
    throw Object.assign(new Error("--node24 executable must report Node major version 24"), { code: "wrongRuntimeMajor" });
  }
}

function runNested(node24, args) {
  return new Promise((resolve) => {
    const child = spawn(node24, [NESTED_CLI, ...args], { stdio: "inherit", shell: false });
    const forward = (signal) => child.kill(signal);
    process.once("SIGINT", forward);
    process.once("SIGTERM", forward);
    child.once("error", (error) => {
      process.removeListener("SIGINT", forward);
      process.removeListener("SIGTERM", forward);
      writeJson(response("runtimeSpawnFailed", error.message));
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      process.removeListener("SIGINT", forward);
      process.removeListener("SIGTERM", forward);
      resolve(code === null ? (signal === "SIGINT" ? 130 : 143) : code);
    });
  });
}

async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      writeJson({ ok: true, status: "help", taskClass: "cheap_routing", complianceLane: "unattended_local", usage: USAGE });
      return 0;
    }
    verifyRuntime(options.node24);
    return runNested(options.node24, options.args);
  } catch (error) {
    writeJson(response(error.code || "invalidArgument", error.message));
    return 1;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { main, parseArgs, verifyRuntime };

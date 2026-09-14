"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const modulePath = path.resolve(__dirname, "../packages/local-search/discovery.js");

test("local-search discovery descriptor is available without runtime configuration", () => {
  assert.equal(fs.existsSync(modulePath), true);
  const { describe } = require(modulePath);
  assert.deepEqual(describe(), {
    id: "local-search",
    version: 1,
    optional: true,
    taskClass: "cheap_routing",
    commands: ["describe", "status", "open"],
    resultExport: "none/local_ui_only",
    automaticRouting: false,
    entrypoint: "myos-search",
    localInterface: "native_terminal",
  });
});

test("status returns only whitelisted fields and never child output", () => {
  const { status } = require(modulePath);
  const canary = "SYNTHETIC_PRIVATE_CANARY";
  const result = status(
    { node24: "/opt/node 24/bin/node", configPath: `/private/tmp/${canary}.json` },
    {
      verifyRuntime() {},
      fileExists() { return true; },
      platform: "darwin",
      runProcess() {
        return {
          status: 0,
          stdout: JSON.stringify({ enabled: true, status: "passive", path: canary, count: 41, error: canary }),
          stderr: canary,
        };
      },
    },
  );
  assert.deepEqual(result, {
    installed: true,
    runtimeReady: true,
    enabled: true,
    localUiAvailable: true,
    status: "passive",
  });
  assert.equal(JSON.stringify(result).includes(canary), false);
});

test("agent-safe discovery rejects content operations before starting a child", () => {
  const { execute } = require(modulePath);
  let starts = 0;
  const adapters = { runProcess() { starts += 1; } };
  for (const operation of ["search", "read", "index", "query", "content", "--local"]) {
    assert.deepEqual(execute([operation], adapters), { ok: false, status: "operationDenied" });
  }
  assert.equal(starts, 0);
});

test("macOS launcher keeps spaces, quotes, and shell metacharacters literal", () => {
  const { open } = require(modulePath);
  const node24 = "/Applications/Node '24;$HOME/bin/node";
  const configPath = "/private/tmp/search config '$(touch NO).json";
  let call;
  const result = open(
    { node24, configPath },
    {
      platform: "darwin",
      verifyRuntime() {},
      fileExists() { return true; },
      runProcess(command, args, options) {
        call = { command, args, options };
        return { status: 0, stdout: "private", stderr: "private" };
      },
    },
  );
  assert.deepEqual(result, { ok: true, status: "launchRequested" });
  assert.equal(call.command, "/usr/bin/osascript");
  assert.equal(call.options.shell, false);
  assert.equal(
    call.args.at(-1),
    "'/Applications/Node '\"'\"'24;$HOME/bin/node' '" +
      path.resolve(__dirname, "../packages/local-search/local-ui.js") +
      "' --config '/private/tmp/search config '\"'\"'$(touch NO).json'",
  );
});

test("optional capability descriptor matches the static discovery contract", () => {
  const capabilityPath = path.resolve(__dirname, "../capabilities/local-search.json");
  assert.equal(fs.existsSync(capabilityPath), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(capabilityPath, "utf8")), require(modulePath).describe());
});

test("installed myos-search describe works without config, model, or Node 24", () => {
  const packageJson = require("../package.json");
  assert.equal(packageJson.bin["myos-search"], "bin/myos-search.js");
  const entrypoint = path.resolve(__dirname, "../bin/myos-search.js");
  const child = spawnSync(process.execPath, [entrypoint, "describe"], { encoding: "utf8" });
  assert.equal(child.status, 0);
  assert.deepEqual(JSON.parse(child.stdout), require(modulePath).describe());
});

test("installed myos-search help states the optional local-only boundary", () => {
  const entrypoint = path.resolve(__dirname, "../bin/myos-search.js");
  const child = spawnSync(process.execPath, [entrypoint, "--help"], { encoding: "utf8" });
  assert.equal(child.status, 0);
  const help = JSON.parse(child.stdout);
  assert.deepEqual(help.usage, [
    "myos-search describe",
    "myos-search status --node24 ABSOLUTE_PATH --config ABSOLUTE_PATH",
    "myos-search open --node24 ABSOLUTE_PATH --config ABSOLUTE_PATH",
  ]);
  assert.deepEqual(help.boundary, {
    optional: true,
    defaultEnabled: false,
    localTerminalOnly: true,
    automaticRouting: false,
    hostedOperations: ["describe", "status", "open"],
    universalSameAccountContainment: false,
    watchMode: "manual_foreground_not_daemon",
  });
});

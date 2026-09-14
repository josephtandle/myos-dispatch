"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const packageJson = require("../package.json");
const service = require("../packages/local-search/service");
const serviceCli = require("../packages/local-search/service-cli");
const runner = require("../packages/local-search/service-runner");
const serviceEntrypoint = path.resolve(__dirname, "../bin/myos-search-service.js");
const node24 = "/Users/myos/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node";

function fixture(t, enabled = true) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "myos-search-service-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const homeDirectory = path.join(base, "home");
  const root = path.join(base, "docs");
  const stateDirectory = path.join(base, "state");
  fs.mkdirSync(homeDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(root, { mode: 0o700 });
  const configPath = path.join(base, "local-search.json");
  const config = {
    version: 1, enabled, stateDirectory,
    roots: enabled ? [{ id: "docs", path: root, contentEnabled: true, extensions: [".md"] }] : [],
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  const calls = [];
  let loaded = false;
  const launchctl = {
    async print() { calls.push("print"); return { loaded }; },
    async bootstrap(input) { calls.push("bootstrap"); loaded = true; if (launchctl.onBootstrap) await launchctl.onBootstrap(input); return { ok: true }; },
    async bootout() { calls.push("bootout"); loaded = false; return { ok: true }; },
  };
  const dependencies = {
    homeDirectory, uid: 501, launchctl, platform: "darwin",
    ackDeadlineMs: 15, ackPollIntervalMs: 1,
  };
  return { base, config, configPath, dependencies, launchctl, calls };
}

function ack(statusPath, identity, now = Date.now()) {
  const receipt = JSON.parse(fs.readFileSync(identity.receiptPath, "utf8"));
  service.acknowledgeLaunch(identity, receipt);
  fs.writeFileSync(statusPath, `${JSON.stringify({
    version: 1, id: identity.label, name: "local-search-freshness", enabled: true,
    taskClass: "default_automation", complianceLane: "unattended_local", scheduler: "launchd", phase: "starting",
    lastHeartbeat: new Date(now).toISOString(), lastRun: null, lastStatus: null,
    nextReconciliationAt: null, errorCode: null,
  })}\n`, { mode: 0o600 });
}

async function prepareOwned(item, now) {
  item.dependencies.now = () => now;
  item.launchctl.onBootstrap = ({ identity }) => ack(identity.statusPath, identity, now);
  await service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies);
  return service.deriveIdentity(item.configPath, item.config, item.dependencies);
}

test("root package exposes the additive local-search service command", () => {
  assert.equal(packageJson.bin["myos-search-service"], "bin/myos-search-service.js");
});

test("launchctl print distinguishes exact absence from unknown observation failures", async () => {
  const target = "gui/501/com.myos.local-search.test";
  let invocation;
  const loaded = service.defaultLaunchctl((file, args, options) => { invocation = { file, args, options }; });
  assert.deepEqual(await loaded.print({ target }), { loaded: true });
  assert.deepEqual(invocation, {
    file: "/bin/launchctl", args: ["print", target],
    options: { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000, maxBuffer: 8 * 1024 },
  });
  const exactNotFound = Object.assign(new Error("launchctl failed"), {
    status: 113,
    stderr: 'Bad request.\nCould not find service "com.myos.local-search.test" in domain for user gui: 501\n',
  });
  const wrongDomain = Object.assign(new Error("launchctl failed"), {
    status: 113,
    stderr: 'Bad request.\nCould not find service "com.myos.local-search.test" in domain for user gui: 502\n',
  });
  for (const [failure, expected] of [
    [exactNotFound, false],
    [wrongDomain, null],
    [Object.assign(new Error("timed out"), { code: "ETIMEDOUT", killed: true }), null],
    [Object.assign(new Error("too much output"), { code: "ENOBUFS" }), null],
    [Object.assign(new Error("not permitted"), { code: "EACCES" }), null],
  ]) {
    const launchctl = service.defaultLaunchctl(() => { throw failure; });
    assert.deepEqual(await launchctl.print({ target }), { loaded: expected });
  }
});

test("service CLI keeps enable confirmation explicit and operation-scoped", () => {
  assert.deepEqual(serviceCli.parse(["enable", "--config", "/private/config.json", "--confirm", "--node24", "/private/node"]), {
    operation: "enable", configPath: "/private/config.json", node24: "/private/node", confirm: true,
  });
  assert.throws(() => serviceCli.parse(["status", "--config", "/private/config.json", "--confirm"]), /enable-only/);
});

test("outer bridge help is runtime-free and enable passes the validated Node 24 path", (t) => {
  const help = require("node:child_process").spawnSync(process.execPath, [serviceEntrypoint, "--help"], { encoding: "utf8" });
  assert.equal(JSON.parse(help.stdout).status, "help");
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "myos-service-node-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fake = path.join(directory, "node24");
  fs.writeFileSync(fake, `#!/usr/bin/env node
if(process.argv[2]==="--version"){process.stdout.write("v24.1.0\\n");process.exit(0)}
const expected=${JSON.stringify(JSON.stringify(["enable", "--config", "/private/config.json", "--confirm", "--node24", "FAKE_NODE"]))}.replace("FAKE_NODE",process.argv[1])
const status=JSON.stringify(process.argv.slice(3))===expected?"confirmationRequired":"invalidArgument"
process.stdout.write(JSON.stringify({ok:false,status,taskClass:"cheap_routing",complianceLane:"unattended_local"})+"\\n")
`, { mode: 0o700 });
  const child = require("node:child_process").spawnSync(process.execPath, [serviceEntrypoint, "--node24", fake, "enable", "--config", "/private/config.json", "--confirm"], { encoding: "utf8" });
  assert.equal(JSON.parse(child.stdout).status, "confirmationRequired");
});

test("CLI and runner main handlers expose only finite public error statuses", async () => {
  const cliPath = path.resolve(__dirname, "../packages/local-search/service-cli.js");
  const invalid = require("node:child_process").spawnSync(node24, [cliPath, "status", "--config", "relative/private"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(invalid.stdout), {
    ok: false, status: "invalidArgument", taskClass: "cheap_routing", complianceLane: "unattended_local",
  });
  const missing = require("node:child_process").spawnSync(node24, [cliPath, "status", "--config", "/definitely/missing/private-config.json"], { encoding: "utf8" });
  assert.equal(JSON.parse(missing.stdout).status, "serviceFailed");
  assert.deepEqual(await runner.main(["--config", "/definitely/missing/private-config.json"]), {
    ok: false, status: "serviceFailed", taskClass: "cheap_routing", complianceLane: "unattended_local",
  });
});

test("persistent freshness is default-off and does not register disabled configuration", async (t) => {
  const item = fixture(t, false);
  await assert.rejects(
    service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies),
    (error) => error.code === "configurationDisabled",
  );
  assert.deepEqual(item.calls, []);
  assert.equal(fs.existsSync(path.join(item.config.stateDirectory, "service")), false);
});

test("explicit enable writes an owned plist and observes startup acknowledgement", async (t) => {
  const item = fixture(t);
  item.launchctl.onBootstrap = ({ identity }) => ack(identity.statusPath, identity);
  const result = await service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies);
  assert.equal(result.phase, "starting");
  assert.equal(result.scheduler, "launchd");
  assert.deepEqual(item.calls, ["print", "bootstrap", "print"]);
  const identity = service.deriveIdentity(item.configPath, item.config, item.dependencies);
  const plist = fs.readFileSync(identity.plistPath, "utf8");
  assert.match(plist, /<key>ProgramArguments<\/key>\s*<array>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>PathState<\/key>/);
  assert.equal(fs.statSync(identity.receiptPath).mode & 0o077, 0);
  assert.equal(fs.statSync(identity.markerPath).mode & 0o077, 0);
  assert.deepEqual(Object.keys(result), ["version", "id", "name", "enabled", "taskClass", "complianceLane", "scheduler", "phase", "lastHeartbeat", "lastRun", "lastStatus", "nextReconciliationAt", "errorCode"]);
});

test("enable requires confirmation and refuses an unowned plist collision", async (t) => {
  const item = fixture(t);
  await assert.rejects(service.enable({ configPath: item.configPath, node24 }, item.dependencies), (error) => error.code === "confirmationRequired");
  const identity = service.deriveIdentity(item.configPath, item.config, item.dependencies);
  fs.mkdirSync(path.dirname(identity.plistPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(identity.plistPath, "unowned", { mode: 0o600 });
  await assert.rejects(service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies), (error) => error.code === "ownershipCollision");
  assert.deepEqual(item.calls, []);
});

test("enable fails closed before creating artifacts when registration state is unknown", async (t) => {
  const item = fixture(t);
  item.launchctl.print = async () => ({ loaded: null });
  await assert.rejects(
    service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies),
    (error) => error.code === "registrationUnknown",
  );
  const identity = service.deriveIdentity(item.configPath, item.config, item.dependencies);
  assert.equal(fs.existsSync(identity.plistPath), false);
  assert.equal(fs.existsSync(identity.receiptPath), false);
  assert.equal(fs.existsSync(identity.markerPath), false);
});

test("enable requires the service runner to be ready before creating artifacts", async (t) => {
  const item = fixture(t);
  item.dependencies.installationRoot = path.join(item.base, "missing-installation");
  await assert.rejects(
    service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies),
    (error) => error.code === "invalidRuntime",
  );
  const identity = service.deriveIdentity(item.configPath, item.config, item.dependencies);
  assert.equal(fs.existsSync(identity.plistPath), false);
  assert.equal(fs.existsSync(identity.receiptPath), false);
});

test("runner code may be non-executable but must remain a trusted readable regular file", async (t) => {
  const accepted = fixture(t);
  const installationRoot = path.join(accepted.base, "installed");
  const installedRunner = path.join(installationRoot, "packages", "local-search", "service-runner.js");
  fs.mkdirSync(path.dirname(installedRunner), { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.resolve(__dirname, "../packages/local-search/service-runner.js"), installedRunner);
  fs.chmodSync(installedRunner, 0o600);
  accepted.dependencies.installationRoot = installationRoot;
  accepted.launchctl.onBootstrap = ({ identity }) => ack(identity.statusPath, identity);
  const enabled = await service.enable({ configPath: accepted.configPath, node24, confirm: true }, accepted.dependencies);
  assert.equal(enabled.enabled, true);

  fs.chmodSync(installedRunner, 0o620);
  const identity = service.deriveIdentity(accepted.configPath, accepted.config, accepted.dependencies);
  let watched = false;
  const refusedAtStartup = await runner.runService({ configPath: accepted.configPath }, {
    identity, now: accepted.dependencies.now,
    watch: async () => { watched = true; },
  });
  assert.equal(watched, false);
  assert.equal(refusedAtStartup.errorCode, "invalidRuntime");

  for (const kind of ["unreadable", "group-writable", "symlink", "hardlink"]) {
    const item = fixture(t);
    const root = path.join(item.base, "installed");
    const candidate = path.join(root, "packages", "local-search", "service-runner.js");
    fs.mkdirSync(path.dirname(candidate), { recursive: true, mode: 0o700 });
    if (kind === "symlink" || kind === "hardlink") {
      const target = path.join(item.base, "runner-target.js");
      fs.writeFileSync(target, "// runner\n", { mode: 0o600 });
      if (kind === "symlink") fs.symlinkSync(target, candidate);
      else fs.linkSync(target, candidate);
    } else {
      fs.writeFileSync(candidate, "// runner\n", { mode: kind === "unreadable" ? 0o000 : 0o620 });
      fs.chmodSync(candidate, kind === "unreadable" ? 0o000 : 0o620);
    }
    item.dependencies.installationRoot = root;
    await assert.rejects(
      service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies),
      (error) => error.code === "invalidRuntime",
    );
  }
});

test("missing startup acknowledgement rolls back only newly-created service artifacts", async (t) => {
  const item = fixture(t);
  await assert.rejects(service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies), (error) => error.code === "startupAckTimeout");
  const identity = service.deriveIdentity(item.configPath, item.config, item.dependencies);
  assert.ok(item.calls.includes("bootout"));
  assert.equal(fs.existsSync(identity.plistPath), false);
  assert.equal(fs.existsSync(identity.markerPath), false);
  assert.equal(fs.existsSync(identity.receiptPath), false);
  assert.equal(fs.existsSync(item.configPath), true);
});

test("status requires registration and a fresh heartbeat", async (t) => {
  const item = fixture(t);
  const startedAt = Date.now();
  item.dependencies.now = () => startedAt;
  item.launchctl.onBootstrap = ({ identity }) => ack(identity.statusPath, identity, startedAt);
  await service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies);
  const result = await service.status({ configPath: item.configPath }, { ...item.dependencies, now: () => startedAt + 300_000, heartbeatFreshMs: 60_000 });
  assert.equal(result.phase, "degraded");
  assert.equal(result.errorCode, "staleHeartbeat");
  assert.equal(result.taskClass, "cheap_routing");
  assert.equal(Object.values(result).some((value) => typeof value === "string" && value.includes(item.base)), false);
});

test("status reports an unknown launchctl observation as degraded", async (t) => {
  const item = fixture(t);
  item.launchctl.onBootstrap = ({ identity }) => ack(identity.statusPath, identity);
  await service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies);
  item.launchctl.print = async () => ({ loaded: null });
  const result = await service.status({ configPath: item.configPath }, item.dependencies);
  assert.equal(result.phase, "degraded");
  assert.equal(result.errorCode, "registrationUnknown");
  assert.equal(Object.keys(result).length, 13);
});

test("disable operates only on a matching owned registration and verifies stop", async (t) => {
  const item = fixture(t);
  item.launchctl.onBootstrap = ({ identity }) => ack(identity.statusPath, identity);
  await service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies);
  const result = await service.disable({ configPath: item.configPath }, item.dependencies);
  const identity = service.deriveIdentity(item.configPath, item.config, item.dependencies);
  assert.equal(result.phase, "disabled");
  assert.ok(item.calls.includes("bootout"));
  assert.equal(fs.existsSync(identity.markerPath), false);
  assert.equal(fs.existsSync(identity.plistPath), false);
  assert.equal(fs.existsSync(item.configPath), true);
});

test("disable preserves owned artifacts when registration state cannot be verified", async (t) => {
  const item = fixture(t);
  item.launchctl.onBootstrap = ({ identity }) => ack(identity.statusPath, identity);
  await service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies);
  const identity = service.deriveIdentity(item.configPath, item.config, item.dependencies);
  item.launchctl.print = async () => ({ loaded: null });
  await assert.rejects(service.disable({ configPath: item.configPath }, item.dependencies), (error) => error.code === "stopVerificationFailed");
  assert.equal(fs.existsSync(identity.plistPath), true);
  assert.equal(fs.existsSync(identity.receiptPath), true);
  assert.equal(fs.existsSync(identity.markerPath), true);
});

test("disable removes an exactly owned service after its startup executables are gone", async (t) => {
  const item = fixture(t);
  const installationRoot = path.join(item.base, "installed");
  const installedRunner = path.join(installationRoot, "packages", "local-search", "service-runner.js");
  const installedNode = path.join(item.base, "node24");
  fs.mkdirSync(path.dirname(installedRunner), { recursive: true, mode: 0o700 });
  fs.writeFileSync(installedRunner, "// runner\n", { mode: 0o700 });
  fs.writeFileSync(installedNode, "#!/bin/sh\necho v24.0.0\n", { mode: 0o700 });
  item.dependencies.installationRoot = installationRoot;
  item.launchctl.onBootstrap = ({ identity }) => ack(identity.statusPath, identity);
  await service.enable({ configPath: item.configPath, node24: installedNode, confirm: true }, item.dependencies);
  const identity = service.deriveIdentity(item.configPath, item.config, item.dependencies);
  fs.unlinkSync(installedNode);
  fs.unlinkSync(installedRunner);
  const result = await service.disable({ configPath: item.configPath }, item.dependencies);
  assert.equal(result.phase, "disabled");
  assert.equal(fs.existsSync(identity.receiptPath), false);
  assert.equal(fs.existsSync(identity.plistPath), false);
});

test("disable rejects a redirected service-directory ancestor before bootout", async (t) => {
  const item = fixture(t);
  item.launchctl.onBootstrap = ({ identity }) => ack(identity.statusPath, identity);
  await service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies);
  const identity = service.deriveIdentity(item.configPath, item.config, item.dependencies);
  const redirected = path.join(item.base, "redirected-service");
  fs.renameSync(identity.serviceDirectory, redirected);
  fs.symlinkSync(redirected, identity.serviceDirectory);
  await assert.rejects(service.disable({ configPath: item.configPath }, item.dependencies), (error) => error.code === "ownershipCollision");
  assert.equal(item.calls.filter((call) => call === "bootout").length, 0);
  assert.equal(fs.existsSync(path.join(redirected, "owner-receipt.json")), true);
});

test("runner acknowledges before watch startup, recovers after a clock gap, and drains on SIGHUP", async (t) => {
  const item = fixture(t);
  const identity = service.deriveIdentity(item.configPath, item.config, item.dependencies);
  item.launchctl.onBootstrap = ({ identity: launched }) => ack(launched.statusPath, launched);
  await service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies);
  const signals = new EventEmitter();
  let resolveWatch;
  const watchStarted = new Promise((resolve) => { resolveWatch = resolve; });
  let interval;
  let stopped = 0;
  let reconciled = 0;
  let now = 1_000;
  const state = { stopped: false, running: false, runs: 1, last: { ok: true, status: "unchanged", complete: true }, healthErrors: [], resources: { background: "ready" }, queued: false };
  const running = runner.runService({ configPath: item.configPath }, {
    identity, signals, now: () => now,
    setInterval: (callback) => { interval = callback; return 1; }, clearInterval: () => {},
    watch: async () => {
      await watchStarted;
      return {
        ok: true,
        stop: async () => { stopped += 1; state.stopped = true; },
        reconcileNow: async () => { reconciled += 1; state.runs += 1; },
        getState: () => ({ ...state }),
      };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(fs.readFileSync(identity.statusPath, "utf8")).phase, "starting");
  resolveWatch();
  await new Promise((resolve) => setImmediate(resolve));
  now += 150_000;
  await interval();
  assert.equal(reconciled, 1);
  signals.emit("SIGHUP");
  const result = await running;
  assert.equal(result.phase, "stopped");
  assert.equal(stopped, 1);
});

test("failed rollback preserves ownership artifacts until process stop is verified", async (t) => {
  const item = fixture(t);
  item.launchctl.bootout = async () => { item.calls.push("bootout"); return { ok: false, errorCode: "busy" }; };
  await assert.rejects(
    service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies),
    (error) => error.code === "rollbackIncomplete" && error.causeCode === "startupAckTimeout",
  );
  const identity = service.deriveIdentity(item.configPath, item.config, item.dependencies);
  assert.equal(fs.existsSync(identity.receiptPath), true);
  assert.equal(fs.existsSync(identity.plistPath), true);
  assert.equal(fs.existsSync(identity.markerPath), true);
});

test("rollback preserves ownership artifacts when post-bootout observation is unknown", async (t) => {
  const item = fixture(t);
  let prints = 0;
  item.launchctl.print = async () => ({ loaded: prints++ === 0 ? false : null });
  item.launchctl.bootstrap = async () => ({ ok: false, errorCode: "launchctlFailed" });
  item.launchctl.bootout = async () => ({ ok: true });
  await assert.rejects(
    service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies),
    (error) => error.code === "rollbackIncomplete" && error.causeCode === "registrationFailed",
  );
  const identity = service.deriveIdentity(item.configPath, item.config, item.dependencies);
  assert.equal(fs.existsSync(identity.receiptPath), true);
  assert.equal(fs.existsSync(identity.plistPath), true);
  assert.equal(fs.existsSync(identity.markerPath), true);
});

test("startup acknowledgement rejects stale, future, and unacknowledged generations", async (t) => {
  for (const offset of [-60_000, 60_000, 0]) {
    const item = fixture(t);
    const startedAt = 100_000;
    let clock = startedAt;
    item.dependencies.now = () => clock;
    item.dependencies.sleep = async (milliseconds) => { clock += milliseconds; };
    item.launchctl.onBootstrap = ({ identity }) => {
      if (offset !== 0) ack(identity.statusPath, identity, startedAt + offset);
      else {
        const value = service.projection(identity, { enabled: true, phase: "starting", lastHeartbeat: new Date(startedAt).toISOString() });
        fs.writeFileSync(identity.statusPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      }
    };
    await assert.rejects(service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies), (error) => error.code === "startupAckTimeout");
  }
});

test("existing owned registration is reused only with its current generation and registration", async (t) => {
  const item = fixture(t);
  const startedAt = 200_000;
  item.dependencies.now = () => startedAt;
  item.launchctl.onBootstrap = ({ identity }) => ack(identity.statusPath, identity, startedAt);
  const first = await service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies);
  const bootstraps = item.calls.filter((call) => call === "bootstrap").length;
  const second = await service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies);
  assert.equal(second.lastHeartbeat, first.lastHeartbeat);
  assert.equal(item.calls.filter((call) => call === "bootstrap").length, bootstraps);
});

test("existing enable preserves its receipt and marker when acknowledgement observation becomes unknown", async (t) => {
  const item = fixture(t);
  item.launchctl.onBootstrap = ({ identity }) => ack(identity.statusPath, identity);
  await service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies);
  const identity = service.deriveIdentity(item.configPath, item.config, item.dependencies);
  const receipt = fs.readFileSync(identity.receiptPath);
  const marker = fs.readFileSync(identity.markerPath);
  let prints = 0;
  item.launchctl.print = async () => ({ loaded: prints++ === 0 ? true : null });
  await assert.rejects(service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies), (error) => error.code === "startupAckTimeout");
  assert.deepEqual(fs.readFileSync(identity.receiptPath), receipt);
  assert.deepEqual(fs.readFileSync(identity.markerPath), marker);
});

test("filesystem boundaries reject redirected service and LaunchAgents ancestors", async (t) => {
  const serviceLink = fixture(t);
  fs.mkdirSync(serviceLink.config.stateDirectory, { mode: 0o700 });
  const redirect = path.join(serviceLink.base, "redirect");
  fs.mkdirSync(redirect, { mode: 0o700 });
  fs.symlinkSync(redirect, path.join(serviceLink.config.stateDirectory, "service"));
  await assert.rejects(service.enable({ configPath: serviceLink.configPath, node24, confirm: true }, serviceLink.dependencies), (error) => error.code === "ownershipCollision");
  assert.deepEqual(fs.readdirSync(redirect), []);

  const launchLink = fixture(t);
  const outside = path.join(launchLink.base, "outside");
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.symlinkSync(outside, path.join(launchLink.dependencies.homeDirectory, "Library"));
  await assert.rejects(service.enable({ configPath: launchLink.configPath, node24, confirm: true }, launchLink.dependencies), (error) => error.code === "ownershipCollision");
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("private receipt, marker, and status hard links are rejected", async (t) => {
  const item = fixture(t);
  const startedAt = 300_000;
  item.dependencies.now = () => startedAt;
  item.launchctl.onBootstrap = ({ identity }) => ack(identity.statusPath, identity, startedAt);
  await service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies);
  const identity = service.deriveIdentity(item.configPath, item.config, item.dependencies);
  fs.linkSync(identity.receiptPath, path.join(item.base, "receipt-link"));
  const result = await service.status({ configPath: item.configPath }, item.dependencies);
  assert.equal(result.errorCode, "ownershipCollision");
});

test("actual owner-readable Node 24 executable is accepted without a probe bypass", async (t) => {
  const item = fixture(t);
  const startedAt = 400_000;
  item.dependencies.now = () => startedAt;
  item.launchctl.onBootstrap = ({ identity }) => ack(identity.statusPath, identity, startedAt);
  const result = await service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies);
  assert.equal(result.enabled, true);
  assert.equal(fs.statSync(node24).mode & 0o777, 0o755);
});

test("status rejects extra private fields, malformed types, and raw error text", async (t) => {
  const item = fixture(t);
  const startedAt = 500_000;
  item.dependencies.now = () => startedAt;
  item.launchctl.onBootstrap = ({ identity }) => ack(identity.statusPath, identity, startedAt);
  await service.enable({ configPath: item.configPath, node24, confirm: true }, item.dependencies);
  const identity = service.deriveIdentity(item.configPath, item.config, item.dependencies);
  const malformed = { ...JSON.parse(fs.readFileSync(identity.statusPath, "utf8")), launchGeneration: "private", errorCode: "/secret/path command --token" };
  fs.writeFileSync(identity.statusPath, `${JSON.stringify(malformed)}\n`, { mode: 0o600 });
  const result = await service.status({ configPath: item.configPath }, item.dependencies);
  assert.equal(result.errorCode, "invalidStatus");
  assert.equal(Object.keys(result).length, 13);
  assert.equal(JSON.stringify(result).includes(item.base), false);
});

test("status publication cleans partial temporary files when publication fails", { concurrency: false }, (t) => {
  const item = fixture(t);
  const identity = service.deriveIdentity(item.configPath, item.config, item.dependencies);
  fs.mkdirSync(identity.serviceDirectory, { recursive: true, mode: 0o700 });
  service.writeStatus(identity, { enabled: true, phase: "starting" });
  const rename = fs.renameSync;
  fs.renameSync = () => { const error = new Error("disk full"); error.code = "ENOSPC"; throw error; };
  try { assert.throws(() => service.writeStatus(identity, { enabled: true, phase: "watching" }), (error) => error.code === "ENOSPC"); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readdirSync(identity.serviceDirectory).some((name) => name.endsWith(".tmp")), false);
  assert.equal(JSON.parse(fs.readFileSync(identity.statusPath, "utf8")).phase, "starting");
});

test("exclusive status collision preserves the pre-existing file", { concurrency: false }, (t) => {
  const item = fixture(t);
  const identity = service.deriveIdentity(item.configPath, item.config, item.dependencies);
  fs.mkdirSync(identity.serviceDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(identity.statusPath, "foreign\n", { mode: 0o600 });
  const exists = fs.existsSync;
  fs.existsSync = (target) => target === identity.statusPath ? false : exists(target);
  try { assert.throws(() => service.writeStatus(identity, { enabled: true, phase: "starting" }), (error) => error.code === "EEXIST"); }
  finally { fs.existsSync = exists; }
  assert.equal(fs.readFileSync(identity.statusPath, "utf8"), "foreign\n");
});

test("replacement UUID collision preserves the pre-existing temporary file", { concurrency: false }, (t) => {
  const item = fixture(t);
  const identity = service.deriveIdentity(item.configPath, item.config, item.dependencies);
  fs.mkdirSync(identity.serviceDirectory, { recursive: true, mode: 0o700 });
  service.writeStatus(identity, { enabled: true, phase: "starting" });
  const uuid = "00000000-0000-4000-8000-000000000000";
  const temporary = `${identity.statusPath}.${process.pid}.${uuid}.tmp`;
  fs.writeFileSync(temporary, "foreign temporary\n", { mode: 0o600 });
  const randomUUID = require("node:crypto").randomUUID;
  require("node:crypto").randomUUID = () => uuid;
  try { assert.throws(() => service.writeStatus(identity, { enabled: true, phase: "watching" }), (error) => error.code === "EEXIST"); }
  finally { require("node:crypto").randomUUID = randomUUID; }
  assert.equal(fs.readFileSync(temporary, "utf8"), "foreign temporary\n");
  assert.equal(JSON.parse(fs.readFileSync(identity.statusPath, "utf8")).phase, "starting");
});

test("watcher state projects paused, unhealthy, and index-not-ready without fake health", () => {
  assert.deepEqual(runner.projectWatcherState({ stopped: false, running: false, runs: 0, healthErrors: [], resources: { background: "paused", pausedReason: "onBattery" }, queued: true }).phase, "paused");
  assert.equal(runner.projectWatcherState({ stopped: false, running: false, runs: 1, last: { ok: true, complete: true }, healthErrors: [{ reason: "watcherError" }] }).errorCode, "watchError");
  assert.equal(runner.projectWatcherState({ stopped: false, running: false, runs: 0, healthErrors: [] }).errorCode, "indexNotReady");
  assert.equal(runner.projectWatcherState({ stopped: false, running: false, runs: 1, last: { ok: true }, healthErrors: [] }).errorCode, "indexNotReady");
});

test("runner publishes paused and startup-error watcher truth", async (t) => {
  for (const kind of ["paused", "error"]) {
    const item = fixture(t);
    const identity = await prepareOwned(item, kind === "paused" ? 600_000 : 700_000);
    const signals = new EventEmitter();
    const state = kind === "paused"
      ? { stopped: false, running: false, runs: 0, healthErrors: [], resources: { background: "paused", pausedReason: "onBattery" }, queued: true }
      : { stopped: false, running: false, runs: 0, healthErrors: [{ reason: "maintenance", error: "/private/secret" }], queued: false };
    let interval;
    const running = runner.runService({ configPath: item.configPath }, {
      identity, signals, now: item.dependencies.now,
      setInterval: (callback) => { interval = callback; return 1; }, clearInterval: () => {},
      watch: async () => ({ ok: true, stop: async () => { state.stopped = true; }, reconcileNow: async () => {}, getState: () => ({ ...state }) }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    const publicStatus = JSON.parse(fs.readFileSync(identity.statusPath, "utf8"));
    assert.equal(publicStatus.phase, kind === "paused" ? "paused" : "degraded");
    assert.equal(publicStatus.errorCode, kind === "paused" ? "resourcePaused" : "watchError");
    assert.equal(JSON.stringify(publicStatus).includes("/private/secret"), false);
    assert.equal(typeof interval, "function");
    signals.emit("SIGTERM");
    await running;
  }
});

test("runner lastRun advances only when the completed watcher run count advances", async (t) => {
  const item = fixture(t);
  let clock = 750_000;
  const identity = await prepareOwned(item, clock);
  const signals = new EventEmitter();
  let interval;
  const state = { stopped: false, running: false, runs: 1, last: { ok: true, complete: true, status: "unchanged" }, healthErrors: [], resources: { background: "ready" }, queued: false };
  const running = runner.runService({ configPath: item.configPath }, {
    identity, signals, now: () => clock,
    setInterval: (callback) => { interval = callback; return 1; }, clearInterval: () => {},
    watch: async () => ({ ok: true, stop: async () => { state.stopped = true; }, reconcileNow: async () => {}, getState: () => ({ ...state }) }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const completedAt = JSON.parse(fs.readFileSync(identity.statusPath, "utf8")).lastRun;
  assert.equal(completedAt, null);
  clock += 1_000;
  await interval();
  assert.equal(JSON.parse(fs.readFileSync(identity.statusPath, "utf8")).lastRun, completedAt);
  state.resources = { background: "paused" };
  clock += 1_000;
  await interval();
  assert.equal(JSON.parse(fs.readFileSync(identity.statusPath, "utf8")).lastRun, completedAt);
  state.runs += 1;
  state.resources = { background: "ready" };
  clock += 1_000;
  await interval();
  assert.equal(JSON.parse(fs.readFileSync(identity.statusPath, "utf8")).lastRun, new Date(clock).toISOString());
  signals.emit("SIGTERM");
  await running;
});

test("runner records a completed startup callback before the watcher is assigned", async (t) => {
  const item = fixture(t);
  const clock = 780_000;
  const identity = await prepareOwned(item, clock);
  const signals = new EventEmitter();
  const state = { stopped: false, running: false, runs: 1, last: { ok: true, complete: true, status: "updated" }, healthErrors: [], resources: { background: "ready" }, queued: false };
  const running = runner.runService({ configPath: item.configPath }, {
    identity, signals, now: () => clock,
    setInterval: () => 1, clearInterval: () => {},
    watch: async (_configPath, options) => {
      options.onReconcile({ runs: 1, result: state.last });
      return { ok: true, stop: async () => { state.stopped = true; }, reconcileNow: async () => {}, getState: () => ({ ...state }) };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const publicStatus = JSON.parse(fs.readFileSync(identity.statusPath, "utf8"));
  assert.equal(publicStatus.lastRun, new Date(clock).toISOString());
  assert.equal(publicStatus.lastStatus, "updated");
  signals.emit("SIGTERM");
  await running;
});

test("runner uses a completed callback count when watcher state has not caught up", async (t) => {
  const item = fixture(t);
  let clock = 790_000;
  const identity = await prepareOwned(item, clock);
  const signals = new EventEmitter();
  let onReconcile;
  const state = { stopped: false, running: false, runs: 1, last: { ok: true, complete: true, status: "unchanged" }, healthErrors: [], resources: { background: "ready" }, queued: false };
  const running = runner.runService({ configPath: item.configPath }, {
    identity, signals, now: () => clock,
    setInterval: () => 1, clearInterval: () => {},
    watch: async (_configPath, options) => {
      onReconcile = options.onReconcile;
      return { ok: true, stop: async () => { state.stopped = true; }, reconcileNow: async () => {}, getState: () => ({ ...state }) };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  clock += 1_000;
  onReconcile({ runs: 2, result: { ok: true, complete: true, status: "updated" } });
  const publicStatus = JSON.parse(fs.readFileSync(identity.statusPath, "utf8"));
  assert.equal(publicStatus.lastRun, new Date(clock).toISOString());
  assert.equal(publicStatus.lastStatus, "updated");
  signals.emit("SIGTERM");
  await running;
});

test("clock-gap wake reports no-op and failure from watcher state", async (t) => {
  for (const kind of ["noop", "failure"]) {
    const item = fixture(t);
    let clock = kind === "noop" ? 800_000 : 900_000;
    const identity = await prepareOwned(item, clock);
    const signals = new EventEmitter();
    let interval;
    const state = { stopped: false, running: false, runs: 1, last: { ok: true, complete: true, status: "unchanged" }, healthErrors: [], resources: { background: "ready" }, queued: false };
    const running = runner.runService({ configPath: item.configPath }, {
      identity, signals, now: () => clock,
      setInterval: (callback) => { interval = callback; return 1; }, clearInterval: () => {},
      watch: async () => ({
        ok: true, stop: async () => { state.stopped = true; }, getState: () => ({ ...state }),
        reconcileNow: async () => { if (kind === "failure") throw new Error("raw wake failure /secret"); },
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    clock += 150_000;
    interval();
    await new Promise((resolve) => setImmediate(resolve));
    const publicStatus = JSON.parse(fs.readFileSync(identity.statusPath, "utf8"));
    assert.equal(publicStatus.errorCode, kind === "noop" ? "wakeNoop" : "wakeFailed");
    assert.equal(JSON.stringify(publicStatus).includes("secret"), false);
    signals.emit("SIGTERM");
    await running;
  }
});

test("runner serializes overlapping ticks and drains an active tick before stopped heartbeat", async (t) => {
  const item = fixture(t);
  let clock = 1_000_000;
  const identity = await prepareOwned(item, clock);
  const signals = new EventEmitter();
  let interval;
  let reconciles = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const state = { stopped: false, running: false, runs: 1, last: { ok: true, complete: true, status: "unchanged" }, healthErrors: [], resources: { background: "ready" }, queued: false };
  const running = runner.runService({ configPath: item.configPath }, {
    identity, signals, now: () => clock,
    setInterval: (callback) => { interval = callback; return 1; }, clearInterval: () => {},
    watch: async () => ({
      ok: true, getState: () => ({ ...state }),
      reconcileNow: async () => { reconciles += 1; await blocked; state.runs += 1; },
      stop: async () => { state.stopped = true; },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  clock += 150_000;
  interval(); interval();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reconciles, 1);
  signals.emit("SIGHUP");
  release();
  const result = await running;
  assert.equal(result.phase, "stopped");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(fs.readFileSync(identity.statusPath, "utf8")).phase, "stopped");
});

test("startup heartbeat publication failure stops before watch and removes temporary output", { concurrency: false }, async (t) => {
  const item = fixture(t);
  const identity = await prepareOwned(item, 1_100_000);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === identity.statusPath) { const error = new Error("disk full"); error.code = "ENOSPC"; throw error; }
    return rename(from, to);
  };
  let watched = false;
  let result;
  try {
    result = await runner.runService({ configPath: item.configPath }, { identity, now: item.dependencies.now, watch: async () => { watched = true; } });
  } finally { fs.renameSync = rename; }
  assert.equal(result.errorCode, "heartbeatPublicationFailed");
  assert.equal(watched, false);
  assert.equal(fs.readdirSync(identity.serviceDirectory).some((name) => name.endsWith(".tmp")), false);
});

test("outer bridge bounds nested output and real Node 24 status stays cheap-routing", (t) => {
  const item = fixture(t);
  const statusChild = require("node:child_process").spawnSync(process.execPath, [serviceEntrypoint, "--node24", node24, "status", "--config", item.configPath], { encoding: "utf8" });
  const statusResult = JSON.parse(statusChild.stdout);
  assert.equal(statusResult.taskClass, "cheap_routing");
  assert.equal(Object.keys(statusResult).length, 13);

  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "myos-service-output-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const noisyNode = path.join(directory, "node24");
  fs.writeFileSync(noisyNode, `#!/usr/bin/env node
if(process.argv[2]==="--version"){process.stdout.write("v24.1.0\\n");process.exit(0)}
process.stdout.write(JSON.stringify({value:"x".repeat(9000)})+"\\n")
`, { mode: 0o700 });
  const noisy = require("node:child_process").spawnSync(process.execPath, [serviceEntrypoint, "--node24", noisyNode, "status", "--config", item.configPath], { encoding: "utf8" });
  assert.equal(JSON.parse(noisy.stdout).status, "runtimeSpawnFailed");
});

test("outer bridge rejects nested private fields and unknown error codes", (t) => {
  const item = fixture(t);
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "myos-service-malicious-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const secret = path.join(item.base, "private-secret");
  const outputs = [
    { ok: false, status: "serviceFailed", taskClass: "cheap_routing", complianceLane: "unattended_local", stdout: { path: secret, snippet: "token=value" } },
    { ok: false, status: `UNKNOWN_${secret}`, taskClass: "cheap_routing", complianceLane: "unattended_local" },
  ];
  for (const [index, output] of outputs.entries()) {
    const fake = path.join(directory, `node24-${index}`);
    fs.writeFileSync(fake, `#!/usr/bin/env node
if(process.argv[2]==="--version"){process.stdout.write("v24.1.0\\n");process.exit(0)}
process.stdout.write(${JSON.stringify(`${JSON.stringify(output)}\n`)})
`, { mode: 0o700 });
    const child = require("node:child_process").spawnSync(process.execPath, [serviceEntrypoint, "--node24", fake, "status", "--config", item.configPath], { encoding: "utf8" });
    const result = JSON.parse(child.stdout);
    assert.deepEqual(result, {
      ok: false, status: "invalidRuntimeOutput", taskClass: "cheap_routing", complianceLane: "unattended_local",
    });
    assert.equal(child.stdout.includes(secret), false);
    assert.equal(child.stdout.includes("token=value"), false);
  }
});

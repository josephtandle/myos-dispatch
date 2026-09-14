"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const packageJson = require("../package.json");
const entrypoint = path.resolve(__dirname, "../bin/myos-search-dispatch.js");
const node22 = process.env.MYOS_TEST_NODE22;

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "myos-search-dispatch-test-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writePrivateJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function makeEnabledFixture(t) {
  const directory = temporaryDirectory(t);
  const dispatchRoot = path.join(directory, "dispatch");
  fs.mkdirSync(path.join(dispatchRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(dispatchRoot, "bin"), { recursive: true });
  for (const relative of ["src/workspace-context.js", "src/capability-router.js", "bin/myos-search.js"]) {
    fs.writeFileSync(path.join(dispatchRoot, relative), "module.exports = {};\n", { mode: 0o600 });
  }
  writePrivateJson(path.join(dispatchRoot, "capabilities-index.json"), {
    version: 7,
    scan_dir: dispatchRoot,
    lanes: { worker_skill: { description: "preserve me" } },
    metadata: { canary: "BASELINE_CANARY" },
    capabilities: [{ id: "worker:existing", execution_lane: "worker_skill" }],
  });
  const node24 = path.join(directory, "node24");
  fs.writeFileSync(node24, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const configPath = path.join(directory, "local-search.json");
  writePrivateJson(configPath, { version: 1, enabled: false });
  const settingsPath = path.join(directory, "settings.json");
  writePrivateJson(settingsPath, { version: 1, enabled: true, node24, configPath });
  return { directory, dispatchRoot, node24, configPath, settingsPath };
}

test("registers the explicit Dispatch local-search command and exposes help on the current runtime", () => {
  assert.equal(packageJson.bin["myos-search-dispatch"], "bin/myos-search-dispatch.js");
  const child = spawnSync(process.execPath, [entrypoint, "--help"], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, "help");
  assert.equal(result.taskClass, "cheap_routing");
  assert.equal(result.complianceLane, "unattended_local");
  assert.match(result.usage, /--dispatch-root ABSOLUTE_PATH --settings ABSOLUTE_PATH/);
});

test("explicit Node 22 runtime executes the entrypoint contract", {
  skip: node22 ? false : "set MYOS_TEST_NODE22 to exercise the Node 22 compatibility contract",
}, () => {
  const version = spawnSync(node22, ["-p", "process.versions.node.split('.')[0]"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), "22", "MYOS_TEST_NODE22 must point to Node major 22");
  const child = spawnSync(node22, [entrypoint, "--help"], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).status, "help");
});

test("installed package with spaces uses separate real core and its actual sibling describe", (t) => {
  const directory = temporaryDirectory(t);
  const repositoryRoot = path.resolve(__dirname, "..");
  const installRoot = path.join(directory, "installed package with spaces");
  const dispatchRoot = path.join(directory, "separate core with spaces");
  const homeRoot = path.join(directory, "isolated home");
  fs.mkdirSync(path.join(installRoot, "bin"), { recursive: true });
  fs.mkdirSync(path.join(installRoot, "packages/local-search"), { recursive: true });
  fs.mkdirSync(dispatchRoot, { recursive: true });
  fs.mkdirSync(path.join(homeRoot, "workspace"), { recursive: true });
  for (const relativePath of ["bin/myos-search-dispatch.js", "bin/myos-search.js", "bin/myos-local-search.js", "packages/local-search/discovery.js"]) {
    fs.copyFileSync(path.join(repositoryRoot, relativePath), path.join(installRoot, relativePath));
  }
  fs.cpSync(path.join(repositoryRoot, "src"), path.join(dispatchRoot, "src"), { recursive: true });
  writePrivateJson(path.join(homeRoot, "workspace/capabilities-index.json"), {
    version: 1,
    lanes: {},
    capabilities: [{ id: "worker:existing", execution_lane: "worker_skill" }],
  });
  const settingsPath = path.join(directory, "settings.json");
  writePrivateJson(settingsPath, {
    version: 1,
    enabled: true,
    node24: path.join(directory, "unused node24"),
    configPath: path.join(directory, "unused config.json"),
  });

  const child = spawnSync(process.execPath, [
    path.join(installRoot, "bin/myos-search-dispatch.js"),
    "--dispatch-root", dispatchRoot,
    "--settings", settingsPath,
    "describe",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      MYOS_HOME_ROOT: homeRoot,
      MYOS_BACKGROUND_AGENTS_ENABLED: "0",
      MYOS_AUTO_FANOUT: "0",
      MYOS_BACKGROUND_BACKPRESSURE_ENABLED: "0",
    },
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(Object.keys(result).sort(), ["complianceLane", "descriptor", "ok", "status", "taskClass"]);
  assert.equal(result.status, "described");
  assert.equal(result.descriptor.id, "local-search");
  assert.equal(JSON.stringify(result).includes(directory), false);
  assert.deepEqual(fs.readdirSync(directory).filter((name) => name.startsWith("myos-search-dispatch-")), []);
});

test("missing, disabled, unsafe, and unknown input fail before routing or execution", (t) => {
  const { execute } = require(entrypoint);
  const directory = temporaryDirectory(t);
  const disabled = path.join(directory, "disabled.json");
  const unknown = path.join(directory, "unknown.json");
  const unsafe = path.join(directory, "unsafe.json");
  const oversized = path.join(directory, "oversized.json");
  const linked = path.join(directory, "linked.json");
  writePrivateJson(disabled, { version: 1, enabled: false });
  writePrivateJson(unknown, { version: 1, enabled: false, surprise: true });
  writePrivateJson(unsafe, { version: 1, enabled: false });
  fs.writeFileSync(oversized, " ".repeat(16_385), { mode: 0o600 });
  fs.chmodSync(unsafe, 0o644);
  fs.symlinkSync(disabled, linked);
  let routingLoads = 0;
  let childRuns = 0;
  let overlayWrites = 0;
  const adapters = {
    loadRouting() { routingLoads += 1; },
    runProcess() { childRuns += 1; },
    createOverlay() { overlayWrites += 1; },
  };
  const root = path.resolve(__dirname, "..");
  const cases = [
    { argv: ["--dispatch-root", root, "--settings", path.join(directory, "missing.json"), "describe"], status: "missingSettings" },
    { argv: ["--dispatch-root", root, "--settings", disabled, "describe"], status: "disabled" },
    { argv: ["--dispatch-root", root, "--settings", unknown, "describe"], status: "invalidSettings" },
    { argv: ["--dispatch-root", root, "--settings", unsafe, "describe"], status: "unsafeSettings" },
    { argv: ["--dispatch-root", root, "--settings", oversized, "describe"], status: "unsafeSettings" },
    { argv: ["--dispatch-root", root, "--settings", linked, "describe"], status: "unsafeSettings" },
    { argv: ["--dispatch-root", root, "--settings", disabled, "search"], status: "operationDenied" },
    { argv: ["--dispatch-root", root, "--settings", disabled, "watch"], status: "operationDenied" },
    { argv: ["--dispatch-root", root, "--settings", disabled, "index"], status: "operationDenied" },
    { argv: ["--dispatch-root", root, "--settings", disabled, "read"], status: "operationDenied" },
    { argv: ["--dispatch-root", root, "--settings", disabled, "describe", "extra"], status: "invalidArguments" },
    { argv: ["--unknown", root, "--settings", disabled, "describe"], status: "invalidArguments" },
  ];
  for (const { argv, status } of cases) {
    const result = execute(argv, adapters);
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
  }
  assert.equal(routingLoads, 0);
  assert.equal(childRuns, 0);
  assert.equal(overlayWrites, 0);
});

test("settings are read from one no-follow descriptor without an lstat/read race", (t) => {
  const { loadSettings } = require(entrypoint);
  const directory = temporaryDirectory(t);
  const settingsPath = path.join(directory, "settings.json");
  const replacementPath = path.join(directory, "replacement.json");
  writePrivateJson(settingsPath, { version: 1, enabled: false });
  writePrivateJson(replacementPath, {
    version: 1,
    enabled: true,
    node24: path.join(directory, "node24"),
    configPath: path.join(directory, "config.json"),
  });
  const originalLstat = fs.lstatSync;
  fs.lstatSync = function swapAfterCheck(target, ...args) {
    const stat = originalLstat.call(fs, target, ...args);
    if (target === settingsPath) {
      fs.unlinkSync(settingsPath);
      fs.symlinkSync(replacementPath, settingsPath);
    }
    return stat;
  };
  try {
    assert.deepEqual(loadSettings(settingsPath), { error: "disabled" });
  } finally {
    fs.lstatSync = originalLstat;
  }
});

test("settings read rejects a file that grows beyond 16 KiB after fstat", (t) => {
  const { loadSettings } = require(entrypoint);
  const directory = temporaryDirectory(t);
  const settingsPath = path.join(directory, "settings.json");
  writePrivateJson(settingsPath, { version: 1, enabled: false });
  const originalFstat = fs.fstatSync;
  let grew = false;
  fs.fstatSync = function growAfterStat(descriptor, ...args) {
    const stat = originalFstat.call(fs, descriptor, ...args);
    if (!grew) {
      grew = true;
      fs.appendFileSync(settingsPath, " ".repeat(16_385), { mode: 0o600 });
    }
    return stat;
  };
  try {
    assert.deepEqual(loadSettings(settingsPath), { error: "unsafeSettings" });
  } finally {
    fs.fstatSync = originalFstat;
  }
});

test("settings descriptor close failures are sanitized", (t) => {
  const { loadSettings } = require(entrypoint);
  const directory = temporaryDirectory(t);
  const settingsPath = path.join(directory, "settings.json");
  writePrivateJson(settingsPath, { version: 1, enabled: false });
  const originalClose = fs.closeSync;
  fs.closeSync = function closeThenFail(descriptor) {
    originalClose.call(fs, descriptor);
    throw new Error(`${directory}/private-close-error`);
  };
  try {
    assert.deepEqual(loadSettings(settingsPath), { error: "unsafeSettings" });
  } finally {
    fs.closeSync = originalClose;
  }
});

test("settings FIFO is rejected without blocking", (t) => {
  const directory = temporaryDirectory(t);
  const settingsPath = path.join(directory, "settings.fifo");
  const madeFifo = spawnSync("mkfifo", [settingsPath], { encoding: "utf8" });
  assert.equal(madeFifo.status, 0, madeFifo.stderr);

  const child = spawnSync(process.execPath, [
    entrypoint,
    "--dispatch-root", path.resolve(__dirname, ".."),
    "--settings", settingsPath,
    "describe",
  ], { encoding: "utf8", timeout: 1_000 });

  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 1, child.stderr);
  assert.equal(JSON.parse(child.stdout).status, "unsafeSettings");
});

test("enabled calls reject unsafe roots and runtime paths before loading routing", (t) => {
  const { execute } = require(entrypoint);
  const fixture = makeEnabledFixture(t);
  let routingLoads = 0;
  const adapters = { loadRouting() { routingLoads += 1; } };

  const missingNodeSettings = path.join(fixture.directory, "missing-node.json");
  writePrivateJson(missingNodeSettings, {
    version: 1,
    enabled: true,
    node24: path.join(fixture.directory, "missing-node24"),
    configPath: fixture.configPath,
  });
  assert.equal(execute([
    "--dispatch-root", fixture.dispatchRoot,
    "--settings", missingNodeSettings,
    "status",
  ], adapters).status, "unsafeSettingsPath");

  const linkedRoot = path.join(fixture.directory, "linked-dispatch");
  fs.symlinkSync(fixture.dispatchRoot, linkedRoot);
  assert.equal(execute([
    "--dispatch-root", linkedRoot,
    "--settings", fixture.settingsPath,
    "describe",
  ], adapters).status, "unsafeDispatchRoot");

  fs.unlinkSync(path.join(fixture.dispatchRoot, "src/capability-router.js"));
  fs.symlinkSync(path.join(fixture.dispatchRoot, "src/workspace-context.js"), path.join(fixture.dispatchRoot, "src/capability-router.js"));
  assert.equal(execute([
    "--dispatch-root", fixture.dispatchRoot,
    "--settings", fixture.settingsPath,
    "describe",
  ], adapters).status, "unsafeDispatchRoot");
  assert.equal(routingLoads, 0);
});

test("a selected call preserves baseline metadata and removes its private overlay after failure", (t) => {
  const { execute } = require(entrypoint);
  const fixture = makeEnabledFixture(t);
  const baselinePath = path.join(fixture.dispatchRoot, "capabilities-index.json");
  const baselineBefore = fs.readFileSync(baselinePath, "utf8");
  let overlayPath;
  let overlay;
  let overlayDirectoryMode;
  let overlayFileMode;
  let routed;
  let childCall;
  const result = execute([
    "--dispatch-root", fixture.dispatchRoot,
    "--settings", fixture.settingsPath,
    "status",
  ], {
    loadRouting() {
      return {
        capabilitiesIndexPath: baselinePath,
        loadCapabilityIndex() {
          return JSON.parse(fs.readFileSync(baselinePath, "utf8"));
        },
        resolveDispatchPlan(phrase, options) {
          overlayPath = options.indexPath;
          overlay = JSON.parse(fs.readFileSync(overlayPath, "utf8"));
          overlayDirectoryMode = fs.statSync(path.dirname(overlayPath)).mode & 0o777;
          overlayFileMode = fs.statSync(overlayPath).mode & 0o777;
          routed = { phrase, options };
          return {
            branch: "capability",
            capabilityId: "local:search-launcher",
            route: { lane: "worker_skill", candidates: [{ capability: { id: "local:search-launcher" } }] },
          };
        },
      };
    },
    runProcess(command, args, options) {
      childCall = { command, args, options };
      return { status: 9, stdout: "", stderr: `${fixture.directory}/private-token` };
    },
  });

  assert.equal(result.status, "launcherFailed");
  assert.equal(JSON.stringify(result).includes(fixture.directory), false);
  assert.equal(routed.phrase, "local search status");
  assert.equal(routed.options.hookSurface, "local_interactive");
  assert.deepEqual(overlay.metadata, { canary: "BASELINE_CANARY" });
  assert.deepEqual(overlay.lanes, { worker_skill: { description: "preserve me" } });
  assert.equal(overlay.scan_dir, fixture.dispatchRoot);
  assert.equal(overlay.capabilities[0].id, "worker:existing");
  assert.deepEqual(overlay.capabilities[1], {
    id: "local:search-launcher",
    type: "tool",
    execution_lane: "worker_skill",
    source_path: "bin/myos-search.js",
    aliases: ["local search describe", "local search status", "open local search"],
    use_when: ["local search describe", "local search status", "open local search"],
    description: "Explicit local launcher",
    avoid_when: ["content export"],
    priority: 40,
  });
  assert.equal(overlayDirectoryMode, 0o700);
  assert.equal(overlayFileMode, 0o600);
  assert.equal(childCall.command, process.execPath);
  assert.deepEqual(childCall.args, [
    path.resolve(__dirname, "../bin/myos-search.js"),
    "status", "--node24", fixture.node24, "--config", fixture.configPath,
  ]);
  assert.equal(childCall.options.shell, false);
  assert.ok(childCall.options.timeout <= 10_000);
  assert.deepEqual(Object.keys(childCall.options.env).sort(), ["LANG", "LC_ALL", "PATH"]);
  assert.equal(fs.existsSync(overlayPath), false);
  assert.equal(fs.existsSync(path.dirname(overlayPath)), false);
  assert.equal(fs.readFileSync(baselinePath, "utf8"), baselineBefore);
});

test("baseline uses the core router's exported normal-resolution authority", (t) => {
  const { execute } = require(entrypoint);
  const fixture = makeEnabledFixture(t);
  const authorityPath = path.join(fixture.directory, "resolved capability authority.json");
  writePrivateJson(authorityPath, {
    version: 8,
    lanes: { worker_skill: {} },
    metadata: { authority: "normal-resolution" },
    capabilities: [{ id: "worker:existing", execution_lane: "worker_skill" }],
  });
  let loadArguments = -1;
  let overlay;
  const result = execute([
    "--dispatch-root", fixture.dispatchRoot,
    "--settings", fixture.settingsPath,
    "describe",
  ], {
    loadRouting() {
      return {
        capabilitiesIndexPath: authorityPath,
        loadCapabilityIndex(...args) {
          loadArguments = args.length;
          return JSON.parse(fs.readFileSync(authorityPath, "utf8"));
        },
        resolveDispatchPlan(_phrase, options) {
          overlay = JSON.parse(fs.readFileSync(options.indexPath, "utf8"));
          return {
            branch: "capability",
            capabilityId: "local:search-launcher",
            route: { lane: "worker_skill", candidates: [{ capability: { id: "local:search-launcher" } }] },
          };
        },
      };
    },
    runProcess() {
      return { status: 0, stdout: `${JSON.stringify({
        id: "local-search", version: 1, optional: true, taskClass: "cheap_routing",
        commands: ["describe", "status", "open"], resultExport: "none/local_ui_only",
        automaticRouting: false, entrypoint: "myos-search", localInterface: "native_terminal",
      })}\n`, stderr: "" };
    },
  });

  assert.equal(result.status, "described");
  assert.equal(loadArguments, 0);
  assert.deepEqual(overlay.metadata, { authority: "normal-resolution" });
});

test("cleanup failure is surfaced without leaking artifact paths", (t) => {
  const { execute } = require(entrypoint);
  const fixture = makeEnabledFixture(t);
  const baselinePath = path.join(fixture.dispatchRoot, "capabilities-index.json");
  const privateCanary = `${fixture.directory}/private-cleanup-path`;
  let overlayPath;
  const result = execute([
    "--dispatch-root", fixture.dispatchRoot,
    "--settings", fixture.settingsPath,
    "describe",
  ], {
    loadRouting() {
      return {
        capabilitiesIndexPath: baselinePath,
        loadCapabilityIndex() { return JSON.parse(fs.readFileSync(baselinePath, "utf8")); },
        resolveDispatchPlan(_phrase, options) {
          overlayPath = options.indexPath;
          return {
            branch: "capability",
            capabilityId: "local:search-launcher",
            route: { lane: "worker_skill", candidates: [{ capability: { id: "local:search-launcher" } }] },
          };
        },
      };
    },
    cleanupOverlay() { throw new Error(privateCanary); },
    runProcess() {
      return { status: 0, stdout: `${JSON.stringify({
        id: "local-search", version: 1, optional: true, taskClass: "cheap_routing",
        commands: ["describe", "status", "open"], resultExport: "none/local_ui_only",
        automaticRouting: false, entrypoint: "myos-search", localInterface: "native_terminal",
      })}\n`, stderr: "" };
    },
  });

  assert.equal(result.status, "cleanupFailed");
  assert.equal(JSON.stringify(result).includes(privateCanary), false);
  fs.unlinkSync(overlayPath);
  fs.rmdirSync(path.dirname(overlayPath));
});

test("partial overlay creation reports cleanup failure when its exact artifacts cannot be removed", (t) => {
  const { execute } = require(entrypoint);
  const fixture = makeEnabledFixture(t);
  const baselinePath = path.join(fixture.dispatchRoot, "capabilities-index.json");
  const originalWrite = fs.writeFileSync;
  const originalUnlink = fs.unlinkSync;
  let artifactPath;
  fs.writeFileSync = function interruptOverlayWrite(target, ...args) {
    if (path.basename(target) === "capabilities-index.json" && path.basename(path.dirname(target)).startsWith("myos-search-dispatch-")) {
      artifactPath = target;
      originalWrite.call(fs, target, ...args);
      throw new Error(`${fixture.directory}/private-write-error`);
    }
    return originalWrite.call(fs, target, ...args);
  };
  fs.unlinkSync = function rejectArtifactRemoval(target, ...args) {
    if (target === artifactPath) throw new Error(`${fixture.directory}/private-unlink-error`);
    return originalUnlink.call(fs, target, ...args);
  };
  let result;
  try {
    result = execute([
      "--dispatch-root", fixture.dispatchRoot,
      "--settings", fixture.settingsPath,
      "describe",
    ], {
      loadRouting() {
        return {
          capabilitiesIndexPath: baselinePath,
          loadCapabilityIndex() { return JSON.parse(fs.readFileSync(baselinePath, "utf8")); },
          resolveDispatchPlan() { throw new Error("must not route"); },
        };
      },
    });
  } finally {
    fs.writeFileSync = originalWrite;
    fs.unlinkSync = originalUnlink;
  }
  assert.equal(result.status, "cleanupFailed");
  assert.equal(JSON.stringify(result).includes(fixture.directory), false);
  originalUnlink.call(fs, artifactPath);
  fs.rmdirSync(path.dirname(artifactPath));
});

test("cleanup refuses artifacts whose identity is not the one it created", (t) => {
  const { cleanupOverlay } = require(entrypoint);
  const directory = temporaryDirectory(t);
  const overlayDirectory = path.join(directory, "myos-search-dispatch-owned");
  const indexPath = path.join(overlayDirectory, "capabilities-index.json");
  fs.mkdirSync(overlayDirectory, { mode: 0o700 });
  writePrivateJson(indexPath, { capabilities: [] });
  const directoryStat = fs.statSync(overlayDirectory);
  const fileStat = fs.statSync(indexPath);
  assert.throws(() => cleanupOverlay({
    directory: overlayDirectory,
    directoryIdentity: { dev: directoryStat.dev, ino: directoryStat.ino },
    indexPath,
    fileIdentity: { dev: fileStat.dev, ino: fileStat.ino + 1 },
  }), /cleanup failed/);
  assert.equal(fs.existsSync(indexPath), true);
});

test("missing and corrupt capability authorities fail before overlay or child work", (t) => {
  const { execute } = require(entrypoint);
  const fixture = makeEnabledFixture(t);
  const corruptPath = path.join(fixture.directory, "corrupt-index.json");
  fs.writeFileSync(corruptPath, "{", { mode: 0o600 });
  let overlayWrites = 0;
  let childRuns = 0;
  for (const capabilitiesIndexPath of [path.join(fixture.directory, "missing-index.json"), corruptPath]) {
    const result = execute([
      "--dispatch-root", fixture.dispatchRoot,
      "--settings", fixture.settingsPath,
      "describe",
    ], {
      loadRouting() {
        return {
          capabilitiesIndexPath,
          loadCapabilityIndex() { return { capabilities: [] }; },
          resolveDispatchPlan() { throw new Error("must not route"); },
        };
      },
      createOverlay() { overlayWrites += 1; },
      runProcess() { childRuns += 1; },
    });
    assert.equal(result.status, "invalidCapabilityIndex");
  }
  assert.equal(overlayWrites, 0);
  assert.equal(childRuns, 0);
});

test("capability collisions and every decisive alternate route are no-op outcomes", (t) => {
  const { execute } = require(entrypoint);
  const fixture = makeEnabledFixture(t);
  const argv = ["--dispatch-root", fixture.dispatchRoot, "--settings", fixture.settingsPath, "describe"];
  let childRuns = 0;
  let routeCalls = 0;
  const collision = execute(argv, {
    loadRouting() {
      return {
        capabilitiesIndexPath: path.join(fixture.dispatchRoot, "capabilities-index.json"),
        loadCapabilityIndex() { return { capabilities: [{ id: "local:search-launcher" }] }; },
        resolveDispatchPlan() { routeCalls += 1; },
      };
    },
    runProcess() { childRuns += 1; },
  });
  assert.equal(collision.status, "capabilityCollision");
  assert.equal(routeCalls, 0);

  for (const alternate of [
    { branch: "fastpath", capabilityId: "local:search-launcher", topId: "local:search-launcher" },
    { branch: "project", capabilityId: "local:search-launcher", topId: "local:search-launcher" },
    { branch: "data", capabilityId: "local:search-launcher", topId: "local:search-launcher" },
    { branch: "capability", capabilityId: "worker:other", topId: "worker:other" },
  ]) {
    let overlayPath;
    const nonSelected = execute(argv, {
      loadRouting() {
        return {
          capabilitiesIndexPath: path.join(fixture.dispatchRoot, "capabilities-index.json"),
          loadCapabilityIndex() { return JSON.parse(fs.readFileSync(path.join(fixture.dispatchRoot, "capabilities-index.json"), "utf8")); },
          resolveDispatchPlan(_phrase, options) {
            overlayPath = options.indexPath;
            return {
              branch: alternate.branch,
              capabilityId: alternate.capabilityId,
              route: { lane: "worker_skill", candidates: [{ capability: { id: alternate.topId } }] },
            };
          },
        };
      },
      runProcess() { childRuns += 1; },
    });
    assert.equal(nonSelected.status, "notSelected");
    assert.equal(fs.existsSync(overlayPath), false);
    assert.equal(fs.existsSync(path.dirname(overlayPath)), false);
  }
  assert.equal(childRuns, 0);
});

test("forwards only validated descriptor, status, and open acknowledgment fields", (t) => {
  const { execute } = require(entrypoint);
  const fixture = makeEnabledFixture(t);
  const privateCanary = `${fixture.directory}/PRIVATE_CONTENT`;
  const childOutputs = {
    describe: {
      id: "local-search", version: 1, optional: true, taskClass: "cheap_routing",
      commands: ["describe", "status", "open"], resultExport: "none/local_ui_only",
      automaticRouting: false, entrypoint: "myos-search", localInterface: "native_terminal",
      privatePath: privateCanary,
    },
    status: {
      installed: true, runtimeReady: true, enabled: true, localUiAvailable: true,
      status: "passive", privateContent: privateCanary,
    },
    open: { ok: true, status: "launchRequested", command: privateCanary },
  };
  function adaptersFor(operation) {
    return {
      loadRouting() {
        return {
          capabilitiesIndexPath: path.join(fixture.dispatchRoot, "capabilities-index.json"),
          loadCapabilityIndex() { return JSON.parse(fs.readFileSync(path.join(fixture.dispatchRoot, "capabilities-index.json"), "utf8")); },
          resolveDispatchPlan() {
            return {
              branch: "capability", capabilityId: "local:search-launcher",
              route: { lane: "worker_skill", candidates: [{ capability: { id: "local:search-launcher" } }] },
            };
          },
        };
      },
      runProcess() {
        return { status: 0, stdout: `${JSON.stringify(childOutputs[operation])}\n`, stderr: privateCanary };
      },
    };
  }

  const described = execute(["--dispatch-root", fixture.dispatchRoot, "--settings", fixture.settingsPath, "describe"], adaptersFor("describe"));
  assert.equal(described.status, "described");
  assert.deepEqual(Object.keys(described).sort(), ["complianceLane", "descriptor", "ok", "status", "taskClass"]);
  assert.equal(described.descriptor.id, "local-search");
  assert.equal(Object.hasOwn(described.descriptor, "privatePath"), false);

  const status = execute(["--dispatch-root", fixture.dispatchRoot, "--settings", fixture.settingsPath, "status"], adaptersFor("status"));
  assert.deepEqual(status.localSearchStatus, {
    installed: true, runtimeReady: true, enabled: true, localUiAvailable: true, status: "passive",
  });
  assert.deepEqual(Object.keys(status).sort(), ["complianceLane", "localSearchStatus", "ok", "status", "taskClass"]);

  const opened = execute(["--dispatch-root", fixture.dispatchRoot, "--settings", fixture.settingsPath, "open"], adaptersFor("open"));
  assert.deepEqual(opened.openAck, { ok: true, status: "launchRequested" });
  assert.deepEqual(Object.keys(opened).sort(), ["complianceLane", "ok", "openAck", "status", "taskClass"]);
  assert.equal(JSON.stringify([described, status, opened]).includes(privateCanary), false);
  for (const result of [described, status, opened]) {
    assert.equal(result.ok, true);
    assert.equal(result.taskClass, "cheap_routing");
    assert.equal(result.complianceLane, "unattended_local");
  }

  const malformed = execute(["--dispatch-root", fixture.dispatchRoot, "--settings", fixture.settingsPath, "status"], {
    ...adaptersFor("status"),
    runProcess() { return { status: 0, stdout: JSON.stringify({ ...childOutputs.status, status: privateCanary }), stderr: privateCanary }; },
  });
  assert.equal(malformed.status, "invalidLauncherOutput");
  assert.equal(JSON.stringify(malformed).includes(privateCanary), false);
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const packageJson = require("../package.json");
const entrypoint = path.resolve(__dirname, "../bin/myos-find.js");

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "myos-find-test-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeSettings(filePath, value, mode = 0o600) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode });
}

function invoke(args) {
  const child = spawnSync(process.execPath, [entrypoint, ...args], { encoding: "utf8", timeout: 2_000 });
  return { child, result: JSON.parse(child.stdout) };
}

function makeEnabledFixture(t) {
  const directory = temporaryDirectory(t);
  const node24 = path.join(directory, "node24");
  const configPath = path.join(directory, "local-search.json");
  const settingsPath = path.join(directory, "desktop-settings.json");
  fs.writeFileSync(node24, "#!/bin/sh\necho v24.1.0\n", { mode: 0o700 });
  writeSettings(configPath, { version: 1, enabled: true });
  writeSettings(settingsPath, { version: 1, enabled: true, exportToAssistant: true, node24, configPath });
  return { directory, node24, configPath, settingsPath };
}

function waitFor(check, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) { resolve(); return; }
      if (Date.now() >= deadline) { reject(new Error("timed out waiting for controlled process")); return; }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

test("registers the explicit desktop find command and exposes bounded help", () => {
  assert.equal(packageJson.bin["myos-find"], "bin/myos-find.js");
  const child = spawnSync(process.execPath, [entrypoint, "--help"], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, "help");
  assert.equal(result.taskClass, "cheap_routing");
  assert.equal(result.complianceLane, "unattended_local");
  assert.match(result.usage, /myos-find --settings ABSOLUTE <status\|search>/);
});

test("search rejects unknown, disabled, and unexported settings before path access", (t) => {
  const directory = temporaryDirectory(t);
  const missingNode = path.join(directory, "must-not-spawn");
  const missingConfig = path.join(directory, "must-not-read");
  const base = { version: 1, enabled: true, exportToAssistant: true, node24: missingNode, configPath: missingConfig };
  const cases = [
    [{ ...base, surprise: true }, "invalidSettings"],
    [{ version: 1, enabled: true, node24: missingNode, configPath: missingConfig }, "invalidSettings"],
    [{ ...base, enabled: false }, "disabled"],
    [{ ...base, exportToAssistant: false }, "notOptedIn"],
  ];
  for (const [settings, expected] of cases) {
    const settingsPath = path.join(directory, `${expected}.json`);
    writeSettings(settingsPath, settings);
    const { child, result } = invoke(["--settings", settingsPath, "search", "--query", "private query"]);
    assert.equal(child.status, 1);
    assert.equal(result.status, expected);
    assert.equal(JSON.stringify(result).includes("private query"), false);
  }
});

test("search rejects unbounded or ambiguous command options", (t) => {
  const fixture = makeEnabledFixture(t);
  const cases = [
    [],
    ["--query", ""],
    ["--query", "x", "--mode", "indexed-keyword"],
    ["--query", "x", "--roots", "docs,docs"],
    ["--query", "x", "--roots", "../private"],
    ["--query", "x", "--max-results", "9"],
    ["--query", "x", "--max-bytes", "0"],
    ["--query", "x", "--context-bytes", "511"],
    ["--query", "x", "--query", "y"],
    ["--query", "x", "--unknown", "value"],
  ];
  for (const args of cases) {
    const { child, result } = invoke(["--settings", fixture.settingsPath, "search", ...args]);
    assert.equal(child.status, 1);
    assert.equal(result.status, "invalidArguments");
  }
});

test("desktop search defaults to auto while preserving explicit native mode", (t) => {
  const { parseArgs } = require("../packages/local-search/desktop-find");
  const fixture = makeEnabledFixture(t);
  const base = ["--settings", fixture.settingsPath, "search", "--query", "needle"];
  assert.equal(parseArgs(base).mode, "auto");
  assert.equal(parseArgs([...base, "--mode", "native"]).mode, "native");
});

test("disabled and unexported search do not inspect configured paths or spawn", async (t) => {
  const { execute } = require("../packages/local-search/desktop-find");
  const directory = temporaryDirectory(t);
  const sentinels = [path.join(directory, "node24"), path.join(directory, "config")];
  const originalLstat = fs.lstatSync;
  let protectedReads = 0;
  let spawns = 0;
  fs.lstatSync = function trackedLstat(target, ...args) {
    if (sentinels.includes(target)) protectedReads += 1;
    return originalLstat.call(fs, target, ...args);
  };
  try {
    for (const [enabled, exportToAssistant, expected] of [[false, true, "disabled"], [true, false, "notOptedIn"]]) {
      const settingsPath = path.join(directory, `${expected}.json`);
      writeSettings(settingsPath, { version: 1, enabled, exportToAssistant, node24: sentinels[0], configPath: sentinels[1] });
      const result = await execute(["--settings", settingsPath, "search", "--query", "private"], {
        spawn() { spawns += 1; throw new Error("must not spawn"); },
      });
      assert.equal(result.status, expected);
    }
  } finally {
    fs.lstatSync = originalLstat;
  }
  assert.equal(protectedReads, 0);
  assert.equal(spawns, 0);
});

test("settings enforce owner-only regular single-link bounded files and safe ancestry", (t) => {
  const { loadSettings } = require("../packages/local-search/desktop-find");
  const directory = temporaryDirectory(t);
  const valid = { version: 1, enabled: false, exportToAssistant: false, node24: "/unused/node", configPath: "/unused/config" };
  const unsafeParent = path.join(directory, "writable-parent");
  fs.mkdirSync(unsafeParent, { mode: 0o700 });
  const files = {
    permissive: path.join(directory, "permissive.json"),
    oversized: path.join(directory, "oversized.json"),
    target: path.join(directory, "target.json"),
    linked: path.join(directory, "linked.json"),
    hardlink: path.join(directory, "hardlink.json"),
    unsafeAncestry: path.join(unsafeParent, "settings.json"),
  };
  writeSettings(files.permissive, valid, 0o644);
  fs.writeFileSync(files.oversized, " ".repeat(16_385), { mode: 0o600 });
  writeSettings(files.target, valid);
  fs.symlinkSync(files.target, files.linked);
  fs.linkSync(files.target, files.hardlink);
  writeSettings(files.unsafeAncestry, valid);
  fs.chmodSync(unsafeParent, 0o777);
  for (const filePath of Object.values(files)) {
    assert.equal(loadSettings(filePath).error, "unsafeSettings");
  }
});

test("settings reject ownership metadata changes across the bounded descriptor read", (t) => {
  const { loadSettings } = require("../packages/local-search/desktop-find");
  const directory = temporaryDirectory(t);
  const settingsPath = path.join(directory, "settings.json");
  writeSettings(settingsPath, { version: 1, enabled: false, exportToAssistant: false, node24: "/unused/node", configPath: "/unused/config" });
  const originalFstat = fs.fstatSync;
  let changed = false;
  fs.fstatSync = function changeModeAfterFirstStat(descriptor, ...args) {
    const stat = originalFstat.call(fs, descriptor, ...args);
    if (!changed) {
      changed = true;
      fs.chmodSync(settingsPath, 0o644);
    }
    return stat;
  };
  try {
    assert.equal(loadSettings(settingsPath).error, "unsafeSettings");
  } finally {
    fs.fstatSync = originalFstat;
  }
});

test("status reports sanitized opt-in and file availability without paths", (t) => {
  const directory = temporaryDirectory(t);
  const node24 = path.join(directory, "node24");
  const configPath = path.join(directory, "local-search.json");
  const settingsPath = path.join(directory, "desktop-settings.json");
  fs.writeFileSync(node24, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeSettings(configPath, { version: 1, enabled: true });
  writeSettings(settingsPath, { version: 1, enabled: true, exportToAssistant: true, node24, configPath });

  const { child, result } = invoke(["--settings", settingsPath, "status"]);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(result, {
    ok: true,
    status: "available",
    taskClass: "cheap_routing",
    complianceLane: "unattended_local",
    enabled: true,
    exportToAssistant: true,
    runtimeAvailable: true,
    configAvailable: true,
  });
  assert.equal(child.stdout.includes(directory), false);
});

test("status remains passive and sanitized when desktop export is disabled", (t) => {
  const directory = temporaryDirectory(t);
  const settingsPath = path.join(directory, "desktop-settings.json");
  writeSettings(settingsPath, {
    version: 1, enabled: false, exportToAssistant: false,
    node24: path.join(directory, "missing-node"), configPath: path.join(directory, "missing-config"),
  });
  const { child, result } = invoke(["--settings", settingsPath, "status"]);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(result.status, "disabled");
  assert.equal(result.enabled, false);
  assert.equal(result.exportToAssistant, false);
  assert.equal(child.stdout.includes(directory), false);
});

test("search forwards a native request through the fixed Node 24 boundary and preserves provenance", (t) => {
  const directory = temporaryDirectory(t);
  const node24 = path.join(directory, "synthetic-node24");
  const configPath = path.join(directory, "local-search.json");
  const settingsPath = path.join(directory, "desktop-settings.json");
  const packet = {
    ok: true,
    status: "partial",
    taskClass: "cheap_routing",
    complianceLane: "unattended_local",
    negativeIsComplete: false,
    sourceUnavailable: [{ sourceId: "opaque-source", status: "sourceChanged" }],
    results: [{ sourceId: "opaque-source", citation: "local://opaque-source#sha256=abc", snippet: "needle" }],
  };
  fs.writeFileSync(node24, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v24.1.0; exit 0; fi\nprintf '%s\\n' '${JSON.stringify(packet)}'\n`, { mode: 0o700 });
  writeSettings(configPath, { version: 1, enabled: true });
  writeSettings(settingsPath, { version: 1, enabled: true, exportToAssistant: true, node24, configPath });

  const { child, result } = invoke([
    "--settings", settingsPath, "search", "--query", "needle", "--roots", "docs,notes",
    "--max-results", "3", "--max-bytes", "1024", "--context-bytes", "4096",
  ]);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(result.status, "partial");
  assert.equal(result.taskClass, "default_automation");
  assert.equal(result.negativeIsComplete, false);
  assert.deepEqual(result.sourceUnavailable, packet.sourceUnavailable);
  assert.deepEqual(result.results, packet.results);
});

test("qmd-null keyword search returns three citations within the desktop response cap", (t) => {
  const directory = temporaryDirectory(t);
  const root = path.join(directory, "notes");
  const stateDirectory = path.join(directory, "state");
  const configPath = path.join(directory, "local-search.json");
  const settingsPath = path.join(directory, "desktop-settings.json");
  fs.mkdirSync(root);
  for (const name of ["one.md", "two.md", "three.md"]) fs.writeFileSync(path.join(root, name), `desktop-qmd-null-keyword ${name}\n`);
  writeSettings(configPath, {
    version: 1,
    enabled: true,
    stateDirectory,
    roots: [{ id: "notes", path: root, contentEnabled: true, extensions: [".md"] }],
    qmd: null,
  });
  writeSettings(settingsPath, {
    version: 1, enabled: true, exportToAssistant: true, node24: process.execPath, configPath,
  });
  const { child, result } = invoke([
    "--settings", settingsPath, "search", "--query", "desktop-qmd-null-keyword", "--mode", "keyword", "--context-bytes", "4096",
  ]);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(result.results.length, 3);
  assert.equal(result.results.every((item) => typeof item.sourceId === "string" && typeof item.relative === "string" && item.locator), true);
  assert.ok(Buffer.byteLength(child.stdout) <= 4096);
});

test("all declared modes use fixed argv and semantic-capable modes use default automation", async (t) => {
  const { execute } = require("../packages/local-search/desktop-find");
  const fixture = makeEnabledFixture(t);
  for (const [mode, expectedTaskClass] of [
    ["native", "cheap_routing"], ["filename", "cheap_routing"], ["keyword", "cheap_routing"],
    ["semantic", "default_automation"], ["auto", "default_automation"],
  ]) {
    let call;
    const result = await execute(["--settings", fixture.settingsPath, "search", "--query", "needle", "--mode", mode], {
      spawn(command, args, options) {
        call = { command, args, options };
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        process.nextTick(() => {
          child.stdout.end(`${JSON.stringify({ ok: true, status: "completeAsOfSnapshot", negativeIsComplete: true, sourceUnavailable: [] })}\n`);
          child.stderr.end();
          child.emit("close", 0);
        });
        return child;
      },
    });
    assert.equal(result.taskClass, expectedTaskClass);
    assert.equal(call.command, process.execPath);
    assert.equal(call.args[0], path.resolve(__dirname, "../bin/myos-local-search.js"));
    assert.deepEqual(call.args.slice(1), [
      "--node24", fixture.node24, "search", "--config", fixture.configPath,
      "--query", "needle", "--mode", mode, "--max-results", "3", "--max-bytes", "1024",
    ]);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.detached, true);
    assert.deepEqual(Object.keys(call.options.env).sort(), ["LANG", "LC_ALL", "PATH"]);
  }
});

test("timeout terminates the owned child and returns no private process output", async (t) => {
  const { execute } = require("../packages/local-search/desktop-find");
  const fixture = makeEnabledFixture(t);
  const signals = [];
  let controlledChild;
  const result = await execute(["--settings", fixture.settingsPath, "search", "--query", "secret query"], {
    timeoutMs: 10,
    spawn() {
      const child = new EventEmitter();
      controlledChild = child;
      child.pid = 123;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => child.stdout.write("private partial output"));
      return child;
    },
    killProcessGroup(_pid, signal) {
      signals.push(signal);
      if (signal === "SIGTERM") {
        process.nextTick(() => controlledChild.emit("close", null));
        process.nextTick(() => { controlledChild.stdout.end(); controlledChild.stderr.end(); });
      }
    },
  });
  assert.equal(result.status, "timedOut");
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(result).includes("secret query"), false);
});

test("whole-response overflow returns sanitized budgetExceeded JSON", async (t) => {
  const { execute } = require("../packages/local-search/desktop-find");
  const fixture = makeEnabledFixture(t);
  let controlledChild;
  const result = await execute([
    "--settings", fixture.settingsPath, "search", "--query", "secret query", "--context-bytes", "512",
  ], {
    spawn() {
      const child = new EventEmitter();
      controlledChild = child;
      child.pid = 123;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => child.stdout.write(JSON.stringify({ ok: true, results: [{ snippet: "x".repeat(600) }] })));
      return child;
    },
    killProcessGroup(_pid, signal) {
      if (signal === "SIGTERM") process.nextTick(() => {
        controlledChild.stdout.end(); controlledChild.stderr.end(); controlledChild.emit("close", null);
      });
    },
  });
  assert.deepEqual(result, {
    ok: false, status: "budgetExceeded", taskClass: "default_automation", complianceLane: "unattended_local",
  });
  assert.equal(Buffer.byteLength(`${JSON.stringify(result)}\n`) <= 512, true);
});

test("owned process groups drain and finish bounded after TERM-ignoring descendants", async (t) => {
  const { runSearch } = require("../packages/local-search/desktop-find");
  const directory = temporaryDirectory(t);
  const script = path.join(directory, "term-ignoring-wrapper.js");
  fs.writeFileSync(script, [
    '"use strict";',
    'const fs = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    'const pidFile = process.argv[2];',
    'const overflow = process.argv[3] === "overflow";',
    'const descendant = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "inherit" });',
    'fs.writeFileSync(pidFile, String(descendant.pid));',
    'if (overflow) process.stdout.write("x".repeat(1024));',
    'process.on("SIGTERM", () => {});',
    'setInterval(() => {}, 1000);',
  ].join("\n"), { mode: 0o700 });
  const parsed = { query: "needle", mode: "native", numbers: { "--context-bytes": 512 } };
  const settings = { node24: process.execPath, configPath: path.join(directory, "config.json") };
  for (const [kind, expected] of [["timeout", "timedOut"], ["cancel", "cancelled"], ["overflow", "budgetExceeded"]]) {
    const pidFile = path.join(directory, `${kind}.pid`);
    let cancel;
    const startedAt = Date.now();
    const resultPromise = runSearch(parsed, settings, {
      timeoutMs: kind === "timeout" ? 80 : 1_000,
      cleanupGraceMs: 40,
      spawn(_command, _args, options) {
        assert.equal(options.detached, true);
        return spawn(process.execPath, [script, pidFile, kind], options);
      },
    });
    await waitFor(() => fs.existsSync(pidFile));
    if (kind === "cancel") process.emit("SIGINT");
    const result = await resultPromise;
    assert.equal(result.status, expected);
    assert.ok(Date.now() - startedAt < 1_000, `${kind} did not finish bounded`);
    const descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitFor(() => !processExists(descendantPid));
  }
});

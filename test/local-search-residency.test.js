"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const node24 = "/Users/myos/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node";

function darwinFixture(t, names = ["safe.md"]) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "residency-unit-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const paths = names.map((name) => path.join(base, name));
  for (const filePath of paths) fs.writeFileSync(filePath, "body", { mode: 0o600 });
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
  const residencyPath = require.resolve("../packages/local-search/residency");
  delete require.cache[residencyPath];
  t.after(() => { delete require.cache[residencyPath]; });
  return { base, paths, residency: require(residencyPath) };
}

function statRow(filePath, flags = 0) {
  const stat = fs.lstatSync(filePath, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.nlink, stat.uid, stat.mode.toString(8), flags].join(":");
}

function syntheticScript() {
  return `
    const childProcess = require("node:child_process");
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    Object.defineProperty(process, "platform", { value: "darwin" });
    const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "residency-count-"));
    const rootPath = path.join(base, "docs");
    fs.mkdirSync(rootPath, { mode: 0o700 });
    for (let index = 0; index < 111; index += 1) {
      fs.writeFileSync(path.join(rootPath, \`synthetic-\${index}.md\`), "body", { mode: 0o600 });
    }
    let statProcesses = 0;
    childProcess.execFileSync = (_command, args) => {
      statProcesses += 1;
      const format = args[1];
      return args.slice(2).map((filePath) => {
        const stat = fs.lstatSync(filePath, { bigint: true });
        if (format === "%f") return "0";
        return [stat.dev, stat.ino, stat.size, stat.nlink, stat.uid, stat.mode.toString(8), 0].join(":");
      }).join("\\n") + "\\n";
    };
    const { normalizeConfig } = require(${JSON.stringify(path.join(__dirname, "../packages/local-search/config"))});
    const { search } = require(${JSON.stringify(path.join(__dirname, "../packages/local-search/search"))});
    const config = normalizeConfig({
      enabled: true,
      stateDirectory: path.join(base, "state"),
      roots: [{ id: "docs", path: rootPath, contentEnabled: true, extensions: [".md"], maxFiles: 111, maxFileBytes: 4096 }],
      budgets: { queryDeadlineMs: 5000, indexDeadlineMs: 5000, reserveBytes: 1, reserveFraction: 0.000001, quotaBytes: 1024 ** 2 },
    });
    const startedAt = performance.now();
    search(config, { query: "synthetic", mode: "native" }).then((result) => {
      fs.rmSync(base, { recursive: true, force: true });
      process.stdout.write(JSON.stringify({ statProcesses, results: result.results.length, durationMs: performance.now() - startedAt }));
    }, (error) => { process.stderr.write(error.stack); process.exitCode = 1; });
  `;
}

test("native discovery batches residency stat processes by more than five times", { concurrency: false }, (t) => {
  assert.equal(fs.existsSync(node24), true);
  const child = childProcess.spawnSync(node24, ["-e", syntheticScript()], { encoding: "utf8", timeout: 10_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const measured = JSON.parse(child.stdout);
  assert.equal(measured.results, 8);
  assert.ok(measured.statProcesses <= 22, `expected <=22 stat processes, received ${measured.statProcesses}`);
  t.diagnostic(`aggregate statProcesses=${measured.statProcesses} durationMs=${measured.durationMs.toFixed(3)}`);
});

test("cancellation during a residency batch discards provisional evidence", { concurrency: false }, async (t) => {
  const fx = darwinFixture(t);
  const controller = new AbortController();
  const originalExec = childProcess.execFileSync;
  let flags = 0;
  childProcess.execFileSync = (_command, args) => {
    if (args[1].includes(":")) controller.abort();
    return `${args.slice(2).map((filePath) => statRow(filePath, flags)).join("\n")}\n`;
  };
  t.after(() => { childProcess.execFileSync = originalExec; });

  const result = await fx.residency.runWithResidencyScope(async () => {
    fx.residency.primeResidency(fx.paths, Date.now() + 1000, controller.signal);
    flags = 0x40000000;
    return fx.residency.residentOnMac(fx.paths[0], fs.lstatSync(fx.paths[0], { bigint: true }));
  });
  assert.equal(result, false);
});

test("batch rows map exactly to paths containing spaces and newlines", { concurrency: false }, (t) => {
  const fx = darwinFixture(t, ["space name.md", "line\nbreak.md"]);
  const originalExec = childProcess.execFileSync;
  const calls = [];
  childProcess.execFileSync = (command, args) => {
    calls.push([command, args]);
    return `${args.slice(2).map((filePath, index) => statRow(filePath, index === 1 ? 0x40000000 : 0)).join("\n")}\n`;
  };
  t.after(() => { childProcess.execFileSync = originalExec; });

  const results = fx.residency.runWithResidencyScope(() => {
    fx.residency.primeResidency(fx.paths, Date.now() + 1000);
    return fx.paths.map((filePath) => fx.residency.residentOnMac(filePath, fs.lstatSync(filePath, { bigint: true })));
  });
  assert.deepEqual(results, [true, false]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["/usr/bin/stat", ["-f", "%d:%i:%z:%l:%u:%p:%f", ...fx.paths]]);
});

test("malformed, missing, overflowed, timed-out, and raced batch evidence fails closed", { concurrency: false }, (t) => {
  const fx = darwinFixture(t, ["first.md", "second.md"]);
  const originalExec = childProcess.execFileSync;
  t.after(() => { childProcess.execFileSync = originalExec; });
  const malformed = [
    () => `${statRow(fx.paths[0])}\n`,
    () => `${statRow(fx.paths[0])}\nnot:numeric\n`,
    () => `${statRow(fx.paths[0])}\n${statRow(fx.paths[1], Number.MAX_SAFE_INTEGER)}0\n`,
    () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); },
  ];
  for (const batchResult of malformed) {
    childProcess.execFileSync = (_command, args) => args[1].includes(":") ? batchResult() : "1073741824\n";
    const allowed = fx.residency.runWithResidencyScope(() => {
      fx.residency.primeResidency(fx.paths, Date.now() + 1000);
      return fx.residency.residentOnMac(fx.paths[0], fs.lstatSync(fx.paths[0], { bigint: true }));
    });
    assert.equal(allowed, false);
  }

  let changed = false;
  childProcess.execFileSync = (_command, args) => {
    if (args[1].includes(":")) {
      fs.writeFileSync(fx.paths[0], "replacement body");
      changed = true;
      return `${statRow(fx.paths[0])}\n${statRow(fx.paths[1])}\n`;
    }
    return "1073741824\n";
  };
  const raced = fx.residency.runWithResidencyScope(() => {
    fx.residency.primeResidency(fx.paths, Date.now() + 1000);
    return fx.residency.residentOnMac(fx.paths[0], fs.lstatSync(fx.paths[0], { bigint: true }));
  });
  assert.equal(changed, true);
  assert.equal(raced, false);
});

test("residency evidence is isolated between concurrent and subsequent requests", { concurrency: false }, async (t) => {
  const fx = darwinFixture(t);
  const originalExec = childProcess.execFileSync;
  let flags = 0;
  childProcess.execFileSync = (_command, args) => `${args.slice(2).map((filePath) => statRow(filePath, flags)).join("\n")}\n`;
  t.after(() => { childProcess.execFileSync = originalExec; });
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });

  const primed = fx.residency.runWithResidencyScope(async () => {
    fx.residency.primeResidency(fx.paths, Date.now() + 1000);
    await barrier;
    return fx.residency.residentOnMac(fx.paths[0], fs.lstatSync(fx.paths[0], { bigint: true }));
  });
  flags = 0x40000000;
  const concurrent = fx.residency.runWithResidencyScope(() =>
    fx.residency.residentOnMac(fx.paths[0], fs.lstatSync(fx.paths[0], { bigint: true })));
  release();
  assert.deepEqual(await Promise.all([primed, concurrent]), [true, false]);
  const subsequent = fx.residency.runWithResidencyScope(() =>
    fx.residency.residentOnMac(fx.paths[0], fs.lstatSync(fx.paths[0], { bigint: true })));
  assert.equal(subsequent, false);
});

test("residency batches cap path count and argv bytes", { concurrency: false }, (t) => {
  const names = Array.from({ length: 129 }, (_, index) => `${String(index).padStart(3, "0")}-${"x".repeat(180)}.md`);
  const fx = darwinFixture(t, names);
  const originalExec = childProcess.execFileSync;
  const batchSizes = [];
  const argvBytes = [];
  childProcess.execFileSync = (_command, args) => {
    batchSizes.push(args.length - 2);
    argvBytes.push(args.reduce((total, value) => total + Buffer.byteLength(value) + 1, 0));
    return `${args.slice(2).map((filePath) => statRow(filePath)).join("\n")}\n`;
  };
  t.after(() => { childProcess.execFileSync = originalExec; });
  fx.residency.runWithResidencyScope(() => fx.residency.primeResidency(fx.paths, Date.now() + 5000));
  assert.equal(batchSizes.reduce((total, count) => total + count, 0), 129);
  assert.ok(batchSizes.every((count) => count <= 128), JSON.stringify(batchSizes));
  assert.ok(argvBytes.every((bytes) => bytes <= 32 * 1024), JSON.stringify(argvBytes));
});

test("scope retains owner, hardlink, and symlink denials with residency evidence", { concurrency: false }, (t) => {
  const fx = darwinFixture(t, ["owner.md", "linked.md", "target.md"]);
  const hardlink = path.join(fx.base, "hardlink.md");
  const symlink = path.join(fx.base, "symlink.md");
  fs.linkSync(fx.paths[1], hardlink);
  fs.symlinkSync(fx.paths[2], symlink);
  const originalExec = childProcess.execFileSync;
  childProcess.execFileSync = (_command, args) => `${args.slice(2).map((filePath) => statRow(filePath)).join("\n")}\n`;
  t.after(() => { childProcess.execFileSync = originalExec; });
  const scopePath = require.resolve("../packages/local-search/scope");
  delete require.cache[scopePath];
  const { verifyMetadata } = require(scopePath);
  t.after(() => { delete require.cache[scopePath]; });
  const root = { id: "docs", path: fx.base, contentEnabled: true, extensions: [".md"], maxFiles: 20, maxFileBytes: 4096 };

  const originalLstat = fs.lstatSync;
  fs.lstatSync = (target, ...args) => {
    const stat = originalLstat(target, ...args);
    if (target !== fx.paths[0]) return stat;
    const foreign = Object.create(stat);
    Object.defineProperty(foreign, "uid", { value: BigInt(stat.uid) + 1n });
    return foreign;
  };
  const owner = verifyMetadata(root, fx.paths[0]);
  fs.lstatSync = originalLstat;
  assert.equal(owner.reason, "foreignOwner");
  assert.equal(verifyMetadata(root, fx.paths[1]).reason, "hardlinkDenied");
  assert.equal(verifyMetadata(root, symlink).reason, "symlinkDenied");
});

test("partial native results report byte exhaustion only when the byte limit is actually reached", { concurrency: false }, () => {
  const child = childProcess.spawnSync(node24, ["-e", `
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { normalizeConfig } = require(${JSON.stringify(path.join(__dirname, "../packages/local-search/config"))});
    const { search } = require(${JSON.stringify(path.join(__dirname, "../packages/local-search/search"))});
    const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "content-exhaustion-"));
    const root = path.join(base, "docs");
    const state = path.join(base, "state");
    fs.mkdirSync(root); fs.mkdirSync(state);
    fs.writeFileSync(path.join(root, "small.md"), "unrelated");
    fs.writeFileSync(path.join(state, "catalogue.json"), "malformed", { mode: 0o600 });
    const config = normalizeConfig({ enabled: true, stateDirectory: state,
      roots: [{ id: "docs", path: root, contentEnabled: true, extensions: [".md"], maxFiles: 10, maxFileBytes: 4096 }],
      budgets: { queryDeadlineMs: 2000, maxContentScanBytes: 4096, reserveBytes: 1, reserveFraction: 0.000001, quotaBytes: 1024 ** 2 } });
    search(config, { query: "missing-term", mode: "native" }).then((result) => {
      fs.rmSync(base, { recursive: true, force: true });
      process.stdout.write(JSON.stringify({ status: result.status, contentScan: result.contentScan }));
    });
  `], { encoding: "utf8", timeout: 5000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    status: "partial", contentScan: { bytes: 9, limit: 4096, exceeded: false },
  });
});

"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function statRow(filePath, flags) {
  const stat = fs.lstatSync(filePath, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.nlink, stat.uid, stat.mode.toString(8), flags].join(":");
}

test("auto reconciliation batches discovery and fresh metadata residency without stale reuse", { concurrency: false }, (t) => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "auto-residency-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const rootPath = path.join(base, "docs");
  fs.mkdirSync(rootPath, { mode: 0o700 });
  const names = Array.from({ length: 129 }, (_, index) => `${String(index).padStart(3, "0")}.md`);
  for (const name of names) fs.writeFileSync(path.join(rootPath, name), "body", { mode: 0o600 });

  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
  for (const moduleName of ["residency", "scope", "catalogue"]) delete require.cache[require.resolve(`../packages/local-search/${moduleName}`)];
  t.after(() => {
    for (const moduleName of ["residency", "scope", "catalogue"]) delete require.cache[require.resolve(`../packages/local-search/${moduleName}`)];
  });

  const originalExec = childProcess.execFileSync;
  const batches = [];
  let flags = 0;
  childProcess.execFileSync = (_command, args) => {
    if (args[1].includes(":")) {
      batches.push(args.slice(2));
      return `${args.slice(2).map((filePath) => statRow(filePath, flags)).join("\n")}\n`;
    }
    return `${flags}\n`;
  };
  t.after(() => { childProcess.execFileSync = originalExec; });

  const { normalizeConfig } = require("../packages/local-search/config");
  const { reconcile, sourceId } = require("../packages/local-search/catalogue");
  const config = normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "docs", path: rootPath, contentEnabled: false, extensions: [".md"], maxFiles: 129, maxFileBytes: 4096 }],
  });
  const first = reconcile(config, { publish: false, deadline: Date.now() + 5000 });

  assert.equal(first.catalogue.records.length, names.length);
  assert.deepEqual(first.catalogue.records.map((record) => record.relative), names);
  for (const record of first.catalogue.records) {
    assert.equal(record.rootId, "docs");
    assert.equal(record.sourceId, sourceId("docs", record.relative));
    assert.equal(record.path, path.join(rootPath, record.relative));
    assert.equal(typeof record.size, "number");
    assert.equal(typeof record.mtimeMs, "number");
    assert.equal(typeof record.metadataFingerprint, "string");
  }
  assert.equal(batches.reduce((total, batch) => total + batch.length, 0), names.length * 2);
  assert.ok(batches.every((batch) => batch.length <= 128));
  assert.deepEqual(batches.flat(), [...names.map((name) => path.join(rootPath, name)), ...names.map((name) => path.join(rootPath, name))]);

  flags = 0x40000000;
  const second = reconcile(config, { publish: false, deadline: Date.now() + 5000 });
  assert.equal(second.catalogue.records.length, 0);
  assert.equal(second.unavailable.filter((item) => item.reason === "cloudPlaceholderOrFlagsUnavailable").length, names.length);
});

test("partial discovery and an early metadata denial retain later reconciliation chunks", { concurrency: false }, (t) => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "auto-residency-partial-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const rootPath = path.join(base, "docs");
  fs.mkdirSync(rootPath, { mode: 0o700 });
  const names = Array.from({ length: 130 }, (_, index) => `${String(index).padStart(3, "0")}.md`);
  for (const name of names) fs.writeFileSync(path.join(rootPath, name), "body", { mode: 0o600 });

  const scopePath = require.resolve("../packages/local-search/scope");
  const cataloguePath = require.resolve("../packages/local-search/catalogue");
  delete require.cache[cataloguePath];
  const scope = require(scopePath);
  const verifyMetadata = scope.verifyMetadata;
  scope.verifyMetadata = (root, filePath) => filePath.endsWith("000.md")
    ? { ok: false, status: "sourceUnavailable", reason: "testMetadataDenied", path: filePath }
    : verifyMetadata(root, filePath);
  t.after(() => {
    scope.verifyMetadata = verifyMetadata;
    delete require.cache[cataloguePath];
  });

  const { normalizeConfig } = require("../packages/local-search/config");
  const { reconcile } = require("../packages/local-search/catalogue");
  const config = normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "docs", path: rootPath, contentEnabled: false, extensions: [".md"], maxFiles: 129, maxFileBytes: 4096 }],
  });
  const result = reconcile(config, { publish: false, deadline: Date.now() + 5000 });

  assert.equal(result.complete, false);
  assert.deepEqual(result.catalogue.records.map((record) => record.relative), names.slice(1, 129));
  assert.equal(result.unavailable.some((item) => item.reason === "testMetadataDenied"), true);
});

test("discovery preserves bigint-stat fractional modification milliseconds", { concurrency: false }, (t) => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "auto-residency-mtime-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const rootPath = path.join(base, "docs");
  const filePath = path.join(rootPath, "note.md");
  fs.mkdirSync(rootPath, { mode: 0o700 });
  fs.writeFileSync(filePath, "body", { mode: 0o600 });

  const expectedNanoseconds = 1_700_000_000_000_123_456n;
  const expectedMilliseconds = Number(expectedNanoseconds / 1_000_000n) + Number(expectedNanoseconds % 1_000_000n) / 1_000_000;
  const originalLstat = fs.lstatSync;
  fs.lstatSync = function fractionalBigintMtime(target, options) {
    const stat = originalLstat.call(fs, target, options);
    if (target !== filePath || !options || !options.bigint) return stat;
    const altered = Object.create(stat);
    Object.defineProperty(altered, "mtimeNs", { value: expectedNanoseconds });
    return altered;
  };
  t.after(() => { fs.lstatSync = originalLstat; });

  const { discoverRoot } = require("../packages/local-search/scope");
  const discovered = discoverRoot({
    path: rootPath, contentEnabled: false, extensions: [".md"], maxFiles: 1, maxFileBytes: 4096,
  }, Date.now() + 5000);

  assert.equal(discovered.files[0].mtimeMs, expectedMilliseconds);
});

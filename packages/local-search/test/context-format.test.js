"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { parse } = require("../bin/local-search");
const { formatContext } = require("../context-format");
const { writeReceipt } = require("../context-receipt");

const PRODUCT_TEST_NODE = process.env.MYOS_TEST_NODE24 || process.execPath;

test("context format requires an explicit private receipt directory", () => {
  const parsed = parse([
    "search", "--config", "/tmp/config.json", "--format", "context",
    "--receipt-dir", "/tmp/private-receipts", "--context-bytes", "512",
  ]);
  assert.equal(parsed.values["--format"], "context");
  assert.equal(parsed.values["--context-bytes"], "512");
  assert.throws(() => parse(["search", "--config", "/tmp/config.json", "--format", "context"]), /receipt-dir/);
  assert.throws(() => parse(["search", "--config", "/tmp/config.json", "--format", "context", "--receipt-dir", "/tmp/private", "--context-bytes", "511"]), /context-bytes/);
  assert.throws(() => parse(["search", "--config", "/tmp/config.json", "--receipt-dir", "/tmp/private"]), /context options/);
});

function privateDirectory(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "context-receipt-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function receipt() {
  return { name: "11111111-1111-4111-8111-111111111111.json", resultSha256: "a".repeat(64) };
}

function captureError(run) {
  try { run(); } catch (error) { return error; }
  assert.fail("expected operation to throw");
}

test("context line is byte-bounded, control-safe, Unicode-safe, and preserves partial source qualifications", () => {
  const source = {
    sourceId: "office", rootId: "docs", relative: "report.docx", sourceReadAt: "2026-09-14T00:00:00.000Z",
    snippet: "prefix🙂\\u001b\\u009b".replace("\\u001b", "\u001b").replace("\\u009b", "\u009b") + "x".repeat(2000),
    extractedTextLocator: { line: 3, byteOffset: 9 }, sourceLocators: [{ page: 2 }],
    coverage: { status: "partial", limitations: ["tables"] }, complete: false, truncated: true,
  };
  const output = formatContext({
    ok: true, status: "partial", negativeIsComplete: false, semanticPending: true, deadlineExpired: true,
    contentScan: { bytes: 40, limit: 40, exceeded: true }, sourceUnavailable: [{ reason: "sizeLimit" }], results: [source, { sourceId: "omitted" }],
  }, { contextBytes: 1024, receipt: receipt() });
  assert.ok(Buffer.byteLength(output) <= 1024);
  assert.match(output, /\\u001b/);
  assert.match(output, /\\u009b/);
  assert.doesNotMatch(output, /[\u001b\u007f-\u009f]/u);
  const parsed = JSON.parse(output);
  if (parsed.status !== "budgetInsufficient") {
    assert.equal(parsed.result.negativeIsComplete, false);
    assert.equal(parsed.result.semanticPending, true);
    assert.deepEqual(parsed.result.sourceUnavailableReasons, { sizeLimit: 1 });
    assert.equal(parsed.result.resultOmittedCount, 1);
    assert.equal(parsed.result.sources[0].citation.extractedTextLocator.line, 3);
    assert.deepEqual(parsed.result.sources[0].citation.sourceLocators, [{ page: 2 }]);
    assert.equal(parsed.presentation.additionalTruncation, true);
  }
});

test("context errors never fall back to source content", () => {
  for (const result of [{ ok: false, status: "sourceUnavailable", error: "private source text" }, { ok: false, status: "aborted", text: "private source text" }]) {
    const output = formatContext(result, { contextBytes: 512, receipt: receipt() });
    assert.ok(Buffer.byteLength(output) <= 512);
    assert.doesNotMatch(output, /private source text/);
    assert.equal(JSON.parse(output).result.status, result.status);
  }
});

test("receipt is exclusive private storage and refuses non-private or symlink output paths", (t) => {
  const directory = privateDirectory(t);
  const result = { ok: true, text: "full original source text" };
  const written = writeReceipt(result, directory, { randomUUID: () => "11111111-1111-4111-8111-111111111111" });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, written.name), "utf8")).result, result);
  assert.equal(fs.statSync(path.join(directory, written.name)).mode & 0o777, 0o600);
  assert.throws(() => writeReceipt(result, directory, { randomUUID: () => "11111111-1111-4111-8111-111111111111" }), { code: "UNSAFE_RECEIPT_OUTPUT" });
  fs.symlinkSync(written.name, path.join(directory, "22222222-2222-4222-8222-222222222222.json"));
  assert.throws(() => writeReceipt(result, directory, { randomUUID: () => "22222222-2222-4222-8222-222222222222" }), { code: "UNSAFE_RECEIPT_OUTPUT" });
  const unsafe = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "context-unsafe-"));
  t.after(() => fs.rmSync(unsafe, { recursive: true, force: true }));
  fs.chmodSync(unsafe, 0o755);
  assert.throws(() => writeReceipt(result, unsafe), { code: "UNSAFE_RECEIPT_DIRECTORY" });
  const link = path.join(directory, "linked");
  fs.symlinkSync(directory, link);
  assert.throws(() => writeReceipt(result, link), { code: "UNSAFE_RECEIPT_DIRECTORY" });
});

test("receipt failures report cleanup state and never remove changed ownership", (t) => {
  const directory = privateDirectory(t);
  const result = { ok: true, text: "private receipt source" };
  const uuids = {
    write: "33333333-3333-4333-8333-333333333333",
    close: "44444444-4444-4444-8444-444444444444",
    unlink: "55555555-5555-4555-8555-555555555555",
    file: "66666666-6666-4666-8666-666666666666",
    parent: "77777777-7777-4777-8777-777777777777",
  };
  const target = (uuid) => path.join(directory, `${uuid}.json`);

  const writeFailure = captureError(() => writeReceipt(result, directory, {
    randomUUID: () => uuids.write,
    writeFileSync: () => { throw new Error(`write leaked ${directory}`); },
  }));
  assert.equal(writeFailure.code, "RECEIPT_WRITE_FAILED");
  assert.equal(writeFailure.cleanupStatus, "removed");
  assert.equal(fs.existsSync(target(uuids.write)), false);

  let firstClose = true;
  const closeFailure = captureError(() => writeReceipt(result, directory, {
    randomUUID: () => uuids.close,
    closeSync: (fd) => {
      if (firstClose) {
        firstClose = false;
        fs.closeSync(fd);
        throw new Error(`close leaked ${directory}`);
      }
      fs.closeSync(fd);
    },
  }));
  assert.equal(closeFailure.code, "RECEIPT_WRITE_FAILED");
  assert.equal(closeFailure.cleanupStatus, "removed");
  assert.equal(fs.existsSync(target(uuids.close)), false);

  const unlinkFailure = captureError(() => writeReceipt(result, directory, {
    randomUUID: () => uuids.unlink,
    writeFileSync: () => { throw new Error("injected write failure"); },
    unlinkSync: () => { throw new Error(`unlink leaked ${directory}`); },
  }));
  assert.equal(unlinkFailure.code, "RECEIPT_WRITE_FAILED");
  assert.equal(unlinkFailure.cleanupStatus, "cleanupFailed");
  assert.equal(fs.existsSync(target(uuids.unlink)), true);

  const changedFile = target(uuids.file);
  const fileIdentityFailure = captureError(() => writeReceipt(result, directory, {
    randomUUID: () => uuids.file,
    writeFileSync: (fd, payload, encoding) => {
      fs.writeFileSync(fd, payload, encoding);
      fs.unlinkSync(changedFile);
      fs.writeFileSync(changedFile, "replacement owned elsewhere");
      throw new Error("identity changed");
    },
  }));
  assert.equal(fileIdentityFailure.code, "RECEIPT_WRITE_FAILED");
  assert.equal(fileIdentityFailure.cleanupStatus, "ownershipChanged");
  assert.equal(fs.readFileSync(changedFile, "utf8"), "replacement owned elsewhere");

  const movedDirectory = `${directory}-moved`;
  t.after(() => fs.rmSync(movedDirectory, { recursive: true, force: true }));
  const parentIdentityFailure = captureError(() => writeReceipt(result, directory, {
    randomUUID: () => uuids.parent,
    writeFileSync: (fd, payload, encoding) => {
      fs.writeFileSync(fd, payload, encoding);
      fs.renameSync(directory, movedDirectory);
      fs.mkdirSync(directory, { mode: 0o700 });
      throw new Error("parent identity changed");
    },
  }));
  assert.equal(parentIdentityFailure.code, "RECEIPT_WRITE_FAILED");
  assert.equal(parentIdentityFailure.cleanupStatus, "ownershipChanged");
  assert.equal(fs.existsSync(path.join(movedDirectory, `${uuids.parent}.json`)), true);
});

test("receipt fstat failure closes the created file and reports unknown ownership without unlinking", (t) => {
  const directory = privateDirectory(t);
  const uuid = "88888888-8888-4888-8888-888888888888";
  const receiptPath = path.join(directory, `${uuid}.json`);
  let closed = false;
  const failure = captureError(() => writeReceipt({ ok: true }, directory, {
    randomUUID: () => uuid,
    fstatSync: () => { throw new Error("injected fstat failure"); },
    closeSync: (fd) => {
      closed = true;
      fs.closeSync(fd);
    },
  }));
  assert.equal(failure.code, "RECEIPT_WRITE_FAILED");
  assert.equal(failure.cleanupStatus, "ownershipUnknown");
  assert.equal(closed, true);
  assert.equal(fs.existsSync(receiptPath), true);
});

test("context CLI writes a receipt while default JSON remains unchanged and failed receipts reveal no source", (t) => {
  const directory = privateDirectory(t);
  const root = path.join(directory, "docs"); fs.mkdirSync(root); fs.writeFileSync(path.join(root, "note.md"), "needle private body🙂");
  const config = path.join(directory, "config.json");
  fs.writeFileSync(config, `${JSON.stringify({ version: 1, enabled: true, stateDirectory: path.join(directory, "state"), roots: [{ id: "docs", path: root, contentEnabled: true, extensions: [".md"], maxFiles: 10, maxFileBytes: 4096 }] })}\n`, { mode: 0o600 });
  const receiptDirectory = path.join(directory, "receipts"); fs.mkdirSync(receiptDirectory, { mode: 0o700 }); fs.chmodSync(receiptDirectory, 0o700);
  const cli = path.resolve(__dirname, "../bin/local-search.js");
  const base = [cli, "search", "--config", config, "--query", "needle", "--mode", "keyword"];
  const json = spawnSync(process.execPath, base, { encoding: "utf8" });
  assert.equal(json.status, 0, json.stderr);
  const context = spawnSync(process.execPath, [...base, "--format", "context", "--context-bytes", "1024", "--receipt-dir", receiptDirectory], { encoding: "utf8" });
  assert.equal(context.status, 0, context.stderr);
  assert.ok(Buffer.byteLength(context.stdout) <= 1024);
  const projected = JSON.parse(context.stdout);
  const receiptPath = path.join(receiptDirectory, projected.presentation.receipt.name);
  assert.equal(json.stdout, `${JSON.stringify(JSON.parse(json.stdout))}\n`);
  assert.equal(JSON.parse(fs.readFileSync(receiptPath, "utf8")).result.results[0].snippet, "needle private body🙂");
  const sourceId = JSON.parse(json.stdout).results[0].sourceId;
  const read = spawnSync(process.execPath, [cli, "read", "--config", config, "--source-id", sourceId, "--format", "context", "--receipt-dir", receiptDirectory], { encoding: "utf8" });
  assert.equal(read.status, 0, read.stderr);
  const readReceipt = JSON.parse(read.stdout).presentation.receipt.name;
  assert.equal(JSON.parse(fs.readFileSync(path.join(receiptDirectory, readReceipt), "utf8")).result.text, "needle private body🙂");
  fs.chmodSync(receiptDirectory, 0o755);
  const failure = spawnSync(process.execPath, [...base, "--format", "context", "--receipt-dir", receiptDirectory], { encoding: "utf8" });
  assert.equal(failure.status, 1);
  assert.doesNotMatch(failure.stdout, /needle private body/);
});

test("context parse failures are fixed, sanitized, and bounded on both streams", () => {
  const cli = path.resolve(__dirname, "../bin/local-search.js");
  const privateArgument = `private-${"x".repeat(2000)}`;
  const failure = spawnSync(process.execPath, [
    cli, "search", "--config", "/private/config.json", "--format", "context",
    "--context-bytes", "512", "--receipt-dir", "/tmp/receipts", "--unknown", privateArgument,
  ], { encoding: "utf8" });
  assert.equal(failure.status, 1);
  assert.ok(Buffer.byteLength(failure.stdout) <= 512);
  assert.deepEqual(JSON.parse(failure.stdout), { ok: false, status: "INVALID_ARGUMENT" });
  assert.doesNotMatch(failure.stdout, /private|xxxx/);
  assert.doesNotMatch(failure.stderr, /private|xxxx|local-search\.js:\d+/);
});

test("context cleanup failures are sanitized on both CLI streams", () => {
  const packagePath = path.resolve(__dirname, "..");
  const cliPath = path.resolve(__dirname, "../bin/local-search.js");
  const script = `
    const api = require(${JSON.stringify(packagePath)});
    api.search = async () => ({
      ok: true, status: "completeAsOfSnapshot", results: [{ snippet: "private-source" }],
    });
    require(${JSON.stringify(cliPath)}).runCli([
      "search", "--config", "/unused/config.json", "--query", "private-source",
      "--format", "context", "--receipt-dir", "/private/receipt/path",
    ], {
      writeReceipt: () => {
        throw Object.assign(new Error("private-source /private/receipt/path"), {
          code: "RECEIPT_WRITE_FAILED", cleanupStatus: "cleanupFailed",
        });
      },
    });
  `;
  const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(child.status, 1, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    ok: false, status: "RECEIPT_WRITE_FAILED", cleanupStatus: "cleanupFailed",
  });
  assert.doesNotMatch(child.stdout, /private-source|\/private\/receipt/);
  assert.doesNotMatch(child.stderr, /private-source|\/private\/receipt/);
});

test("JSON and evidence CLI failures retain the original error envelope", () => {
  const cli = path.resolve(__dirname, "../bin/local-search.js");
  for (const format of ["json", "evidence"]) {
    const child = spawnSync(process.execPath, [
      cli, "search", "--config", "/unused/config.json",
      "--format", format, "--format", format,
    ], { encoding: "utf8" });
    assert.equal(child.status, 1);
    assert.equal(child.stdout, `${JSON.stringify({
      ok: false, status: "INVALID_ARGUMENT", error: "duplicate argument: --format",
    })}\n`);
  }
});

test("executable cancellation emits a bounded partial context without source content", async (t) => {
  const directory = privateDirectory(t);
  const receiptDirectory = path.join(directory, "receipts");
  fs.mkdirSync(receiptDirectory, { mode: 0o700 });
  const packagePath = path.resolve(__dirname, "..");
  const cliPath = path.resolve(__dirname, "../bin/local-search.js");
  const script = `
    const api = require(${JSON.stringify(packagePath)});
    api.search = async (_config, _request, { signal }) => new Promise((resolve) => {
      const keepAlive = setInterval(() => {}, 1000);
      signal.addEventListener("abort", () => {
        clearInterval(keepAlive);
        resolve({
          ok: true, status: "partial", results: [{ sourceId: "one", snippet: "private cancelled source" }],
        });
      }, { once: true });
      if (process.send) process.send("ready");
    });
    require(${JSON.stringify(cliPath)}).runCli([
      "search", "--config", "/unused/config.json", "--query", "needle",
      "--format", "context", "--context-bytes", "512", "--receipt-dir", ${JSON.stringify(receiptDirectory)},
    ]).finally(() => { if (process.connected) process.disconnect(); });
  `;
  const child = spawn(PRODUCT_TEST_NODE, ["-e", script], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("message", () => child.kill("SIGTERM"));
  const exit = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("cancellation child timed out")), 5000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
  assert.deepEqual(exit, { code: 1, signal: null }, JSON.stringify({ stdout, stderr }));
  assert.equal(stderr, "");
  assert.ok(Buffer.byteLength(stdout) <= 512);
  const output = JSON.parse(stdout);
  assert.equal(output.presentation.cancelled, true);
  assert.equal(output.presentation.emittedResultCount, 0);
  assert.equal(Object.hasOwn(output.result, "sources"), false);
  assert.doesNotMatch(stdout, /private cancelled source/);
});

test("mandatory warning summaries fail closed when the context budget is too tight", () => {
  const output = formatContext({
    ok: true, status: "partial", results: [],
    sourceUnavailable: [...Array(80)].map((_, index) => ({
      reason: ["sizeLimit", "invalidUtf8", "rootOfflineOrUnreadable", "deadlineExpired"][index % 4],
    })),
  }, { contextBytes: 512, receipt: receipt() });
  assert.deepEqual(JSON.parse(output), { ok: false, status: "budgetInsufficient", contextBytes: 512 });
});

test("heavily escaped Unicode content can truncate to no content without dropping its citation", () => {
  let closest;
  for (let length = 0; length < 700; length += 1) {
    const result = { ok: true, status: "completeAsOfSnapshot", results: [{ sourceId: "one", relative: "x".repeat(length) }] };
    const output = formatContext(result, { contextBytes: 512, receipt: receipt() });
    const parsed = JSON.parse(output);
    if (parsed.result?.sources?.length === 1) closest = result;
  }
  assert.ok(closest);
  closest.results[0].snippet = "\u009f🙂".repeat(100);
  const output = formatContext(closest, { contextBytes: 512, receipt: receipt() });
  const parsed = JSON.parse(output);
  assert.equal(parsed.result.sources.length, 1);
  assert.equal(Object.hasOwn(parsed.result.sources[0], "content"), false);
  assert.equal(parsed.presentation.additionalTruncation, true);
  assert.doesNotMatch(output, /[\u007f-\u009f]/u);
});

test("context preserves indexed and fallback qualifiers with complete warning summaries", () => {
  const output = formatContext({
    ok: true,
    status: "partial",
    negativeIsComplete: false,
    semanticPending: true,
    semanticStatus: "staleReevaluatedSemanticPending",
    indexedCoverage: "stale",
    indexWatermark: "watermark-7",
    indexedRevision: "revision-9",
    fullScanRequiredForCompleteNegative: true,
    fallbackRequired: true,
    semanticCoverage: "partial",
    contentScan: { bytes: 99, limit: 99, exceeded: true },
    sourceUnavailable: [
      { reason: "sizeLimit" }, { reason: "__proto__" },
      { reason: `unknown-${"z".repeat(200)}` },
    ],
    results: [],
  }, { contextBytes: 2048, receipt: receipt() });
  const parsed = JSON.parse(output);
  assert.equal(parsed.status, undefined);
  assert.deepEqual(parsed.result.contentScan, { bytes: 99, limit: 99, exceeded: true });
  assert.equal(parsed.result.sourceUnavailableCount, 3);
  assert.deepEqual(parsed.result.sourceUnavailableReasons, { sizeLimit: 1, other: 2 });
  for (const key of [
    "indexedCoverage", "indexWatermark", "indexedRevision",
    "fullScanRequiredForCompleteNegative", "fallbackRequired", "semanticCoverage",
  ]) assert.deepEqual(parsed.result[key], ({
    indexedCoverage: "stale", indexWatermark: "watermark-7", indexedRevision: "revision-9",
    fullScanRequiredForCompleteNegative: true, fallbackRequired: true, semanticCoverage: "partial",
  })[key]);
});

test("context emits every fitting passage with citation-first metadata and omission counts", () => {
  const result = {
    ok: true,
    status: "completeAsOfSnapshot",
    results: [
      {
        sourceId: "one", rootId: "docs", relative: "one.md", score: 0.8, hash: "a".repeat(64),
        snippet: "first passage", anchorStatus: "bestLexicalPassage", locator: { line: 2, byteOffset: 4 },
      },
      {
        sourceId: "two", rootId: "docs", relative: "two.md", score: 0.7, hash: "b".repeat(64),
        snippet: "unanchored passage", anchorStatus: "noLexicalAnchorBeginningFallback", selectedSourceOnly: true,
      },
    ],
    omitted: [{ sourceId: "three", status: "changedBeforeEmission" }],
  };
  const output = formatContext(result, { contextBytes: 4096, receipt: receipt() });
  const parsed = JSON.parse(output);
  assert.equal(parsed.presentation.emittedResultCount, 2);
  assert.equal(parsed.presentation.omittedResultCount, 1);
  assert.equal(parsed.presentation.additionalTruncation, false);
  assert.equal(parsed.result.sources.length, 2);
  assert.deepEqual(parsed.result.sources.map((source) => source.content), ["first passage", "unanchored passage"]);
  assert.equal(parsed.result.sources[1].citation.selectedSourceOnly, true);
  assert.equal(parsed.result.sources[1].citation.anchorStatus, "noLexicalAnchorBeginningFallback");
  assert.equal(Object.hasOwn(parsed.result.sources[0].citation, "hash"), false);
  assert.equal(Object.hasOwn(parsed.result.sources[0].citation, "score"), false);
  assert.ok(output.indexOf('"citation"') < output.indexOf('"content"'));
});

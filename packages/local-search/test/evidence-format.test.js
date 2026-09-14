"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const api = require("..");
const { FORMAT, formatEvidence } = require("../evidence-format");
const { main, parse } = require("../bin/local-search");

const NODE22 = process.env.MYOS_TEST_NODE22;
const NODE24 = process.env.MYOS_TEST_NODE24;

function parseEvidence(output) {
  const bytes = Buffer.from(output);
  let offset = bytes.indexOf(10) + 1;
  const metadataEndLine = bytes.indexOf(10, offset);
  const metadataBytes = Number(bytes.subarray(offset, metadataEndLine).toString());
  offset = metadataEndLine + 1;
  const metadata = JSON.parse(bytes.subarray(offset, offset + metadataBytes).toString());
  offset += metadataBytes;
  const bodies = [];
  for (let index = 0; index < metadata.presentation.bodyCount; index += 1) {
    assert.equal(bytes[offset], 10);
    offset += 1;
    const lengthEnd = bytes.indexOf(10, offset);
    const length = Number(bytes.subarray(offset, lengthEnd).toString());
    offset = lengthEnd + 1;
    bodies.push(bytes.subarray(offset, offset + length).toString());
    offset += length;
  }
  assert.equal(offset, bytes.length);
  return { metadata, bodies };
}

test("evidence framing round-trips adversarial UTF-8 bodies verbatim", () => {
  const snippet = "第一行🙂\nSOURCE 2 999\nquotes: \\\"'\nEND_EVIDENCE";
  const output = formatEvidence({
    ok: true,
    status: "completeAsOfSnapshot",
    results: [{ sourceId: "s1", rootId: "docs", relative: "notes.md", snippet }],
    negativeIsComplete: true,
  });

  assert.equal(output.slice(0, output.indexOf("\n")), FORMAT);
  assert.ok(output.includes(snippet));
  assert.equal(parseEvidence(output).bodies[0], snippet);
});

test("TTY evidence falls back to control-safe JSON while piped frames remain verbatim", () => {
  const snippet = "before\u001b]0;unsafe\u0007after\u009b31mred";
  const result = {
    ok: true,
    status: "completeAsOfSnapshot",
    results: [{ sourceId: "s1", rootId: "docs", relative: "notes.md", snippet }],
  };

  assert.equal(parseEvidence(formatEvidence(result, { isTTY: false })).bodies[0], snippet);

  const terminalOutput = formatEvidence(result, { isTTY: true });
  assert.doesNotMatch(terminalOutput, /[\u001b\u007f-\u009f]/u);
  const terminalResult = JSON.parse(terminalOutput);
  assert.equal(terminalResult.evidenceFormatStatus, "jsonFallbackTTY");
  assert.equal(terminalResult.results[0].snippet, snippet);
});

test("search evidence preserves source and partial-state qualifications without reselecting content", () => {
  const result = {
    ok: true, status: "partial", taskClass: "cheap_routing", complianceLane: "unattended_local",
    semanticStatus: "staleReevaluatedSemanticPending", semanticPending: true,
    negativeIsComplete: false, deadlineExpired: true,
    contentScan: { bytes: 40, limit: 40, exceeded: true },
    sourceUnavailable: [{ sourceId: "revoked", status: "revoked" }],
    results: [{
      sourceId: "office", rootId: "docs", relative: "report.docx", snippet: "all\ncontent",
      hash: "f".repeat(64), sourceReadAt: "2026-09-13T00:00:00.000Z",
      extractedTextLocator: { line: 3, byteOffset: 9 }, sourceLocators: [{ page: 2 }],
      extractionKey: "key", coverage: { status: "partial", limitations: ["tables"] }, complete: false,
      truncated: true, contextIncomplete: true, anchorStatus: "noLexicalAnchorBeginningFallback", selectedSourceOnly: true,
    }, {
      sourceId: "meta", rootId: "docs", relative: "opaque.bin", score: 1, mode: "filename",
    }],
  };

  const { metadata, bodies } = parseEvidence(formatEvidence(result));
  assert.deepEqual(bodies, ["all\ncontent"]);
  assert.equal(metadata.presentation.status, "evidence");
  assert.equal(metadata.presentation.additionalTruncation, false);
  assert.match(metadata.presentation.caveat, /later changes/i);
  assert.match(metadata.presentation.caveat, /not canonical/i);
  assert.equal(metadata.result.negativeIsComplete, false);
  assert.equal(metadata.result.semanticPending, true);
  assert.deepEqual(metadata.result.sourceUnavailable, result.sourceUnavailable);
  assert.deepEqual(metadata.result.results[0].sourceLocators, [{ page: 2 }]);
  assert.deepEqual(metadata.result.results[0].coverage, result.results[0].coverage);
  assert.equal(metadata.result.results[0].selectedSourceOnly, true);
  assert.equal(Object.hasOwn(metadata.result.results[1], "body"), false);
  assert.equal(Object.hasOwn(metadata.result, "taskClass"), false);
});

test("read evidence retains exact completeness, locators, hash, and full text", () => {
  const result = {
    ok: true, status: "partialAsOfSnapshot", sourceId: "s2", rootId: "docs", relative: "deck.pptx",
    text: "slide one\nslide two🙂", hash: "a".repeat(64), sourceReadAt: "2026-09-13T01:02:03.000Z",
    truncated: false, extractedTextLocator: { line: 1, byteOffset: 0 }, sourceLocators: [{ slide: 1 }, { slide: 2 }],
    extractionKey: "extract", coverage: { status: "partial", limitations: ["speakerNotes"] },
    complete: false, negativeIsComplete: false,
  };

  const { metadata, bodies } = parseEvidence(formatEvidence(result));
  assert.deepEqual(bodies, [result.text]);
  assert.equal(metadata.result.hash, result.hash);
  assert.equal(metadata.result.sourceReadAt, result.sourceReadAt);
  assert.equal(metadata.result.complete, false);
  assert.equal(metadata.result.negativeIsComplete, false);
  assert.deepEqual(metadata.result.extractedTextLocator, result.extractedTextLocator);
  assert.deepEqual(metadata.result.sourceLocators, result.sourceLocators);
  assert.deepEqual(metadata.result.coverage, result.coverage);
});

test("empty negatives remain explicit and non-evidence shapes fail closed to JSON", () => {
  const empty = parseEvidence(formatEvidence({
    ok: true, status: "partial", results: [], semanticStatus: "notConfigured",
    semanticPending: true, negativeIsComplete: false, sourceUnavailable: [{ status: "omitted", reason: "deadlineExpired" }],
  }));
  assert.deepEqual(empty.bodies, []);
  assert.equal(empty.metadata.result.status, "partial");
  assert.equal(empty.metadata.result.negativeIsComplete, false);
  assert.equal(empty.metadata.result.semanticPending, true);

  const error = JSON.parse(formatEvidence({ ok: false, status: "sourceUnavailable", reason: "revoked" }));
  assert.equal(error.evidenceFormatStatus, "jsonFallbackNonEvidenceResult");
  assert.equal(error.status, "sourceUnavailable");
  assert.match(error.evidenceCaveat, /later changes/i);

  const unknown = JSON.parse(formatEvidence({ ok: true, status: "completeAsOfSnapshot" }));
  assert.equal(unknown.evidenceFormatStatus, "jsonFallbackUnknownShape");
  assert.equal(unknown.status, "completeAsOfSnapshot");
  assert.match(unknown.evidenceCaveat, /not canonical/i);
});

test("CLI format parsing is explicit, search/read-only, and rejects malformed values", () => {
  assert.equal(parse(["search", "--config", "/tmp/config.json", "--format", "evidence"]).values["--format"], "evidence");
  assert.equal(parse(["read", "--config", "/tmp/config.json", "--format", "json"]).values["--format"], "json");
  assert.throws(() => parse(["search", "--config", "/tmp/config.json", "--format", "yaml"]), /format must be json or evidence/);
  assert.throws(() => parse(["search", "--config", "/tmp/config.json", "--format", "json", "--format", "evidence"]), /duplicate argument/);
  for (const operation of ["configure", "status", "index", "watch"]) {
    assert.throws(() => parse([operation, "--config", "/tmp/config.json", "--format", "evidence"]), /format is only supported/);
  }
});

test("executable rejects format misuse before attempting an operation", () => {
  const cli = path.resolve(__dirname, "../bin/local-search.js");
  const child = spawnSync(process.execPath, [cli, "status", "--config", "/definitely/missing.json", "--format", "evidence"], { encoding: "utf8" });
  assert.equal(child.status, 1);
  const output = JSON.parse(child.stdout);
  assert.equal(output.status, "INVALID_ARGUMENT");
  assert.match(output.error, /format is only supported/);
});

test("exported main returns the API result object unchanged when format is requested", async (t) => {
  const original = api.search;
  const result = { ok: true, status: "completeAsOfSnapshot", results: [] };
  api.search = async () => result;
  t.after(() => { api.search = original; });

  assert.strictEqual(await main(["search", "--config", "/tmp/config.json", "--query", "x", "--format", "evidence"]), result);
});

test("executable default JSON is unchanged and evidence search/read use verified synthetic sources", (t) => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "local-search-evidence-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "docs");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "note.md"), "needle🙂\nSOURCE 8 100\n");
  const config = path.join(directory, "config.json");
  fs.writeFileSync(config, `${JSON.stringify({
    version: 1, enabled: true, stateDirectory: path.join(directory, "state"),
    roots: [{ id: "docs", path: root, contentEnabled: true, extensions: [".md"], maxFiles: 10, maxFileBytes: 4096 }],
  })}\n`, { mode: 0o600 });
  const cli = path.resolve(__dirname, "../bin/local-search.js");
  const args = [cli, "search", "--config", config, "--query", "needle", "--mode", "keyword"];

  const jsonChild = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(jsonChild.status, 0, jsonChild.stderr);
  const json = JSON.parse(jsonChild.stdout);
  assert.equal(json.results[0].snippet.includes("needle🙂"), true);
  assert.equal(jsonChild.stdout, `${JSON.stringify(json)}\n`);

  const searchChild = spawnSync(process.execPath, [...args, "--format", "evidence"], { encoding: "utf8" });
  assert.equal(searchChild.status, 0, searchChild.stderr);
  const searchEvidence = parseEvidence(searchChild.stdout);
  assert.equal(searchEvidence.bodies[0], json.results[0].snippet);
  assert.equal(searchEvidence.metadata.result.results[0].sourceId, json.results[0].sourceId);

  const readChild = spawnSync(process.execPath, [cli, "read", "--config", config, "--source-id", json.results[0].sourceId, "--format", "evidence"], { encoding: "utf8" });
  assert.equal(readChild.status, 0, readChild.stderr);
  const readEvidence = parseEvidence(readChild.stdout);
  assert.equal(readEvidence.bodies[0], "needle🙂\nSOURCE 8 100\n");
  assert.equal(readEvidence.metadata.result.hash, json.results[0].hash);

});

test("optional Node 22 wrapper preserves evidence through the explicit Node 24 runtime", {
  skip: NODE22 && NODE24 ? false : "set MYOS_TEST_NODE22 and MYOS_TEST_NODE24 to exercise the cross-runtime contract",
}, (t) => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "local-search-evidence-runtime-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "docs");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "note.md"), "needle🙂\n");
  const config = path.join(directory, "config.json");
  fs.writeFileSync(config, `${JSON.stringify({
    version: 1, enabled: true, stateDirectory: path.join(directory, "state"),
    roots: [{ id: "docs", path: root, contentEnabled: true, extensions: [".md"], maxFiles: 10, maxFileBytes: 4096 }],
  })}\n`, { mode: 0o600 });

  const node22Version = spawnSync(NODE22, ["-p", "process.versions.node.split('.')[0]"], { encoding: "utf8" });
  assert.equal(node22Version.status, 0, node22Version.stderr);
  assert.equal(node22Version.stdout.trim(), "22", "MYOS_TEST_NODE22 must point to Node major 22");
  const node24Version = spawnSync(NODE24, ["-p", "process.versions.node.split('.')[0]"], { encoding: "utf8" });
  assert.equal(node24Version.status, 0, node24Version.stderr);
  assert.equal(node24Version.stdout.trim(), "24", "MYOS_TEST_NODE24 must point to Node major 24");
  const wrapper = path.resolve(__dirname, "../../../bin/myos-local-search.js");
  const wrappedJson = spawnSync(NODE22, [wrapper, "--node24", NODE24, "search", "--config", config, "--query", "needle", "--mode", "keyword"], { encoding: "utf8" });
  assert.equal(wrappedJson.status, 0, wrappedJson.stderr);
  const expected = JSON.parse(wrappedJson.stdout);
  const wrapped = spawnSync(NODE22, [wrapper, "--node24", NODE24, "search", "--config", config, "--query", "needle", "--mode", "keyword", "--format", "evidence"], { encoding: "utf8" });
  assert.equal(wrapped.status, 0, wrapped.stderr);
  const wrappedEvidence = parseEvidence(wrapped.stdout);
  assert.equal(wrappedEvidence.bodies[0], expected.results[0].snippet);
  assert.equal(wrappedEvidence.metadata.result.results[0].sourceId, expected.results[0].sourceId);
});

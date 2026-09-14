"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const api = require("../packages/local-search");
const { normalizeConfig } = require("../packages/local-search/config");
const { loadManifests } = require("../packages/local-search/staging");

function fixture(t, options = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "local-search-doc-integration-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "docs");
  fs.mkdirSync(root);
  const input = {
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "docs", path: root, contentEnabled: true, extensions: options.extensions || [".txt", ".docx"], maxFiles: options.maxFiles || 20, maxFileBytes: 1024 * 1024 }],
    budgets: { queryDeadlineMs: 2_000, indexDeadlineMs: 4_000, maxContentScanBytes: 4 * 1024 * 1024, reserveBytes: 1, reserveFraction: 0.000001, quotaBytes: 16 * 1024 * 1024 },
    ...(options.parser ? { parser: options.parser } : {}),
  };
  return { base, root, config: normalizeConfig(input) };
}

function makeActualOfficeFiles(t) {
  const python = process.env.MYOS_TEST_DOCUMENT_PYTHON;
  if (!python) { t.skip("set MYOS_TEST_DOCUMENT_PYTHON to run real Office integration"); return null; }
  const f = fixture(t, { extensions: [".docx", ".pptx", ".xlsx", ".pdf"], parser: { pythonPath: python, timeoutMs: 10_000 } });
  const script = [
    "import os,sys",
    "from docx import Document",
    "from pptx import Presentation",
    "from pptx.util import Inches",
    "from openpyxl import Workbook",
    "root=sys.argv[1]",
    "d=Document(); d.add_paragraph('REAL_DOCX_MARKER OFFICE_SEARCH_TOKEN'); d.save(os.path.join(root,'sample.docx'))",
    "p=Presentation(); s=p.slides.add_slide(p.slide_layouts[6]); s.shapes.add_textbox(Inches(1),Inches(1),Inches(3),Inches(1)).text='REAL_PPTX_MARKER OFFICE_SEARCH_TOKEN'; p.save(os.path.join(root,'sample.pptx'))",
    "w=Workbook(); ws=w.active; ws.title='Evidence'; ws['B2']='REAL_XLSX_MARKER OFFICE_SEARCH_TOKEN'; w.save(os.path.join(root,'sample.xlsx'))",
  ].join("; ");
  const generated = spawnSync(python, ["-I", "-c", script, f.root], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  fs.writeFileSync(path.join(f.root, "unsafe.pdf"), "%PDF-1.4\n%%EOF\n");
  return f;
}

test("document parsing is default-off and explicit parser limits are normalized", (t) => {
  const disabled = fixture(t);
  assert.equal(disabled.config.parser, null);
  assert.equal(disabled.config.roots[0].extensions.includes(".docx"), true);

  const enabled = fixture(t, { parser: { pythonPath: "/opt/local/python3", timeoutMs: 1200, segments: 25 } });
  assert.deepEqual(enabled.config.parser, { pythonPath: "/opt/local/python3", timeoutMs: 1200, segments: 25 });
  assert.equal(Object.isFrozen(enabled.config.parser), true);
});

test("explicit Office content is searchable and readable with source locators", async (t) => {
  const f = fixture(t, { parser: { pythonPath: "/opt/local/python3", timeoutMs: 1200 } });
  const bytes = Buffer.from("synthetic-office\0bytes");
  fs.writeFileSync(path.join(f.root, "notes.docx"), bytes);
  const extractDocument = async (input) => ({
    text: "Office apricot fact",
    sourceHash: crypto.createHash("sha256").update(input).digest("hex"),
    parserIdentity: { implementation: "fixture-parser" },
    parserFingerprint: "a".repeat(64),
    segments: [{ start: 0, end: 19, locator: { paragraph: 1 } }],
    coverage: { status: "complete", limitations: [] },
    complete: true,
  });

  const searched = await api.search(f.config, { query: "apricot", mode: "keyword" }, { extractDocument });
  assert.match(searched.results[0].snippet, /apricot/);
  assert.equal(Object.hasOwn(searched.results[0], "locator"), false);
  assert.deepEqual(searched.results[0].sourceLocators, [{ paragraph: 1 }]);

  const read = await api.read(f.config, { sourceId: searched.results[0].sourceId }, { extractDocument });
  assert.equal(read.text, "Office apricot fact");
  assert.equal(Object.hasOwn(read, "lineLocator"), false);
  assert.deepEqual(read.sourceLocators, [{ paragraph: 1 }]);
});

test("text search and read retain generic locator fields", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "plain.txt"), "first line\nplum evidence\n");

  const searched = await api.search(f.config, { query: "plum", mode: "keyword" });
  const read = await api.read(f.config, { sourceId: searched.results[0].sourceId });

  assert.equal(Number.isSafeInteger(searched.results[0].locator.line), true);
  assert.equal(Number.isSafeInteger(searched.results[0].locator.byteOffset), true);
  assert.deepEqual(read.lineLocator, { firstLine: 1 });
  assert.equal(Object.hasOwn(searched.results[0], "extractedTextLocator"), false);
  assert.equal(Object.hasOwn(read, "extractedTextLocator"), false);
});

test("Office indexing binds source bytes and parser identity through final publication", async (t) => {
  const f = fixture(t, { parser: { pythonPath: "/opt/local/python3", timeoutMs: 1200 } });
  const bytes = Buffer.from("index-office\0bytes");
  fs.writeFileSync(path.join(f.root, "index.docx"), bytes);
  let extractions = 0;
  let stagedManifest;
  const extractDocument = async (input) => {
    extractions += 1;
    return {
      text: "indexed mango document",
      sourceHash: crypto.createHash("sha256").update(input).digest("hex"),
      parserIdentity: { implementation: "fixture-parser" }, parserFingerprint: "b".repeat(64),
      segments: [{ start: 0, end: 22, locator: { paragraph: 1 } }], coverage: { status: "complete", limitations: [] }, complete: true,
    };
  };
  const result = await api.index(f.config, { adapters: {
    extractDocument,
    qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }),
    updateIndex: async (staged) => { stagedManifest = Object.values(staged.manifests.docs)[0]; return { ok: true, status: "indexed", indexed: 1 }; },
    embedCollection: async () => ({ ok: true }),
  } });

  assert.equal(result.ok, true);
  assert.ok(extractions >= 2);
  assert.equal(stagedManifest.sourceHash, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.equal(stagedManifest.parserFingerprint, "b".repeat(64));
  assert.match(stagedManifest.extractionKey, /^[a-f0-9]{64}$/);
  assert.equal(result.catalogue.records[0].indexedExtractionKey, stagedManifest.extractionKey);
});

test("partial Office coverage remains searchable but cannot complete a negative", async (t) => {
  const f = fixture(t, { parser: { pythonPath: "/opt/local/python3" } });
  const bytes = Buffer.from("partial-office\0bytes");
  fs.writeFileSync(path.join(f.root, "partial.docx"), bytes);
  const extractDocument = async (input) => ({
    text: "visible partial kiwi",
    sourceHash: crypto.createHash("sha256").update(input).digest("hex"),
    parserIdentity: {}, parserFingerprint: "c".repeat(64),
    segments: [{ start: 0, end: 20, locator: { paragraph: 1 } }],
    coverage: { status: "partial", limitations: ["headersFootersNotExtracted"] }, complete: false,
  });

  const hit = await api.search(f.config, { query: "kiwi", mode: "keyword" }, { extractDocument });
  assert.equal(hit.results.length, 1);
  assert.equal(hit.status, "partial");
  assert.equal(hit.results[0].complete, false);
  const missing = await api.search(f.config, { query: "absent", mode: "keyword" }, { extractDocument });
  assert.equal(missing.negativeIsComplete, false);
});

test("metadata-only, disabled-extension, and unconfigured documents never launch a parser", async (t) => {
  let calls = 0;
  const extractDocument = async () => { calls += 1; throw new Error("must not run"); };
  const metadata = fixture(t, { parser: { pythonPath: "/opt/local/python3" } });
  metadata.config = normalizeConfig({ ...metadata.config, roots: [{ ...metadata.config.roots[0], contentEnabled: false }] });
  fs.writeFileSync(path.join(metadata.root, "metadata.docx"), Buffer.from([0, 1, 2]));
  assert.equal((await api.search(metadata.config, { query: "metadata", mode: "filename" }, { extractDocument })).results.length, 1);
  assert.equal((await api.search(metadata.config, { query: "hidden", mode: "keyword" }, { extractDocument })).results.length, 0);

  const disabled = fixture(t, { extensions: [".txt"], parser: { pythonPath: "/opt/local/python3" } });
  fs.writeFileSync(path.join(disabled.root, "disabled.docx"), Buffer.from([0, 1, 2]));
  assert.equal((await api.search(disabled.config, { query: "disabled", mode: "filename" }, { extractDocument })).results.length, 1);

  const unconfigured = fixture(t);
  fs.writeFileSync(path.join(unconfigured.root, "unconfigured.pdf"), Buffer.from([0, 1, 2]));
  const filename = await api.search(unconfigured.config, { query: "unconfigured", mode: "filename" }, { extractDocument });
  assert.equal(filename.results.length, 1);
  assert.equal(Object.hasOwn(filename.results[0], "snippet"), false);
  assert.equal(calls, 0);
});

test("extracted secrets are denied before search, read, or staging", async (t) => {
  const f = fixture(t, { parser: { pythonPath: "/opt/local/python3" } });
  const bytes = Buffer.from("secret-office\0bytes");
  fs.writeFileSync(path.join(f.root, "ordinary.docx"), bytes);
  const extractDocument = async (input) => ({
    text: "needle password=syntheticsecretvalue",
    sourceHash: crypto.createHash("sha256").update(input).digest("hex"), parserIdentity: {}, parserFingerprint: "d".repeat(64),
    segments: [{ start: 0, end: 36, locator: { paragraph: 1 } }], coverage: { status: "complete", limitations: [] }, complete: true,
  });
  const searched = await api.search(f.config, { query: "needle", mode: "keyword" }, { extractDocument });
  assert.equal(searched.results.length, 0);
  assert.ok(searched.sourceUnavailable.some((item) => item.reason === "secretPatternDenied"));
  const sourceId = (await api.search(f.config, { query: "ordinary", mode: "filename" }, { extractDocument })).results[0].sourceId;
  assert.equal((await api.read(f.config, { sourceId }, { extractDocument })).reason, "secretPatternDenied");
  const indexed = await api.index(f.config, { adapters: { extractDocument, qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }), updateIndex: async (staged) => ({ ok: true, status: "indexed", indexed: staged.staged.length }), embedCollection: async () => ({ ok: true }) } });
  assert.equal(indexed.catalogue.semanticPending, true);
  assert.equal(indexed.skipped.some((item) => item.reason === "secretPatternDenied"), true);
});

test("source edits during parsing and final emission never release stale Office text", async (t) => {
  const f = fixture(t, { parser: { pythonPath: "/opt/local/python3" } });
  const file = path.join(f.root, "changing.docx");
  fs.writeFileSync(file, Buffer.from("office-a\0"));
  let mutate = true;
  const extractDocument = async (input) => {
    if (mutate) { mutate = false; fs.writeFileSync(file, Buffer.from("office-b\0")); }
    return { text: "stale nectarine", sourceHash: crypto.createHash("sha256").update(input).digest("hex"), parserIdentity: {}, parserFingerprint: "e".repeat(64), segments: [{ start: 0, end: 15, locator: { paragraph: 1 } }], coverage: { status: "complete", limitations: [] }, complete: true };
  };
  const changed = await api.search(f.config, { query: "nectarine", mode: "keyword" }, { extractDocument });
  assert.equal(changed.results.length, 0);
  assert.equal(changed.negativeIsComplete, false);

  const stableExtractor = async (input) => ({ text: "fresh nectarine", sourceHash: crypto.createHash("sha256").update(input).digest("hex"), parserIdentity: {}, parserFingerprint: "e".repeat(64), segments: [{ start: 0, end: 16, locator: { paragraph: 1 } }], coverage: { status: "complete", limitations: [] }, complete: true });
  const emitted = await api.search(f.config, { query: "nectarine", mode: "keyword" }, { extractDocument: stableExtractor, beforeEmit: () => fs.writeFileSync(file, Buffer.from("office-c\0")) });
  assert.equal(emitted.results.length, 0);
});

test("a changed parser fingerprint invalidates semantic Office candidates", async (t) => {
  const f = fixture(t, { parser: { pythonPath: "/opt/local/python3" } });
  const bytes = Buffer.from("semantic-office\0bytes");
  fs.writeFileSync(path.join(f.root, "semantic.docx"), bytes);
  const extractor = (fingerprint) => async (input) => ({
    text: "semantic papaya evidence", sourceHash: crypto.createHash("sha256").update(input).digest("hex"),
    parserIdentity: {}, parserFingerprint: fingerprint, segments: [{ start: 0, end: 24, locator: { paragraph: 1 } }],
    coverage: { status: "complete", limitations: [] }, complete: true,
  });
  await api.index(f.config, { adapters: {
    extractDocument: extractor("1".repeat(64)),
    qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }),
    updateIndex: async () => ({ ok: true, status: "indexed", indexed: 1 }), embedCollection: async () => ({ ok: true }),
  } });
  const manifests = loadManifests(f.config);
  const filename = Object.keys(manifests.docs)[0];
  const result = await api.search(f.config, { query: "papaya", mode: "semantic" }, {
    extractDocument: extractor("2".repeat(64)), manifests,
    qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }),
    runSdkSearch: async () => ({ ok: true, stdout: JSON.stringify([{ file: `qmd://docs/${filename}`, score: 0.9 }]) }),
  });
  assert.equal(result.semanticStatus, "staleReevaluatedSemanticPending");
  assert.equal(result.semanticPending, true);
  assert.equal(result.results[0].mode, "keyword");
});

test("real DOCX, PPTX, and XLSX flow through public search and read with native locators", async (t) => {
  const f = makeActualOfficeFiles(t);
  if (!f) return;
  const searched = await api.search(f.config, { query: "OFFICE_SEARCH_TOKEN", mode: "keyword", maxResults: 3 });
  if (searched.sourceUnavailable.some((item) => item.reason === "documentParser:SANDBOX_UNAVAILABLE")) return t.skip("outer worker policy blocks sandbox-exec");
  assert.equal(searched.results.length, 3, JSON.stringify(searched.sourceUnavailable));
  const byName = new Map(searched.results.map((result) => [result.relative, result]));
  assert.deepEqual(byName.get("sample.docx").sourceLocators, [{ paragraph: 1 }]);
  assert.equal(byName.get("sample.pptx").sourceLocators[0].slide, 1);
  assert.deepEqual(byName.get("sample.xlsx").sourceLocators, [{ sheet: "Evidence", cell: "B2" }]);
  for (const [name, marker] of [["sample.docx", "REAL_DOCX_MARKER"], ["sample.pptx", "REAL_PPTX_MARKER"], ["sample.xlsx", "REAL_XLSX_MARKER"]]) {
    const read = await api.read(f.config, { sourceId: byName.get(name).sourceId });
    assert.match(read.text, new RegExp(marker));
    assert.ok(read.sourceLocators.length > 0);
  }
});

test("unsafe PDF remains filename-only and reports the parser safety boundary", async (t) => {
  const f = makeActualOfficeFiles(t);
  if (!f) return;
  const filename = await api.search(f.config, { query: "unsafe.pdf", mode: "filename" });
  assert.equal(filename.results[0].relative, "unsafe.pdf");
  assert.equal(Object.hasOwn(filename.results[0], "snippet"), false);
  const content = await api.search(f.config, { query: "anything", mode: "keyword" });
  if (content.sourceUnavailable.some((item) => item.reason === "documentParser:SANDBOX_UNAVAILABLE")) return t.skip("outer worker policy blocks sandbox-exec");
  if (process.platform === "darwin") assert.ok(content.sourceUnavailable.some((item) => item.reason === "documentParser:UNSUPPORTED_SAFETY_BOUNDARY"), JSON.stringify(content.sourceUnavailable));
});

test("Office add, preserved-mtime edit, inode replacement, rename, and delete are live", async (t) => {
  const f = fixture(t, { parser: { pythonPath: "/opt/local/python3" } });
  const extractor = async (input) => {
    const text = input.toString("utf8").replaceAll("\0", "");
    return { text, sourceHash: crypto.createHash("sha256").update(input).digest("hex"), parserIdentity: {}, parserFingerprint: "f".repeat(64), segments: [{ start: 0, end: text.length, locator: { paragraph: 1 } }], coverage: { status: "complete", limitations: [] }, complete: true };
  };
  const original = path.join(f.root, "one.docx");
  fs.writeFileSync(original, Buffer.from("alpha\0"));
  assert.equal((await api.search(f.config, { query: "alpha", mode: "keyword" }, { extractDocument: extractor })).results.length, 1);
  const stat = fs.statSync(original);
  fs.writeFileSync(original, Buffer.from("bravo\0")); fs.utimesSync(original, stat.atime, stat.mtime);
  assert.equal((await api.search(f.config, { query: "alpha", mode: "keyword" }, { extractDocument: extractor })).results.length, 0);
  assert.equal((await api.search(f.config, { query: "bravo", mode: "keyword" }, { extractDocument: extractor })).results.length, 1);
  const replacement = path.join(f.root, "replacement.docx"); fs.writeFileSync(replacement, Buffer.from("cider!\0")); fs.renameSync(replacement, original);
  assert.equal((await api.search(f.config, { query: "cider", mode: "keyword" }, { extractDocument: extractor })).results.length, 1);
  const renamed = path.join(f.root, "renamed.docx"); fs.renameSync(original, renamed);
  assert.equal((await api.search(f.config, { query: "renamed", mode: "filename" }, { extractDocument: extractor })).results[0].relative, "renamed.docx");
  fs.unlinkSync(renamed);
  assert.equal((await api.search(f.config, { query: "cider", mode: "keyword" }, { extractDocument: extractor })).results.length, 0);
});

test("malformed, timeout, and cancellation failures cannot reuse prior extracted content", async (t) => {
  const f = fixture(t, { parser: { pythonPath: "/opt/local/python3" } });
  const file = path.join(f.root, "failure.docx"); fs.writeFileSync(file, Buffer.from("failure\0"));
  const good = async (input) => ({ text: "old guava content", sourceHash: crypto.createHash("sha256").update(input).digest("hex"), parserIdentity: {}, parserFingerprint: "9".repeat(64), segments: [{ start: 0, end: 17, locator: { paragraph: 1 } }], coverage: { status: "complete", limitations: [] }, complete: true });
  const first = await api.search(f.config, { query: "guava", mode: "keyword" }, { extractDocument: good });
  const sourceId = first.results[0].sourceId;
  for (const code of ["MALFORMED_ARCHIVE", "TIMEOUT", "ABORTED"]) {
    fs.writeFileSync(file, Buffer.from(`${code}\0`));
    const failing = async () => { throw Object.assign(new Error(code), { code }); };
    const searched = await api.search(f.config, { query: "guava", mode: "keyword" }, { extractDocument: failing });
    assert.equal(searched.results.length, 0);
    assert.equal(searched.negativeIsComplete, false);
    const read = await api.read(f.config, { sourceId }, { extractDocument: failing });
    assert.equal(read.ok, false);
    assert.equal(Object.hasOwn(read, "text"), false);
  }
});

test("document hydration cap returns partial keyword results without ranking raw bytes", async (t) => {
  const f = fixture(t, { maxFiles: 40, parser: { pythonPath: "/opt/local/python3" } });
  for (let index = 0; index < 33; index += 1) {
    fs.writeFileSync(path.join(f.root, `document-${String(index).padStart(2, "0")}.docx`), Buffer.from(`office-${index}\0`));
  }
  const extractDocument = async (input) => {
    const text = input.toString("utf8").replaceAll("\0", "");
    return {
      text, sourceHash: crypto.createHash("sha256").update(input).digest("hex"), parserIdentity: {}, parserFingerprint: "8".repeat(64),
      segments: [{ start: 0, end: text.length, locator: { paragraph: 1 } }], coverage: { status: "complete", limitations: [] }, complete: true,
    };
  };

  const result = await api.search(f.config, { query: "office-32", mode: "keyword" }, { extractDocument });

  assert.equal(result.status, "partial");
  assert.equal(result.results.length, 0);
  assert.ok(result.sourceUnavailable.some((item) => item.reason === "documentHydrationBudgetExceeded"));
});

test("deadline reached after byte reconciliation returns partial without ranking raw bytes", async (t) => {
  const f = fixture(t, { parser: { pythonPath: "/opt/local/python3" } });
  fs.writeFileSync(path.join(f.root, "deadline-boundary.docx"), Buffer.from("boundary\0"));
  const originalNow = Date.now;
  const startedAt = originalNow();
  const deadline = startedAt + f.config.budgets.queryDeadlineMs;
  Date.now = () => {
    const stack = new Error().stack || "";
    return stack.includes("hydrateRecords") || stack.includes("lexical") ? deadline : startedAt;
  };
  t.after(() => { Date.now = originalNow; });
  let parseCalls = 0;

  const result = await api.search(f.config, { query: "boundary", mode: "keyword" }, { extractDocument: async () => { parseCalls += 1; throw new Error("must not parse"); } });

  assert.equal(result.status, "partial");
  assert.equal(result.results.length, 0);
  assert.equal(parseCalls, 0);
  assert.ok(result.sourceUnavailable.some((item) => item.reason === "documentHydrationBudgetExceeded"));
});

test("document hydration cap returns partial auto results without exact-ranking raw bytes", async (t) => {
  const f = fixture(t, { maxFiles: 40, parser: { pythonPath: "/opt/local/python3" } });
  for (let index = 0; index < 33; index += 1) {
    fs.writeFileSync(path.join(f.root, `document-${String(index).padStart(2, "0")}.docx`), Buffer.from(`auto-${index}\0`));
  }
  const extractDocument = async (input) => {
    const text = input.toString("utf8").replaceAll("\0", "");
    return {
      text, sourceHash: crypto.createHash("sha256").update(input).digest("hex"), parserIdentity: {}, parserFingerprint: "7".repeat(64),
      segments: [{ start: 0, end: text.length, locator: { paragraph: 1 } }], coverage: { status: "complete", limitations: [] }, complete: true,
    };
  };

  const result = await api.search(f.config, { query: "auto-32", mode: "auto" }, { extractDocument });

  assert.equal(result.status, "partial");
  assert.equal(result.results.length, 0);
  assert.ok(result.sourceUnavailable.some((item) => item.reason === "documentHydrationBudgetExceeded"));
});

test("document hydration cap skips raw bytes during index staging", async (t) => {
  const f = fixture(t, { maxFiles: 40, parser: { pythonPath: "/opt/local/python3" } });
  for (let index = 0; index < 33; index += 1) {
    fs.writeFileSync(path.join(f.root, `document-${String(index).padStart(2, "0")}.docx`), Buffer.from(`index-${index}\0`));
  }
  const extractDocument = async (input) => {
    const text = input.toString("utf8").replaceAll("\0", "");
    return {
      text, sourceHash: crypto.createHash("sha256").update(input).digest("hex"), parserIdentity: {}, parserFingerprint: "6".repeat(64),
      segments: [{ start: 0, end: text.length, locator: { paragraph: 1 } }], coverage: { status: "complete", limitations: [] }, complete: true,
    };
  };
  let stagedCount = 0;

  const result = await api.index(f.config, { adapters: {
    extractDocument,
    qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }),
    updateIndex: async (staged) => { stagedCount = staged.staged.length; return { ok: true, status: "indexed", indexed: staged.staged.length }; },
    embedCollection: async () => ({ ok: true }),
  } });

  assert.equal(result.ok, true);
  assert.equal(stagedCount, 32);
  assert.equal(result.status, "partialExtraction");
  assert.ok(result.skipped.some((item) => item.reason === "documentHydrationBudgetExceeded"));
});

test("read validates output budgets before parsing a document", async (t) => {
  const f = fixture(t, { parser: { pythonPath: "/opt/local/python3" } });
  fs.writeFileSync(path.join(f.root, "budget.docx"), Buffer.from("budget\0"));
  const sourceId = (await api.search(f.config, { query: "budget.docx", mode: "filename" })).results[0].sourceId;
  let parseCalls = 0;
  const extractDocument = async (input) => {
    parseCalls += 1;
    return {
      text: "budget", sourceHash: crypto.createHash("sha256").update(input).digest("hex"), parserIdentity: {}, parserFingerprint: "5".repeat(64),
      segments: [{ start: 0, end: 6, locator: { paragraph: 1 } }], coverage: { status: "complete", limitations: [] }, complete: true,
    };
  };

  await assert.rejects(api.read(f.config, { sourceId, maxBytes: f.config.budgets.maxBytes + 1 }, { extractDocument }), { code: "INVALID_REQUEST" });

  assert.equal(parseCalls, 0);
});

test("read gives both document parses one deadline and one abort signal", async (t) => {
  const f = fixture(t, { parser: { pythonPath: "/opt/local/python3", timeoutMs: 10_000 } });
  fs.writeFileSync(path.join(f.root, "deadline.docx"), Buffer.from("deadline\0"));
  const sourceId = (await api.search(f.config, { query: "deadline.docx", mode: "filename" })).results[0].sourceId;
  const controller = new AbortController();
  const calls = [];
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  const extractDocument = async (input, limits) => {
    calls.push({ deadline: limits.deadline, timeoutMs: limits.timeoutMs, signal: limits.signal });
    if (calls.length === 1) now += 1_500;
    return {
      text: "deadline", sourceHash: crypto.createHash("sha256").update(input).digest("hex"), parserIdentity: {}, parserFingerprint: "4".repeat(64),
      segments: [{ start: 0, end: 8, locator: { paragraph: 1 } }], coverage: { status: "complete", limitations: [] }, complete: true,
    };
  };

  const result = await api.read(f.config, { sourceId }, { extractDocument, signal: controller.signal });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].deadline, calls[1].deadline);
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(calls[1].signal, controller.signal);
  assert.ok(calls[1].timeoutMs <= calls[0].timeoutMs - 1_400, JSON.stringify(calls));
});

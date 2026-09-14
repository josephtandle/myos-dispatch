"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { publish, reconcile } = require("../packages/local-search/catalogue");
const { normalizeConfig } = require("../packages/local-search/config");
const { search } = require("../packages/local-search/search");

function fixture(t, files, budgets = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "local-search-routing-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "docs");
  fs.mkdirSync(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return normalizeConfig({
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "docs", path: root, contentEnabled: true, extensions: [".md", ".txt", ".toml"], maxFiles: 20, maxFileBytes: 64 * 1024 }],
    budgets: { queryDeadlineMs: 2000, indexDeadlineMs: 2000, reserveBytes: 1, reserveFraction: 0.000001, quotaBytes: 1024 ** 2, ...budgets },
  });
}

function sdkAdapters(calls, candidates = []) {
  return {
    qmdStatus: () => ({ available: true, semanticAvailable: true, status: "available" }),
    runSdkSearch: async (_config, request) => {
      calls.push(request.operation);
      return { ok: true, stdout: JSON.stringify(candidates) };
    },
  };
}

test("auto routes a verified exact assignment locally without SDK calls", async (t) => {
  const config = fixture(t, {
    "right.md": "Set CONFIG_VARIABLE=0 to retain the disabled state.\n",
    "wrong.md": "General configuration guidance without the requested setting.\n",
  });
  const calls = [];

  const result = await search(config, { query: "Which file says CONFIG_VARIABLE=0?", mode: "auto" }, sdkAdapters(calls));

  assert.equal(result.results[0].relative, "right.md");
  assert.deepEqual(calls, []);
  assert.equal(result.routeReason, "verifiedExactSignalFastPath");
});

test("an assignment prefix is not accepted as the exact requested value", async (t) => {
  const config = fixture(t, { "near.md": "CONFIG_VARIABLE=01 is a different setting.\n" });
  const calls = [];

  const result = await search(config, { query: "Where is CONFIG_VARIABLE=0?", mode: "auto" }, sdkAdapters(calls));

  assert.deepEqual(calls, ["lexical", "semantic"]);
  assert.equal(result.routeReason, "requestedModePipeline");
});

test("a longer CLI flag is not accepted as the requested flag", async (t) => {
  const config = fixture(t, { "near.md": "Use --timeout-ms-extra only in development.\n" });
  const calls = [];

  await search(config, { query: "Explain --timeout-ms", mode: "auto" }, sdkAdapters(calls));

  assert.deepEqual(calls, ["lexical", "semantic"]);
});

test("a longer identifier is not accepted as the requested identifier", async (t) => {
  const config = fixture(t, { "near.md": "The value MISSING_IDENTIFIER_EXTRA is unrelated.\n" });
  const calls = [];

  await search(config, { query: "Where is MISSING_IDENTIFIER?", mode: "auto" }, sdkAdapters(calls));

  assert.deepEqual(calls, ["lexical", "semantic"]);
});

test("incidental uppercase acronyms do not disable semantic retrieval", async (t) => {
  const config = fixture(t, { "concept.md": "The API connects conceptual layers over HTTP.\n" });
  const calls = [];

  await search(config, { query: "How does the API model work over HTTP?", mode: "auto" }, sdkAdapters(calls));

  assert.deepEqual(calls, ["lexical", "semantic"]);
});

test("a filename in a content question does not force metadata-only routing", async (t) => {
  const config = fixture(t, { "README.md": "The retry policy uses exponential delay.\n" });
  const calls = [];

  const result = await search(config, { query: "What does README.md say about retry policy?", mode: "auto" }, sdkAdapters(calls));

  assert.deepEqual(calls, ["lexical", "semantic"]);
  assert.equal(result.routeReason, "requestedModePipeline");
});

test("an explicit filename location question remains metadata-only", async (t) => {
  const config = fixture(t, { "zxqv-9f3a.toml": "internal text remains unavailable\n" });
  const calls = [];

  const result = await search(config, { query: "Where is zxqv-9f3a.toml?", mode: "auto" }, sdkAdapters(calls));

  assert.equal(result.results[0].relative, "zxqv-9f3a.toml");
  assert.equal(Object.hasOwn(result.results[0], "snippet"), false);
  assert.deepEqual(calls, []);
});

test("one incidental hit cannot resolve a multi-identifier question", async (t) => {
  const config = fixture(t, { "partial.md": "TARGET_MARKER is present without the other setting.\n" });
  const calls = [];

  await search(config, { query: "Compare TARGET_MARKER with EXTRA_FLAG", mode: "auto" }, sdkAdapters(calls));

  assert.deepEqual(calls, ["lexical", "semantic"]);
});

test("function-call syntax routes only on a bounded call name", async (t) => {
  const config = fixture(t, { "api.md": "Call lookupByHash(value) after validation.\n" });
  const calls = [];

  const result = await search(config, { query: "What does lookupByHash() do?", mode: "auto" }, sdkAdapters(calls));

  assert.equal(result.results[0].relative, "api.md");
  assert.deepEqual(calls, []);
});

test("a longer function name and filename both fall back from exact routing", async (t) => {
  const config = fixture(t, {
    "README.md.bak": "Call lookupByHashExtra(value) here.\n",
  });
  const functionCalls = [];
  const filenameCalls = [];

  await search(config, { query: "What does lookupByHash() do?", mode: "auto" }, sdkAdapters(functionCalls));
  await search(config, { query: "Where is README.md?", mode: "auto" }, sdkAdapters(filenameCalls));

  assert.deepEqual(functionCalls, ["lexical", "semantic"]);
  assert.deepEqual(filenameCalls, ["lexical", "semantic"]);
});

function indexedFixture(t, files) {
  const config = fixture(t, files);
  const fresh = reconcile(config);
  for (const record of fresh.catalogue.records) record.indexedHash = record.observedHash;
  publish(config, fresh.catalogue);
  const manifests = { docs: {} };
  for (const record of fresh.catalogue.records) {
    manifests.docs[`${record.sourceId}.md`] = { sourceId: record.sourceId, hash: record.observedHash };
  }
  return { config, records: fresh.catalogue.records, manifests };
}

test("semantic evidence selects the densest relevant passage, not the first query word", async (t) => {
  const intro = "Will this introduction mention an agent without answering the question?\n";
  const relevant = "Recovery keeps the task journal durable. The agent resumes pending work after restart.\n";
  const { config, records, manifests } = indexedFixture(t, { "design.md": `${intro}${"background filler\n".repeat(8)}${relevant}` });
  const candidate = [{ file: `qmd://docs/${records[0].sourceId}.md`, score: 0.9 }];

  const result = await search(config, { query: "Will the agent resume durable pending work after restart?", mode: "semantic", maxBytes: 120 }, {
    manifests, ...sdkAdapters([], candidate),
  });

  assert.match(result.results[0].snippet, /resumes pending work after restart/);
  assert.doesNotMatch(result.results[0].snippet, /introduction/);
  assert.equal(result.results[0].anchorStatus, "bestLexicalPassage");
});

test("semantic evidence finds a dense cluster later on the same long line", async (t) => {
  const text = `Will an agent appear here? ${"unrelated filler ".repeat(60)}The durable journal lets the agent resume pending work after restart.`;
  const { config, records, manifests } = indexedFixture(t, { "single-line.md": text });
  const candidate = [{ file: `qmd://docs/${records[0].sourceId}.md`, score: 0.9 }];

  const result = await search(config, { query: "Will the agent resume durable pending work after restart?", mode: "semantic", maxBytes: 120 }, {
    manifests, ...sdkAdapters([], candidate),
  });

  assert.match(result.results[0].snippet, /durable journal/);
  assert.match(result.results[0].snippet, /resume pending work/);
});

test("CJK and emoji excerpts preserve exact UTF-8 offsets and anchors", async (t) => {
  const prefix = "前置说明🙂🙂\n";
  const marker = "配置标记 TARGET_MARKER 生效。\n";
  const config = fixture(t, { "unicode.md": `${prefix}${marker}尾声\n` }, { maxBytes: 40 });

  const result = await search(config, { query: "Find TARGET_MARKER", mode: "auto", maxBytes: 40 }, sdkAdapters([]));
  const hit = result.results[0];
  const original = Buffer.from(`${prefix}${marker}尾声\n`);
  const reproduced = original.subarray(hit.locator.byteOffset, hit.locator.byteOffset + Buffer.byteLength(hit.snippet)).toString("utf8");

  assert.equal(reproduced, hit.snippet);
  assert.match(hit.snippet, /TARGET_MARKER/);
  assert.equal(hit.snippet.includes("�"), false);
  assert.equal(hit.matchedTerm, "TARGET_MARKER");
});

test("case-insensitive anchors preserve original offsets after Unicode length-changing folds", async (t) => {
  const text = "İ 前置🙂 TARGET_MARKER enabled.\n尾声\n";
  const config = fixture(t, { "unicode-fold.md": text }, { maxBytes: 48 });
  const calls = [];

  const result = await search(config, { query: "Find target_marker", mode: "auto", maxBytes: 48 }, sdkAdapters(calls));

  assert.deepEqual(calls, []);
  const hit = result.results[0];
  const original = Buffer.from(text);
  const reproduced = original.subarray(hit.locator.byteOffset, hit.locator.byteOffset + Buffer.byteLength(hit.snippet)).toString("utf8");
  assert.equal(reproduced, hit.snippet);
  assert.match(hit.snippet, /TARGET_MARKER/);
  assert.equal(hit.matchedTerm, "target_marker");
});

test("an anchor larger than the byte budget is not claimed as matched", async (t) => {
  const config = fixture(t, { "small.md": "🙂 VERY_LONG_IDENTIFIER 🙂\n" }, { maxBytes: 8 });

  const result = await search(config, { query: "Find VERY_LONG_IDENTIFIER", mode: "auto", maxBytes: 8 }, sdkAdapters([]));

  assert.equal(Buffer.byteLength(result.results[0].snippet) <= 8, true);
  assert.equal(Object.hasOwn(result.results[0], "matchedTerm"), false);
  assert.equal(result.results[0].contextIncomplete, true);
});

test("tight context never cuts an adjacent qualifier without disclosure", async (t) => {
  const text = "Background.\nDo not disable the safety barrier.\nUse --timeout-ms for bounded work.\nFinal qualifier.\n";
  const config = fixture(t, { "policy.md": text }, { maxBytes: 58 });

  const result = await search(config, { query: "How should --timeout-ms be used?", mode: "auto", maxBytes: 58 }, sdkAdapters([]));

  const hit = result.results[0];
  assert.equal(hit.snippet.includes("Do not disable the safety barrier.") || hit.contextIncomplete, true);
  assert.equal(hit.snippet.endsWith("\n") || hit.contextIncomplete, true);
});

test("packet sharing keeps a later exact hit from being starved", async (t) => {
  const long = `${"preface line\n".repeat(40)}TARGET_MARKER EXTRA_FLAG first\n${"tail line\n".repeat(40)}`;
  const config = fixture(t, { "first.md": long, "second.md": "TARGET_MARKER second\n" }, { maxBytes: 240, maxResults: 2 });

  const result = await search(config, { query: "Compare TARGET_MARKER with EXTRA_FLAG", mode: "auto", maxBytes: 240, maxResults: 2 }, sdkAdapters([]));

  assert.deepEqual(result.results.map((item) => item.relative).sort(), ["first.md", "second.md"]);
  assert.equal(result.bytes <= 240, true);
});

test("an exact source changed at the emission barrier is omitted", async (t) => {
  const config = fixture(t, { "changing.md": "Keep BARRIER_MARKER enabled.\n" });
  const target = path.join(config.roots[0].path, "changing.md");

  const result = await search(config, { query: "Where is BARRIER_MARKER?", mode: "auto" }, {
    ...sdkAdapters([]), beforeEmit() { fs.writeFileSync(target, "The marker was removed.\n"); },
  });

  assert.equal(result.results.length, 0);
  assert.equal(result.sourceUnavailable.some((item) => item.status === "changedBeforeEmission"), true);
});

test("pure semantic selection without a lexical anchor is labelled as source-only evidence", async (t) => {
  const { config, records, manifests } = indexedFixture(t, { "concept.md": "A separate concept is explained here.\nMore supporting context.\n" });
  const candidate = [{ file: `qmd://docs/${records[0].sourceId}.md`, score: 0.9 }];

  const result = await search(config, { query: "49c8f_missing_identifier is discussed where?", mode: "auto" }, {
    manifests, ...sdkAdapters([], candidate),
  });

  assert.equal(result.results[0].anchorStatus, "noLexicalAnchorBeginningFallback");
  assert.equal(result.results[0].selectedSourceOnly, true);
  assert.equal(result.negativeIsComplete, false);
});

test("a complete nearby negation line is retained when the budget permits", async (t) => {
  const prefix = "heading\n";
  const text = `${prefix}background\nDo not disable the safety barrier.\nUse --timeout-ms for bounded work.\nfinal qualifier\nappendix\n`;
  const config = fixture(t, { "policy.md": text }, { maxBytes: 180 });

  const result = await search(config, { query: "How should --timeout-ms be used?", mode: "auto", maxBytes: 180 }, sdkAdapters([]));

  assert.match(result.results[0].snippet, /Do not disable the safety barrier\./);
  assert.equal(Buffer.from(text).subarray(result.results[0].locator.byteOffset, result.results[0].locator.byteOffset + Buffer.byteLength(result.results[0].snippet)).toString("utf8"), result.results[0].snippet);
});

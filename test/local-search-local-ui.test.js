"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const modulePath = path.resolve(__dirname, "../packages/local-search/local-ui.js");

test("direct local UI refuses non-TTY streams", async () => {
  assert.equal(fs.existsSync(modulePath), true);
  const { main } = require(modulePath);
  let configured = false;
  const result = await main(["--config", "/private/tmp/search.json"], {
    input: { isTTY: false },
    output: { isTTY: true, write() {} },
    api: { configure() { configured = true; } },
  });
  assert.deepEqual(result, { ok: false, status: "ttyRequired" });
  assert.equal(configured, false);
});

test("setup persists only after explicit root, separate consents, and final yes", async () => {
  const { main } = require(modulePath);
  const answers = [
    "/private/tmp/client docs", "yes", "yes", ".md,.txt", "",
    "/private/tmp/local search state", "no", "yes", "quit",
  ];
  let saved;
  const output = { isTTY: true, text: "", write(value) { this.text += value; } };
  const result = await main(["--config", "/private/tmp/local search.json"], {
    input: { isTTY: true }, output,
    fileExists() { return false; },
    ask: async () => answers.shift(),
    api: {
      async configure(value) { saved = value; return value.config; },
    },
  });
  assert.equal(result.status, "closed");
  assert.deepEqual(saved, {
    configPath: "/private/tmp/local search.json",
    config: {
      version: 1,
      enabled: true,
      stateDirectory: "/private/tmp/local search state",
      roots: [{
        id: "root1",
        path: "/private/tmp/client docs",
        contentEnabled: true,
        extensions: [".md", ".txt"],
      }],
      qmd: null,
    },
  });
  assert.match(output.text, /lexical-only/i);
});

test("setup excludes a root denied metadata consent and can retain metadata-only scope", async () => {
  const { main } = require(modulePath);
  const answers = [
    "/private/tmp/denied", "no",
    "/private/tmp/metadata", "yes", "no", ".pdf", "",
    "/private/tmp/state", "no", "yes", "quit",
  ];
  let saved;
  const result = await main(["--config", "/private/tmp/search.json"], {
    input: { isTTY: true }, output: { isTTY: true, write() {} }, fileExists() { return false; },
    ask: async () => answers.shift(), api: { async configure(value) { saved = value; } },
  });
  assert.equal(result.status, "closed");
  assert.deepEqual(saved.config.roots, [{
    id: "root1", path: "/private/tmp/metadata", contentEnabled: false, extensions: [".pdf"],
  }]);
});

test("final setup refusal exits without writing configuration", async () => {
  const { main } = require(modulePath);
  const answers = [
    "/private/tmp/docs", "yes", "no", ".md", "",
    "/private/tmp/state", "no", "no",
  ];
  let writes = 0;
  const result = await main(["--config", "/private/tmp/search.json"], {
    input: { isTTY: true }, output: { isTTY: true, write() {} }, fileExists() { return false; },
    ask: async () => answers.shift(), api: { async configure() { writes += 1; } },
  });
  assert.deepEqual(result, { ok: false, status: "setupCancelled" });
  assert.equal(writes, 0);
});

test("QMD setup asks only for the embedding model that search uses", async () => {
  const { main } = require(modulePath);
  const answers = [
    "/private/tmp/docs", "yes", "yes", ".md", "",
    "/private/tmp/state", "yes", "/opt/node24", "/opt/qmd", "/opt/embed.gguf",
    "yes", "quit",
  ];
  let saved;
  const result = await main(["--config", "/private/tmp/search.json"], {
    input: { isTTY: true }, output: { isTTY: true, write() {} }, fileExists() { return false; },
    ask: async () => answers.shift(), api: { async configure(value) { saved = value; } },
  });
  assert.equal(result.status, "closed");
  assert.deepEqual(saved.config.qmd, {
    nodePath: "/opt/node24", packageRoot: "/opt/qmd", modelPaths: { embed: "/opt/embed.gguf" },
  });
});

test("EOF during setup exits without writing configuration or retaining listeners", async () => {
  const { main } = require(modulePath);
  const input = new EventEmitter();
  input.isTTY = true;
  let markAsked;
  const asked = new Promise((resolve) => { markAsked = resolve; });
  let writes = 0;
  const completion = main(["--config", "/private/tmp/search.json"], {
    input, output: { isTTY: true, write() {} }, fileExists() { return false; },
    ask: async () => { markAsked(); return new Promise(() => {}); },
    api: { async configure() { writes += 1; } },
  });
  await asked;
  input.emit("end");
  assert.deepEqual(await completion, { ok: true, status: "closed" });
  assert.equal(writes, 0);
  assert.equal(input.listenerCount("end"), 0);
});

test("search renders local evidence and opens only the chosen freshly-read hit", async () => {
  const { main } = require(modulePath);
  const answers = ["search", "needle", "keyword", "1", "quit"];
  const output = { isTTY: true, text: "", write(value) { this.text += value; } };
  const calls = [];
  const result = await main(["--config", "/private/tmp/search.json"], {
    input: { isTTY: true }, output,
    fileExists() { return true; },
    ask: async () => answers.shift(),
    platform: "darwin",
    runProcess(command, args, options) { calls.push({ command, args, options }); return { status: 0 }; },
    api: {
      async search(configPath, request) {
        assert.equal(configPath, "/private/tmp/search.json");
        assert.deepEqual(request, { query: "needle", mode: "keyword" });
        return { results: [{ sourceId: "source-1", rootId: "root1", relative: "notes/a file.md", snippet: "fresh needle excerpt", locator: { line: 7 }, sourceReadAt: "2026-09-13T00:00:00.000Z", hash: "same-hash" }] };
      },
      async read(_configPath, request) {
        assert.equal(request.sourceId, "source-1");
        return { ok: true, rootId: "root1", relative: "notes/a file.md", hash: "same-hash" };
      },
      _internals: { resolveConfig() { return { roots: [{ id: "root1", path: "/private/tmp/client docs" }] }; } },
    },
  });
  assert.equal(result.status, "closed");
  assert.match(output.text, /a file\.md/);
  assert.match(output.text, /line 7/);
  assert.match(output.text, /fresh needle excerpt/);
  assert.match(output.text, /2026-09-13/);
  assert.deepEqual(calls, [{
    command: "/usr/bin/open",
    args: ["/private/tmp/client docs/notes/a file.md"],
    options: { shell: false, stdio: "ignore" },
  }]);
});

test("content result refuses to open when its freshly read hash has changed", async () => {
  const { main } = require(modulePath);
  const answers = ["search", "needle", "keyword", "1", "quit"];
  const output = { isTTY: true, text: "", write(value) { this.text += value; } };
  let opens = 0;
  const result = await main(["--config", "/private/tmp/search.json"], {
    input: { isTTY: true }, output, fileExists() { return true; }, ask: async () => answers.shift(),
    platform: "darwin", runProcess() { opens += 1; return { status: 0 }; },
    api: {
      async search() {
        return {
          status: "completeAsOfSnapshot", negativeIsComplete: true, semanticStatus: "notRequested",
          contentScan: { bytes: 20, limit: 100, exceeded: false }, sourceUnavailable: [],
          results: [{ sourceId: "source-1", rootId: "root1", relative: "notes.md", snippet: "needle", hash: "displayed-hash" }],
        };
      },
      async read() { return { ok: true, rootId: "root1", relative: "notes.md", hash: "fresh-hash" }; },
      _internals: { resolveConfig() { return { roots: [{ id: "root1", path: "/private/tmp/docs" }] }; } },
    },
  });
  assert.equal(result.status, "closed");
  assert.equal(opens, 0);
  assert.match(output.text, /changedSource=true/);
  assert.match(output.text, /reselectionRequired=true/);
});

test("metadata-only result is verified inside its configured root without content read", async () => {
  const { main } = require(modulePath);
  const answers = ["search", "report", "filename", "1", "quit"];
  const output = { isTTY: true, text: "", write(value) { this.text += value; } };
  const calls = [];
  const root = { id: "root1", path: "/private/tmp/docs", contentEnabled: false, extensions: [".pdf"], maxFileBytes: 1000 };
  const result = await main(["--config", "/private/tmp/search.json"], {
    input: { isTTY: true }, output, fileExists() { return true; }, ask: async () => answers.shift(),
    platform: "darwin",
    verifyMetadata(selectedRoot, selectedPath) {
      calls.push(["verifyMetadata", selectedRoot, selectedPath]);
      return { ok: true, path: selectedPath, relative: "reports/q1.pdf", contentEligible: false };
    },
    runProcess(command, args, options) { calls.push(["open", command, args, options]); return { status: 0 }; },
    api: {
      async search() {
        return {
          status: "completeAsOfSnapshot", negativeIsComplete: true, semanticStatus: "notRequested",
          contentScan: { bytes: 0, limit: 100, exceeded: false }, sourceUnavailable: [],
          results: [{ sourceId: "source-1", rootId: "root1", relative: "reports/q1.pdf", mode: "filename" }],
        };
      },
      async read() { throw new Error("metadata-only result must not read content"); },
      _internals: { resolveConfig() { return { roots: [root] }; } },
    },
  });
  assert.equal(result.status, "closed");
  assert.deepEqual(calls[0], ["verifyMetadata", root, "/private/tmp/docs/reports/q1.pdf"]);
  assert.deepEqual(calls[1], ["open", "/usr/bin/open", ["/private/tmp/docs/reports/q1.pdf"], { shell: false, stdio: "ignore" }]);
});

test("search reports incomplete evidence and qualifies zero results", async () => {
  const { main } = require(modulePath);
  const answers = ["search", "needle", "semantic", "quit"];
  const output = { isTTY: true, text: "", write(value) { this.text += value; } };
  const result = await main(["--config", "/private/tmp/search.json"], {
    input: { isTTY: true }, output, fileExists() { return true; }, ask: async () => answers.shift(),
    api: {
      async search() {
        return {
          ok: true, status: "partial", results: [], negativeIsComplete: false,
          semanticPending: true, semanticStatus: "modelUnavailable",
          contentScan: { bytes: 4096, limit: 4096, exceeded: true },
          sourceUnavailable: [{ status: "sourceUnavailable", reason: "rootOfflineOrUnreadable" }],
        };
      },
    },
  });
  assert.equal(result.status, "closed");
  assert.match(output.text, /status=partial/);
  assert.match(output.text, /negative=unknown/);
  assert.match(output.text, /semantic=pending/);
  assert.match(output.text, /reason=modelUnavailable/);
  assert.match(output.text, /scan=4096\/4096/);
  assert.match(output.text, /scanExceeded=true/);
  assert.match(output.text, /unavailable=1/);
});

test("terminal rendering removes ANSI, OSC, C0, and C1 controls from search evidence", async () => {
  const { main } = require(modulePath);
  const answers = ["search", "needle", "keyword", "", "quit"];
  const output = { isTTY: true, text: "", write(value) { this.text += value; } };
  await main(["--config", "/private/tmp/search.json"], {
    input: { isTTY: true }, output, fileExists() { return true; }, ask: async () => answers.shift(),
    api: {
      async search() {
        return {
          ok: true, status: "completeAsOfSnapshot", negativeIsComplete: true,
          semanticPending: false, semanticStatus: "notRequested",
          contentScan: { bytes: 10, limit: 100, exceeded: false },
          sourceUnavailable: [{ reason: "gone\u001b]52;c;STOLEN\u0007" }],
          results: [{
            sourceId: "source-1", rootId: "root1",
            relative: "safe\u001b]52;c;STOLEN\u0007.md\u001b[31m",
            snippet: "line\u009b31mred\u009b0m\nnext\tok\u0000",
            hash: "display-hash",
          }],
        };
      },
    },
  });
  assert.equal(output.text.includes("STOLEN"), false);
  assert.equal(/[\u001b\u009b\u009d\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(output.text), false);
  assert.match(output.text, /safe\.md/);
  assert.match(output.text, /linered\nnext\tok/);
});

test("status, index, watcher controls, and disable use the package API", async () => {
  const { main } = require(modulePath);
  const answers = ["status", "index", "watchstart", "watchstop", "disable", "yes", "quit"];
  const output = { isTTY: true, text: "", write(value) { this.text += value; } };
  const calls = [];
  const config = { version: 1, enabled: true, stateDirectory: "/private/tmp/state", roots: [{ id: "root1", path: "/private/tmp/docs", contentEnabled: false, extensions: [".md"] }], qmd: null };
  const result = await main(["--config", "/private/tmp/search.json"], {
    input: { isTTY: true }, output, fileExists() { return true; }, ask: async () => answers.shift(),
    api: {
      async status() { calls.push("status"); return { enabled: true, status: "passive" }; },
      async index(_configPath, options) { calls.push(options.signal instanceof AbortSignal ? "index" : "bad-index"); return { status: "unchanged" }; },
      async watch(_configPath, options) {
        calls.push(options.signal instanceof AbortSignal ? "watchstart" : "bad-watch");
        return { ok: true, async stop() { calls.push("watchstop"); } };
      },
      async configure(value) { calls.push(value.config.enabled ? "enable" : "disable"); },
      _internals: { resolveConfig() { return config; } },
    },
  });
  assert.equal(result.status, "closed");
  assert.deepEqual(calls, ["status", "index", "watchstart", "watchstop", "disable"]);
  assert.match(output.text, /passive/);
  assert.match(output.text, /unchanged/);
});

test("SIGHUP drains the watcher owned by the Terminal session", async () => {
  const { main } = require(modulePath);
  const signals = new EventEmitter();
  let questions = 0;
  let stopped = 0;
  let markWaiting;
  const waiting = new Promise((resolve) => { markWaiting = resolve; });
  const completion = main(["--config", "/private/tmp/search.json"], {
    input: { isTTY: true }, output: { isTTY: true, write() {} }, signalSource: signals,
    fileExists() { return true; },
    ask: async () => {
      questions += 1;
      if (questions === 1) return "watchstart";
      markWaiting();
      return new Promise(() => {});
    },
    api: {
      async watch() { return { ok: true, async stop() { stopped += 1; } }; },
    },
  });
  await waiting;
  signals.emit("SIGHUP");
  const result = await completion;
  assert.deepEqual(result, { ok: true, status: "closed" });
  assert.equal(stopped, 1);
  assert.equal(signals.listenerCount("SIGHUP"), 0);
});

test("SIGHUP aborts a watcher while startup is still pending, then drains it", async () => {
  const { main } = require(modulePath);
  const signals = new EventEmitter();
  let startupSignal;
  let resolveStartup;
  let markStarted;
  let questions = 0;
  let stopped = 0;
  const startup = new Promise((resolve) => { resolveStartup = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  const completion = main(["--config", "/private/tmp/search.json"], {
    input: { isTTY: true }, output: { isTTY: true, write() {} }, signalSource: signals,
    fileExists() { return true; },
    ask: async () => {
      questions += 1;
      return questions === 1 ? "watchstart" : new Promise(() => {});
    },
    api: {
      async watch(_configPath, options) {
        startupSignal = options.signal;
        markStarted();
        return startup;
      },
    },
  });
  await started;
  signals.emit("SIGHUP");
  assert.equal(startupSignal.aborted, true);
  resolveStartup({ ok: true, async stop() { stopped += 1; } });
  assert.deepEqual(await completion, { ok: true, status: "closed" });
  assert.equal(stopped, 1);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  assert.equal(signals.listenerCount("SIGHUP"), 0);
});

for (const [signal, operation] of [["SIGTERM", "search"], ["SIGTERM", "index"], ["SIGHUP", "index"]]) {
  test(`${signal} cancels an active ${operation} before closing`, async () => {
    const { main } = require(modulePath);
    const signals = new EventEmitter();
    const answers = operation === "search" ? ["search", "needle", "keyword"] : ["index"];
    let activeSignal;
    let markActive;
    const active = new Promise((resolve) => { markActive = resolve; });
    const onOperation = async (_configPath, _request, options) => {
      activeSignal = (options || _request).signal;
      markActive();
      await new Promise((resolve) => activeSignal.addEventListener("abort", resolve, { once: true }));
      return operation === "search"
        ? { status: "partial", results: [], negativeIsComplete: false, contentScan: {}, sourceUnavailable: [] }
        : { status: "cancelled" };
    };
    const completion = main(["--config", "/private/tmp/search.json"], {
      input: { isTTY: true }, output: { isTTY: true, write() {} }, signalSource: signals,
      fileExists() { return true; }, ask: async () => answers.shift() || new Promise(() => {}),
      api: operation === "search" ? { search: onOperation } : { index: onOperation },
    });
    await active;
    signals.emit(signal);
    assert.equal(activeSignal.aborted, true);
    assert.deepEqual(await completion, { ok: true, status: "closed" });
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
    assert.equal(signals.listenerCount("SIGHUP"), 0);
  });
}

test("watch startup rejection removes session listeners", async () => {
  const { main } = require(modulePath);
  const signals = new EventEmitter();
  await assert.rejects(
    main(["--config", "/private/tmp/search.json"], {
      input: { isTTY: true }, output: { isTTY: true, write() {} }, signalSource: signals,
      fileExists() { return true; }, ask: async () => "watchstart",
      api: { async watch() { throw new Error("synthetic startup failure"); } },
    }),
    /synthetic startup failure/,
  );
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  assert.equal(signals.listenerCount("SIGHUP"), 0);
});

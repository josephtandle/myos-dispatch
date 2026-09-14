"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const packageJson = require("../package.json");
const localSearchApi = require("../packages/local-search");
const nestedCli = require("../packages/local-search/bin/local-search.js");
const entrypoint = path.resolve(__dirname, "../bin/myos-local-search.js");
const node24 = process.env.MYOS_TEST_NODE24 || (process.versions.node.split(".")[0] === "24" ? process.execPath : null);

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "myos-local-search-entrypoint-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [entrypoint, ...args], { encoding: "utf8", ...options });
}

function fakeNode(t, version = "v24.9.0") {
  const executable = path.join(temporaryDirectory(t), "fake-node");
  fs.writeFileSync(executable, `#!/usr/bin/env node
if(process.argv[2]==="--version"){process.stdout.write(${JSON.stringify(`${version}\n`)});process.exit(0)}
const args=process.argv.slice(3);process.stdout.write(JSON.stringify({argv:args})+"\\n");process.exit(args[0]==="fail"?7:0)
`);
  fs.chmodSync(executable, 0o755);
  return executable;
}

test("root package registers the MyOS local-search command", () => {
  assert.equal(packageJson.bin["myos-local-search"], "bin/myos-local-search.js");
});

test("help works without a Node 24 runtime or local-search configuration", () => {
  const child = run(["--help"]);
  assert.equal(child.status, 0);
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, "help");
  assert.equal(result.taskClass, "cheap_routing");
  assert.match(result.usage, /--node24/);
});

test("runtime validation rejects missing, relative, nonexistent, and wrong-major paths", (t) => {
  const cases = [
    [],
    ["--node24", "node", "status"],
    ["--node24", "/definitely/not/a/node", "status"],
    ["--node24", fakeNode(t, "v22.14.0"), "status"],
  ];
  for (const args of cases) {
    const child = run(args);
    assert.equal(child.status, 1);
    const result = JSON.parse(child.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.taskClass, "cheap_routing");
    assert.match(result.status, /^(invalidRuntime|wrongRuntimeMajor)$/);
  }
});

test("config paths and punctuated queries remain single argv values", (t) => {
  const runtime = fakeNode(t);
  const config = "/tmp/a config;$(never).json";
  const query = "what's here; $(never) & why?";
  const child = run(["--node24", runtime, "search", "--config", config, "--query", query]);
  assert.equal(child.status, 0);
  assert.deepEqual(JSON.parse(child.stdout).argv, ["search", "--config", config, "--query", query]);
});

test("nested output and nonzero exit status propagate unchanged", (t) => {
  const runtime = fakeNode(t);
  const child = run(["--node24", runtime, "fail", "--config", "/tmp/config.json"]);
  assert.equal(child.status, 7);
  assert.equal(child.stdout, `${JSON.stringify({ argv: ["fail", "--config", "/tmp/config.json"] })}\n`);
});

test("disabled status runs through the real Node 24 nested CLI", (t) => {
  if (!node24) return t.skip("set MYOS_TEST_NODE24 when this test runs under an older parent runtime");
  assert.equal(fs.existsSync(node24), true);
  const directory = temporaryDirectory(t);
  const config = path.join(directory, "local-search.json");
  fs.writeFileSync(config, `${JSON.stringify({ version: 1, enabled: false, stateDirectory: path.join(directory, "state"), roots: [] })}\n`, { mode: 0o600 });
  const child = run(["--node24", node24, "status", "--config", config]);
  assert.equal(child.status, 0);
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, "disabled");
  assert.equal(result.taskClass, "cheap_routing");
});

for (const operation of ["index", "search"]) test(`nested ${operation} cancellation reaches the API signal and removes handlers`, async (t) => {
  const original = localSearchApi[operation];
  const originalSigint = new Set(process.listeners("SIGINT"));
  const originalSigterm = new Set(process.listeners("SIGTERM"));
  let reached;
  const started = new Promise((resolve) => { reached = resolve; });
  localSearchApi[operation] = async (...args) => {
    const options = args.at(-1);
    reached(options.signal);
    await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
    return { ok: false, status: "aborted" };
  };
  t.after(() => { localSearchApi[operation] = original; });

  const args = operation === "index"
    ? ["index", "--config", "/tmp/local-search.json"]
    : ["search", "--config", "/tmp/local-search.json", "--query", "alpha"];
  const completion = nestedCli.main(args);
  const signal = await started;
  process.emit("SIGTERM");
  const result = await completion;

  assert.equal(signal.aborted, true);
  assert.equal(result.status, "aborted");
  assert.deepEqual(new Set(process.listeners("SIGINT")), originalSigint);
  assert.deepEqual(new Set(process.listeners("SIGTERM")), originalSigterm);
});

test("nested watch cancellation during startup stops after startup resolves", async (t) => {
  const originalWatch = localSearchApi.watch;
  const originalSigint = new Set(process.listeners("SIGINT"));
  let releaseStartup;
  let startupReached;
  const reached = new Promise((resolve) => { startupReached = resolve; });
  const release = new Promise((resolve) => { releaseStartup = resolve; });
  let stops = 0;
  localSearchApi.watch = async (_config, options) => {
    startupReached(options.signal);
    await release;
    return { ok: true, stop: async () => { stops += 1; } };
  };
  t.after(() => {
    localSearchApi.watch = originalWatch;
    for (const listener of process.listeners("SIGINT")) if (!originalSigint.has(listener)) process.removeListener("SIGINT", listener);
  });

  const completion = nestedCli.main(["watch", "--config", "/tmp/local-search.json"]);
  const signal = await reached;
  process.emit("SIGTERM");
  assert.equal(signal.aborted, true);
  releaseStartup();
  const result = await Promise.race([
    completion,
    new Promise((resolve) => setTimeout(() => resolve({ status: "deadlineExceeded" }), 250)),
  ]);
  assert.equal(result.status, "stopped");
  assert.equal(stops, 1);
});

test("nested watch cancellation after readiness stops the owned maintenance lifecycle", async (t) => {
  const originalWatch = localSearchApi.watch;
  const originalSigint = new Set(process.listeners("SIGINT"));
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });
  let stops = 0;
  localSearchApi.watch = async () => {
    markReady();
    return { ok: true, stop: async () => { stops += 1; } };
  };
  t.after(() => {
    localSearchApi.watch = originalWatch;
    for (const listener of process.listeners("SIGINT")) if (!originalSigint.has(listener)) process.removeListener("SIGINT", listener);
  });

  const completion = nestedCli.main(["watch", "--config", "/tmp/local-search.json"]);
  await ready;
  await new Promise((resolve) => setImmediate(resolve));
  process.emit("SIGTERM");
  const result = await Promise.race([
    completion,
    new Promise((resolve) => setTimeout(() => resolve({ status: "deadlineExceeded" }), 250)),
  ]);
  assert.equal(result.status, "stopped");
  assert.equal(stops, 1);
});

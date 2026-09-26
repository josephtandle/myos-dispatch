"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createJevClient, choice, noul, score, decide, yes, level, REASONS, DEFAULT_MODEL } = require("../src/runtime/jev-client");

const questions = { route: noul("private question") };
const response = (status = 200, body = { answers: {} }, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (name) => headers[name] ?? null },
  text: async () => JSON.stringify(body),
});
const client = (options = {}) => createJevClient({ apiKey: "test-key", fetch: async () => response(), ...options });

function environment(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}

test.beforeEach((t) => environment(t, { MYOS_JEV_ENABLED: undefined, TYPESAFE_API_KEY: undefined }));

test("key uses environment before the env file", async (t) => {
  environment(t, { TYPESAFE_API_KEY: "env-test-key" });
  t.mock.method(fs, "readFileSync", () => { throw new Error("must not read file"); });
  const c = createJevClient({ envFile: "/unused", fetch: async (_, options) => {
    assert.equal(options.headers.authorization, "Bearer env-test-key");
    return response();
  } });
  assert.equal(c.isConfigured(), true);
  assert.equal((await c.ask({}, questions)).ok, true);
});

test("key uses runtime-secrets env loader without mutating process env", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-env-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, 'TYPESAFE_API_KEY="file-test-key"\n');
  const c = createJevClient({ envFile, fetch: async (_, options) => {
    assert.equal(options.headers.authorization, "Bearer file-test-key");
    return response();
  } });
  assert.equal(c.isConfigured(), true);
  assert.equal((await c.ask({}, questions)).ok, true);
  assert.equal(process.env.TYPESAFE_API_KEY, undefined);
});

for (const code of ["EACCES", "ENOENT", "PARSE_ERROR"]) {
  test(`${code} from env loading leaves client unconfigured`, async (t) => {
    t.mock.method(fs, "existsSync", () => true);
    t.mock.method(fs, "readFileSync", () => { throw Object.assign(new Error(code), { code }); });
    const c = createJevClient({ envFile: "/fake", fetch: () => assert.fail("unexpected fetch") });
    assert.equal(c.isConfigured(), false);
    assert.equal((await c.ask({}, questions)).reason, "typesafe_key_missing");
  });
}

test("missing env file leaves client unconfigured", (t) => {
  t.mock.method(fs, "existsSync", () => false);
  assert.equal(createJevClient({ envFile: "/missing", fetch: () => assert.fail() }).isConfigured(), false);
});

test("disabled has no fetch or env file read", async (t) => {
  environment(t, { MYOS_JEV_ENABLED: "0" });
  t.mock.method(fs, "readFileSync", () => assert.fail("unexpected read"));
  const c = createJevClient({ fetch: () => assert.fail("unexpected fetch") });
  assert.equal(c.isConfigured(), false);
  assert.equal((await c.ask({}, questions)).reason, "disabled");
  assert.ok(REASONS.includes("disabled"));
});

test("success preserves choice, noul and score answers and reports only metadata", async () => {
  const answers = {
    route: { type: "choice", choice: "a", confidence: 0.9 },
    allowed: { type: "noul", noul: 0.8 },
    rating: { type: "score", score: 1.6, confidence: 0.7, legend: { 0: "low", 1: "mid", 2: "high" }, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 } },
  };
  const records = [];
  const qs = { route: choice("private choices", { a: "yes", b: "no" }), allowed: noul("private noul"), rating: score("private score", ["low", "mid", "high"]) };
  const result = await client({ onResult: (r) => records.push(r), fetch: async (_, options) => {
    assert.deepEqual(JSON.parse(options.body).questions, qs);
    assert.equal(JSON.parse(options.body).model, "jev-1.13.0");
    return response(200, { answers, usage: { input_tokens: 12, output_tokens: 4 } }, { "x-typesafe-request-id": "req-1" });
  } }).ask({ privateState: "private state" }, qs);
  assert.equal(DEFAULT_MODEL, "jev-1.13.0");
  assert.deepEqual(result.answers, answers);
  assert.deepEqual(decide(answers.route, { floor: 0.8 }), { choice: "a", confidence: 0.9, meetsFloor: true });
  assert.equal(yes(answers.allowed), true);
  assert.deepEqual(level(answers.rating), { level: 2, score: 1.6, confidence: 0.7 });
  assert.equal(result.requestId, "req-1");
  assert.equal(records.length, 1);
  assert.deepEqual(Object.keys(records[0]).sort(), ["ts", "model", "questionKeys", "latencyMs", "attempts", "ok", "reason", "inputTokens", "outputTokens", "requestId"].sort());
  assert.equal(records[0].requestId, "req-1");
  assert.equal(records[0].inputTokens, 12);
  assert.equal(records[0].outputTokens, 4);
  assert.doesNotMatch(JSON.stringify(records), /private|test-key/);
});

test("builder option limits are validated locally", () => {
  assert.throws(() => choice("pick", Object.fromEntries(Array.from({ length: 256 }, (_, i) => [i, "option"]))), /255/);
  assert.equal(Object.keys(choice("pick", Object.fromEntries(Array.from({ length: 255 }, (_, i) => [i, "option"]))).criteria).length, 255);
  assert.throws(() => score("rate", Array(11).fill("level")), /10/);
  assert.equal(score("rate", Array(10).fill("level")).criteria.length, 10);
});

for (const [status, reason] of [[401, "auth_error"], [403, "auth_error"], [422, "schema_error"], [400, "http_error"]]) {
  test(`${status} is final`, async () => {
    let calls = 0;
    const result = await client({ fetch: async () => { calls++; return response(status); } }).ask({}, questions);
    assert.equal(result.reason, reason);
    assert.equal(result.attempts, 1);
    assert.equal(calls, 1);
  });
}

for (const status of [429, 503, 500]) {
  test(`${status} retries once by default`, async () => {
    let calls = 0;
    const result = await client({ fetch: async () => response(++calls === 1 ? status : 200, { answers: {} }, { "retry-after": "0" }) }).ask({}, questions);
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
  });
}

test("529 twice then success with explicit retries", async () => {
  let calls = 0;
  const result = await client({ maxRetries: 2, fetch: async () => response(++calls <= 2 ? 529 : 200, { answers: {} }, { "retry-after": "0" }) }).ask({}, questions);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
});

test("retry-after-ms takes precedence over retry-after", async () => {
  let calls = 0;
  const result = await client({ timeoutMs: 100, fetch: async () => response(++calls === 1 ? 429 : 200, { answers: {} }, { "retry-after-ms": "0", "retry-after": "3600" }) }).ask({}, questions);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
});

test("retry-after accepts HTTP dates and never waits past budget", async () => {
  const headers = { "retry-after": new Date(Date.now() + 3600000).toUTCString(), "x-typesafe-request-id": "rate-id" };
  const result = await client({ timeoutMs: 30, fetch: async () => response(429, {}, headers) }).ask({}, questions);
  assert.equal(result.reason, "rate_limited");
  assert.equal(result.attempts, 1);
  assert.equal(result.requestId, "rate-id");
  assert.ok(result.latencyMs < 90);
});

test("timeout aborts a never resolving fetch", async () => {
  let signal;
  const result = await client({ timeoutMs: 20, maxRetries: 0, fetch: (_, options) => {
    signal = options.signal;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  } }).ask({}, questions);
  assert.equal(result.reason, "timeout");
  assert.equal(signal.aborted, true);
});

test("total wall cap also covers ignored aborts and stalled body reads", async () => {
  let calls = 0;
  const result = await client({ timeoutMs: 60, maxRetries: 100, fetch: async () => {
    calls++;
    if (calls < 3) return response(529, {}, { "retry-after-ms": "65" });
    return { ...response(), text: () => new Promise(() => {}) };
  } }).ask({}, questions);
  assert.equal(result.reason, "timeout");
  assert.equal(result.attempts, 3);
  assert.ok(result.latencyMs >= 150);
  assert.ok(result.latencyMs < 240, `latency ${result.latencyMs}`);
  const ignored = await client({ timeoutMs: 20, maxRetries: 0, fetch: () => new Promise(() => {}) }).ask({}, questions);
  assert.equal(ignored.reason, "timeout");
});

test("network failures retry with backoff and hooks cannot break results", async (t) => {
  t.mock.method(Math, "random", () => 0);
  let calls = 0;
  const result = await client({ onResult: () => { throw new Error("hook failed"); }, fetch: async () => {
    if (++calls === 1) throw new Error("offline");
    return response();
  } }).ask({}, questions);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.ok(result.latencyMs >= 290);
});

test("sidecar parser defaults to an eligible class and supports overrides without launching", () => {
  const source = fs.readFileSync(path.join(__dirname, "../bin/myos-sidecar.js"), "utf8");
  const parser = source.slice(source.indexOf("function parseArgs("), source.indexOf("function usage("));
  const parse = (argv, env = {}) => vm.runInNewContext(`${parser}; parseArgs(argv)`, { process: { env }, argv });
  const { selectModels } = require("../src/runtime/oauth-registry");
  const taskClass = parse(["question"]).taskClass;
  assert.equal(taskClass, "cheap_routing");
  assert.equal(selectModels({ models: [{ provider: "codex", model: "gpt-5.6-luna", visible: true, auth: "subscription", observedAt: new Date().toISOString() }] }, { provider: "codex", taskClass }).length, 1);
  assert.equal(parse(["question"], { MYOS_SIDECAR_TASK_CLASS: "planning" }).taskClass, "planning");
  assert.equal(parse(["--task-class", "heavy_synthesis", "question"], { MYOS_SIDECAR_TASK_CLASS: "planning" }).taskClass, "heavy_synthesis");
  assert.match(source, /taskClass: args.taskClass/);
  assert.match(source, /modelProfile: args.taskClass/);
  assert.doesNotMatch(source, /openai_cheap_extraction/);
});

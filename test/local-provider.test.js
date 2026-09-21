const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const nativeFetch = global.fetch;
const { myOSrunOauth, myOSrunAPI, setCodexExecRunnerForTest, resetCodexExecRunnerForTest } = require("../src/runtime/llm-call");
const { localCandidate, requireOfflineSnapshot } = require("../src/runtime/local-provider");
const { flushUsageEventsSync, readUsageEvents } = require("../src/runtime/myos-usage-ledger");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-local-test-"));
  t.after(() => { flushUsageEventsSync(); fs.rmSync(root, { recursive: true, force: true }); });
  const previous = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  const snapshotPath = path.join(root, "cache", "snapshot");
  fs.mkdirSync(snapshotPath, { recursive: true });
  fs.writeFileSync(path.join(snapshotPath, "config.json"), "{}");
  fs.writeFileSync(path.join(snapshotPath, "tokenizer.json"), "{}");
  fs.writeFileSync(path.join(snapshotPath, "model.safetensors"), "cached weights");
  const runtimeModule = path.join(root, "runtime.cjs");
  fs.writeFileSync(runtimeModule, `module.exports = {
    ensureLocalMlxServer: async () => true
  };`);
  const plistPath = path.join(root, "qwen.plist");
  fs.writeFileSync(plistPath, '<plist><dict><key>EnvironmentVariables</key><dict><key>HF_HUB_OFFLINE</key><string>1</string></dict></dict></plist>');
  const configPath = path.join(root, "local.json");
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true, runtimeModule, snapshotPath, cacheRoot: path.join(root, "cache"), plistPath, model: "mlx-community/Qwen3.5-35B-A3B-4bit" }));
  process.env.MYOS_PUBLIC_LOCAL_PROVIDER_CONFIG = configPath;
  process.env.MYOS_AUTH_MODE = "oauth";
  process.env.MYOS_LANE_STATE_PATH = path.join(root, "absent.json");
  process.env.MYOS_MODEL_CATALOG_LOCAL = path.join(root, "assignments.json");
  process.env.MYOS_USAGE_LEDGER_DIR = path.join(root, "usage");
  process.env.MYOS_ACTIVITY_LEDGER_DIR = path.join(root, "activity");
  process.env.MYOS_DISPATCH_HEALTH_ENABLED = "0";
  process.env.MYOS_SPEND_POLICY_PATH = path.join(root, "spend.json");
  fs.writeFileSync(process.env.MYOS_SPEND_POLICY_PATH, "{}");
  process.env.MYOS_DISABLE_PROVIDER_ALERTS = "1";
  setCodexExecRunnerForTest(() => { throw new Error("Test forbids cloud execution"); });
  t.after(resetCodexExecRunnerForTest);
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url, options) => {
    assert.equal(String(url), "http://127.0.0.1:8891/v1/chat/completions");
    assert.equal(options.redirect, "error");
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 2, completion_tokens: 4 } }) };
  };
  return { root, snapshotPath, configPath, runtimeModule, config: JSON.parse(fs.readFileSync(configPath, "utf8")) };
}

test("opted-in cheap routing executes local without OAuth transport credentials", async (t) => {
  fixture(t);
  const result = await myOSrunOauth({ taskClass: "cheap_routing", prompt: "Return JSON with ok true", responseMode: "json", humanVisible: true, maxOutputTokens: 64 });
  assert.equal(result.resolvedProviderOrTool, "local");
  assert.equal(result.transportAuthMode, "none");
  assert.equal(result.billingMode, "local");
  assert.equal(result.authMode, "oauth");
  assert.equal(result.estimatedCostUsd, 0);
  assert.deepEqual(result.json, { ok: true });
});

test("latency-bounded OAuth skips cold local startup without changing API lifecycle", async t => {
  const { runtimeModule } = fixture(t);
  fs.writeFileSync(runtimeModule, 'module.exports = { starts: 0, ensureLocalMlxServer: async function () { this.starts++; return false; } };');
  global.fetch = async () => { throw Object.assign(new Error("refused"), { cause: { code: "ECONNREFUSED" } }); };
  setCodexExecRunnerForTest(() => '{"cloud":true}');
  const result = await myOSrunOauth({ taskClass: "cheap_routing", prompt: "classify", humanVisible: true, timeoutMs: 10000 });
  assert.equal(result.resolvedProviderOrTool, "openai");
  assert.equal(require(runtimeModule).starts, 0);
});

test("API workflow local attempt is free and retains API workflow provenance", async (t) => {
  fixture(t);
  process.env.MYOS_AUTH_MODE = "api";
  const result = await myOSrunAPI({ taskClass: "cheap_routing", prompt: "hello" });
  assert.equal(result.resolvedProviderOrTool, "local");
  assert.equal(result.authMode, "api");
  assert.equal(result.transportAuthMode, "none");
  assert.equal(result.billingMode, "local");
  assert.equal(result.authLabel, "local:none");
  flushUsageEventsSync();
  const events = readUsageEvents();
  assert.ok(events.length > 0);
  assert.equal(events.at(-1).billable, false);
  assert.equal(events.at(-1).transportAuthMode, "none");
});

test("local-only lane does not acquire a cloud fallback", async (t) => {
  const { snapshotPath } = fixture(t);
  process.env.MYOS_AUTH_MODE = "api";
  fs.unlinkSync(path.join(snapshotPath, "model.safetensors"));
  await assert.rejects(myOSrunAPI({ taskClass: "cheap_routing", complianceLane: "unattended_local", prompt: "hello" }), /Local provider unavailable/);
});

test("missing offline weights fall back to the same OAuth lane without importing the host runtime", async (t) => {
  const { snapshotPath, runtimeModule } = fixture(t);
  fs.unlinkSync(path.join(snapshotPath, "model.safetensors"));
  fs.writeFileSync(runtimeModule, 'throw new Error("MUST NOT IMPORT");');
  let cloudCalls = 0;
  setCodexExecRunnerForTest(() => { cloudCalls++; return '{"cloud":true}'; });
  const result = await myOSrunOauth({ taskClass: "cheap_routing", prompt: "hello", humanVisible: true, responseMode: "json" });
  assert.equal(result.resolvedProviderOrTool, "openai");
  assert.equal(result.authMode, "oauth");
  assert.equal(result.fallbackIndex, 1);
  assert.equal(cloudCalls, 1);
});

test("missing local weights keep API fallback in API transport", async (t) => {
  const { snapshotPath } = fixture(t);
  process.env.MYOS_AUTH_MODE = "api";
  process.env.GEMINI_API_KEY = "test-placeholder-not-a-secret";
  process.env.OPENAI_API_KEY = "test-placeholder-not-a-secret";
  fs.unlinkSync(path.join(snapshotPath, "model.safetensors"));
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async (url) => {
    calls++;
    assert.match(String(url), /generativelanguage.googleapis.com/);
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "cloud" }] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 } }) };
  };
  const result = await myOSrunAPI({ taskClass: "cheap_routing", prompt: "hello" });
  assert.equal(result.resolvedProviderOrTool, "google");
  assert.equal(result.transportAuthMode, "api");
  assert.equal(result.authMode, "api");
  assert.equal(result.fallbackIndex, 1);
  assert.equal(calls, 1);
});

test("local eligibility preserves foreground OAuth gate and global kill switch", async (t) => {
  fixture(t);
  await assert.rejects(myOSrunOauth({ taskClass: "cheap_routing", prompt: "hello" }), /humanVisible/);
  fs.writeFileSync(process.env.MYOS_SPEND_POLICY_PATH, JSON.stringify({ killSwitch: true }));
  await assert.rejects(myOSrunOauth({ taskClass: "cheap_routing", prompt: "hello", humanVisible: true }), /kill switch/);
});

test("explicit intents never get replaced by the cheap local tier", async (t) => {
  fixture(t);
  setCodexExecRunnerForTest(() => 'cloud');
  for (const intent of ["planning_evaluation", "heavy_synthesis_escalated", "unknown_explicit_intent"]) {
    const result = await myOSrunOauth({ taskClass: "cheap_routing", intent, prompt: "hello", humanVisible: true });
    assert.notEqual(result.resolvedProviderOrTool, "local", intent);
  }
  assert.equal(localCandidate({ taskClass: "cheap_routing", intent: "advisory_strategy", prompt: "hello" }), null);
});

test("lane overrides and model assignment declarations retain their priority", async (t) => {
  const { root } = fixture(t);
  setCodexExecRunnerForTest(() => 'cloud');
  fs.writeFileSync(process.env.MYOS_LANE_STATE_PATH, JSON.stringify({ authMode: "oauth", routeOverrides: { cheap_routing: { interactive_oauth: { llmTargets: [{ type: "llm", provider: "openai", profile: "cheap_routing", authMode: "oauth" }] } } } }));
  const options = { taskClass: "cheap_routing", prompt: "hello", humanVisible: true };
  assert.equal((await myOSrunOauth(options)).resolvedProviderOrTool, "openai");
  fs.unlinkSync(process.env.MYOS_LANE_STATE_PATH);
  process.env.MYOS_MODEL_CATALOG_LOCAL = path.join(root, "manual-assignment.json");
  fs.writeFileSync(process.env.MYOS_MODEL_CATALOG_LOCAL, JSON.stringify({ assignments: { cheap_routing: { source: "manual", provider: "openai", model: "gpt-5-mini" } } }));
  assert.equal((await myOSrunOauth(options)).resolvedProviderOrTool, "openai");
});

test("empty or missing successful local output falls through to OAuth", async (t) => {
  fixture(t);
  setCodexExecRunnerForTest(() => 'cloud');
  for (const content of ["", "  ", undefined, null]) {
    global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
    const result = await myOSrunOauth({ taskClass: "cheap_routing", prompt: "hello", humanVisible: true });
    assert.equal(result.resolvedProviderOrTool, "openai");
    assert.equal(result.fallbackIndex, 1);
  }
});

test("307 and 308 redirects never receive the prompt at another origin", async (t) => {
  const { runtimeModule } = fixture(t);
  let targetRequests = 0;
  const target = http.createServer((_req, res) => { targetRequests++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: "redirected" } }] })); });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { target.closeAllConnections(); target.close(resolve); }));
  let status = 307;
  const origin = http.createServer((_req, res) => { res.writeHead(status, { location: `http://127.0.0.1:${target.address().port}/capture` }); res.end(); });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { origin.closeAllConnections(); origin.close(resolve); }));
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = (url, options) => nativeFetch(String(url).replace("http://127.0.0.1:8891", `http://127.0.0.1:${origin.address().port}`), options);
  fs.writeFileSync(runtimeModule, `module.exports = {
    ensureLocalMlxServer: async () => { throw new Error('MUST NOT RESTART FOR REDIRECT'); },
    localMlxRequest: async () => { throw new Error('PRIVATE TRANSPORT MUST NOT BE USED'); }
  };`);
  setCodexExecRunnerForTest(() => 'cloud');
  for (status of [307, 308]) {
    const result = await myOSrunOauth({ taskClass: "cheap_routing", prompt: "private prompt", humanVisible: true });
    assert.equal(targetRequests, 0);
    assert.equal(result.resolvedProviderOrTool, "openai");
  }
});

test("malformed local JSON falls back without cold-starting a running model", async (t) => {
  const { runtimeModule } = fixture(t);
  fs.writeFileSync(runtimeModule, `module.exports = {
    ensureLocalMlxServer: async () => { throw new Error('MUST NOT START'); }
  };`);
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'invalid json' } }] }) });
  setCodexExecRunnerForTest(() => '{"ok":true}');
  const result = await myOSrunOauth({ taskClass: "cheap_routing", prompt: "hello", humanVisible: true, responseMode: "json" });
  assert.equal(result.resolvedProviderOrTool, "openai");
  assert.equal(result.fallbackIndex, 1);
  assert.deepEqual(result.json, { ok: true });
});

test("local registration is off by default and tools, media, unbounded input and pins are excluded", (t) => {
  fixture(t);
  const base = { taskClass: "cheap_routing", prompt: "hello" };
  assert.equal(localCandidate(base, {}), null);
  assert.ok(localCandidate(base));
  for (const patch of [
    { taskClass: "default_automation" }, { tools: [] }, { audio: {} }, { searchGrounding: true },
    { prompt: "x".repeat(16001) }, { maxOutputTokens: 513 }, { maxOutputTokens: -1 },
    { provider: "openai" }, { pinnedProvider: "openai" }, { model: "gpt-test" }, { profile: "cheap_routing" },
    { messages: [{ role: "user", content: [{ type: "image_url" }] }] },
    { messages: [{ role: "tool", content: "result" }] }, { responseMode: "xml" },
  ]) assert.equal(localCandidate({ ...base, ...patch }), null, JSON.stringify(patch));
});

test("registration refuses external endpoints and cache validation refuses escapes or missing shards", (t) => {
  const { config, configPath, snapshotPath, root } = fixture(t);
  fs.writeFileSync(configPath, JSON.stringify({ ...config, baseUrl: "https://example.com" }));
  assert.equal(localCandidate({ taskClass: "cheap_routing", prompt: "hello" }), null);
  assert.throws(() => requireOfflineSnapshot({ ...config, cacheRoot: snapshotPath }), /outside/);
  fs.writeFileSync(path.join(snapshotPath, "model.safetensors.index.json"), JSON.stringify({ weight_map: { one: "missing.safetensors" } }));
  assert.throws(() => requireOfflineSnapshot(config), /ENOENT/);
  fs.writeFileSync(path.join(snapshotPath, "model.safetensors.index.json"), JSON.stringify({ weight_map: { one: "../escape.safetensors" } }));
  assert.throws(() => requireOfflineSnapshot(config), /unsafe/);
  fs.unlinkSync(path.join(snapshotPath, "model.safetensors.index.json"));
  fs.writeFileSync(config.plistPath, "<plist/>");
  assert.throws(() => requireOfflineSnapshot(config), /offline/);
});

test("a cold connection reuses existing loader and bridge JSON transport with a fresh request", async (t) => {
  const { runtimeModule, root } = fixture(t);
  const trace = path.join(root, "trace.json");
  fs.writeFileSync(runtimeModule, `module.exports = {
    ensureLocalMlxServer: async (url) => { require('fs').writeFileSync(${JSON.stringify(trace)}, JSON.stringify({url})); return true; }
  };`);
  let calls = 0;
  global.fetch = async (_url, options) => {
    if (++calls === 1) throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
    const payload = JSON.parse(options.body);
    assert.equal(payload.chat_template_kwargs.enable_thinking, false);
    assert.deepEqual(payload.response_format, { type: "json_object" });
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ max: payload.max_tokens }) } }] }) };
  };
  const result = await myOSrunOauth({ taskClass: "cheap_routing", prompt: "hello", humanVisible: true, responseMode: "json", allowLocalColdStart: true, timeoutMs: 90000 });
  assert.deepEqual(result.json, { max: 512 });
  assert.deepEqual(JSON.parse(fs.readFileSync(trace)), { url: "http://127.0.0.1:8891" });
});

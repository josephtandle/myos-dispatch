"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { readLocalRegistration, requireOfflineSnapshot } = require("./local-provider");
const { readCodexInventory } = require("./oauth-codex-inventory");

function metadataEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/(KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL|BASE_URL|ENDPOINT)/i.test(key) && !/^ANTHROPIC_|^CLAUDE_CODE_USE_|^GOOGLE_GENAI_USE_/.test(key)));
}

function runMetadata(command, args, { env, cwd, timeoutMs = 8000 }) {
  return new Promise(resolve => {
    execFile(command, args, { env: metadataEnv(env), cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

async function discoverInventory(options = {}) {
  const env = options.env || process.env;
  const now = new Date().toISOString();
  const run = options.run || ((command, args) => runMetadata(command, args, { env, cwd: options.cwd || os.homedir(), timeoutMs: options.timeoutMs }));
  let cache = options.cache || readJson(path.join(env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex"), "models_cache.json"));
  const [codex, claude, claudeHelp, agy, ollama, liveModels] = await Promise.all([
    run("codex", ["login", "status"]), run("claude", ["auth", "status", "--json"]),
    run("claude", ["--help"]), run("agy", ["models"]), run("ollama", ["list"]),
    Array.isArray(options.codexInventory) ? options.codexInventory : options.run ? null :
      readCodexInventory({ env: metadataEnv(env), cwd: options.cwd, timeoutMs: options.timeoutMs }),
  ]);
  if (Array.isArray(liveModels)) cache = { fetched_at: now, models: liveModels.map(model => ({
    slug: model.model || model.id, visibility: model.hidden ? "hide" : "list",
    supported_reasoning_levels: (model.supportedReasoningEfforts || []).map(level => ({ effort: level.reasoningEffort })),
  })) };
  const codexAuth = codex.ok && /Logged in using ChatGPT/i.test(codex.stdout + (codex.stderr || "")) ? "subscription" : "unavailable";
  let claudeAuth = "unavailable";
  try {
    const status = JSON.parse(claude.stdout);
    if (claude.ok && status.loggedIn === true && status.authMethod === "claude.ai") claudeAuth = "subscription";
  } catch { /* No credential inference from an invalid status response. */ }
  const models = (cache?.models || []).filter(m => typeof m.slug === "string").map(m => ({
    provider: "codex", model: m.slug, visible: m.visibility === "list", auth: codexAuth,
    source: Array.isArray(liveModels) ? "codex-app-server" : "codex-model-cache", observedAt: cache.fetched_at,
    efforts: (m.supported_reasoning_levels || []).map(level => level.effort),
  }));
  // CLI help documents aliases, not account entitlement or an exhaustive model list.
  const modelHelp = claudeHelp.stdout.match(/--model <model>([\s\S]*?)(?=\n\s*--|$)/)?.[1] || "";
  for (const model of ["fable", "opus", "sonnet", "haiku"].filter(alias => new RegExp(`\\b${alias}\\b`).test(modelHelp))) {
    models.push({ provider: "claude", model, visible: true, auth: claudeAuth, source: "cli-help-alias", observedAt: now, alias: true });
  }
  if (agy.ok) for (const line of agy.stdout.split(/\r?\n/)) {
    const model = line.match(/^([a-z0-9][a-z0-9._-]+)\t/)?.[1];
    if (model) models.push({ provider: "antigravity", model, visible: true, auth: "unknown", source: "agy-models", observedAt: now });
  }
  if (ollama.ok) for (const line of ollama.stdout.split(/\r?\n/).slice(1)) {
    const model = line.trim().split(/\s+/)[0];
    if (model) models.push({ provider: "ollama", model, visible: true, auth: "local", source: "ollama-list", observedAt: now });
  }
  const local = options.localRegistration || readLocalRegistration({ MYOS_PUBLIC_LOCAL_PROVIDER_CONFIG:
    env.MYOS_OAUTH_LOCAL_PROVIDER_CONFIG || path.join(env.HOME || os.homedir(), ".myos-dispatch", "oauth-local-provider.json") });
  let offlineReady = false;
  if (local) {
    try { (options.validateSnapshot || requireOfflineSnapshot)(local); offlineReady = true; } catch { /* Registered but incomplete. */ }
    models.push({ provider: "local", model: local.model, visible: true, auth: "local", offlineReady, source: "host-offline-registration", observedAt: now });
  }
  return { models, providers: [
    { provider: "codex", auth: codexAuth, discovered: Boolean(cache?.models), completeInventory: Array.isArray(cache?.models) && Number.isFinite(Date.parse(cache.fetched_at)), observedAt: now },
    { provider: "claude", auth: claudeAuth, discovered: claudeHelp.ok, observedAt: now },
    { provider: "antigravity", auth: "unknown", discovered: agy.ok, completeInventory: agy.ok && models.some(model => model.provider === "antigravity"), observedAt: now },
    { provider: "ollama", auth: "local", discovered: ollama.ok, observedAt: now },
    { provider: "local", auth: "local", discovered: Boolean(local), offlineReady, observedAt: now },
  ] };
}
module.exports = { discoverInventory };

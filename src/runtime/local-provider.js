"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MODEL = "mlx-community/Qwen3.5-35B-A3B-4bit";
const MAX_INPUT_CHARS = 16000;
const MAX_OUTPUT_TOKENS = 512;

function eligibleLocalInput(options) {
  // No intent has been approved for local substitution in the initial rollout.
  if (options.intent) return false;
  if (options.taskClass !== "cheap_routing" || options.tools || options.toolChoice || options.audio || options.images || options.video || options.attachments || options.searchGrounding || options.model || options.profile || options.provider || options.providerPreference || options.pinnedProvider) return false;
  if (options.responseMode && !["text", "json"].includes(options.responseMode)) return false;
  if (options.maxOutputTokens != null && (!Number.isInteger(options.maxOutputTokens) || options.maxOutputTokens < 1 || options.maxOutputTokens > MAX_OUTPUT_TOKENS)) return false;
  const messages = options.messages;
  if (messages != null && (!Array.isArray(messages) || messages.some((message) => !message || !["system", "user", "assistant"].includes(message.role) || typeof message.content !== "string" || message.tool_calls || message.tool_call_id))) return false;
  if ([options.prompt, options.systemPrompt].some((value) => value != null && typeof value !== "string")) return false;
  const text = [options.prompt || "", options.systemPrompt || "", ...(messages || []).map((message) => message.content)].join("\n");
  return text.trim().length > 0 && text.length <= MAX_INPUT_CHARS;
}

function readLocalRegistration(env = process.env) {
  const file = env.MYOS_PUBLIC_LOCAL_PROVIDER_CONFIG;
  if (!file) return null;
  try {
    if (!path.isAbsolute(file)) return null;
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    if (config.enabled !== true || config.model !== MODEL) return null;
    for (const key of ["runtimeModule", "cacheRoot", "snapshotPath", "plistPath"]) {
      if (typeof config[key] !== "string" || !path.isAbsolute(config[key])) return null;
    }
    const baseUrl = config.baseUrl || "http://127.0.0.1:8891";
    const url = new URL(baseUrl);
    // The reused host loader owns this specific service, not arbitrary endpoints.
    if (url.origin !== "http://127.0.0.1:8891" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    return { ...config, baseUrl: url.origin };
  } catch {
    return null;
  }
}

function localCandidate(options, env = process.env) {
  if (!eligibleLocalInput(options)) return null;
  const registration = readLocalRegistration(env);
  return registration ? { type: "llm", provider: "local", model: MODEL, profile: "local_default", transportAuthMode: "none", registration } : null;
}

function requireOfflineSnapshot(config) {
  const root = fs.realpathSync(config.cacheRoot);
  const snapshot = fs.realpathSync(config.snapshotPath);
  if (!snapshot.startsWith(`${root}${path.sep}`)) throw new Error("local model snapshot is outside the registered cache");
  const requireFile = (name) => {
    if (path.isAbsolute(name) || name.split(/[\\/]/).includes("..")) throw new Error("unsafe cached model filename");
    const resolved = fs.realpathSync(path.join(snapshot, name));
    if (!resolved.startsWith(`${root}${path.sep}`) || !fs.statSync(resolved).isFile() || fs.statSync(resolved).size === 0) throw new Error(`missing cached model file: ${name}`);
    return resolved;
  };
  JSON.parse(fs.readFileSync(requireFile("config.json"), "utf8"));
  JSON.parse(fs.readFileSync(requireFile("tokenizer.json"), "utf8"));
  const index = path.join(snapshot, "model.safetensors.index.json");
  if (fs.existsSync(index)) {
    const mapping = JSON.parse(fs.readFileSync(requireFile("model.safetensors.index.json"), "utf8")).weight_map;
    if (!mapping || typeof mapping !== "object" || !Object.keys(mapping).length) throw new Error("missing cached model weight map");
    for (const shard of new Set(Object.values(mapping))) {
      if (typeof shard !== "string" || !shard.endsWith(".safetensors")) throw new Error("invalid cached model shard");
      requireFile(shard);
    }
  } else {
    requireFile("model.safetensors");
  }
  const plist = fs.readFileSync(config.plistPath, "utf8");
  if (!/<key>HF_HUB_OFFLINE<\/key>\s*<string>1<\/string>/.test(plist)) throw new Error("host model loader must be configured offline");
}

async function localRequest(baseUrl, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model, messages: options.messages,
        max_tokens: options.maxOutputTokens, temperature: options.temperature,
        chat_template_kwargs: { enable_thinking: false },
        response_format: options.responseMode === "json" ? { type: "json_object" } : undefined,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Local model HTTP ${response.status}`);
    const raw = await response.json();
    const content = raw?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("Local model returned empty text");
    const text = options.responseMode === "json"
      ? content.replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()
      : content;
    if (!text.trim()) throw new Error("Local model returned empty text");
    if (options.responseMode === "json") JSON.parse(text);
    return { text, raw, usage: { inputTokens: raw?.usage?.prompt_tokens || 0, outputTokens: raw?.usage?.completion_tokens || 0 } };
  } catch (error) {
    // Only an actual refused socket justifies starting the existing service.
    // Redirect failures, HTTP errors and timeouts must cascade without a restart.
    if (error?.cause?.code === "ECONNREFUSED" || error?.code === "ECONNREFUSED") {
      error.provider = "local";
      error.responseStatus = 0;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function executeLocalCandidate(candidate, options, messages) {
  try {
    if (!eligibleLocalInput(options)) throw new Error("local input is not eligible");
    const config = candidate.registration;
    requireOfflineSnapshot(config);
    // Reuse the host lifecycle; own the POST so prompts cannot follow redirects.
    const runtime = require(config.runtimeModule);
    if (typeof runtime.ensureLocalMlxServer !== "function") throw new Error("host runtime lacks the local model loader");
    const request = () => localRequest(config.baseUrl, {
      model: config.model, messages, timeoutMs: options.timeoutMs || 30000,
      maxOutputTokens: options.maxOutputTokens || MAX_OUTPUT_TOKENS,
      responseMode: options.responseMode || "text", temperature: options.temperature,
    });
    let result;
    try {
      result = await request();
    } catch (error) {
      if (error?.provider !== "local" || error?.responseStatus !== 0 || options.allowColdStart === false) throw error;
      if (!(await runtime.ensureLocalMlxServer(config.baseUrl))) throw error;
      result = await request();
    }
    const json = options.responseMode === "json" ? JSON.parse(result.text) : null;
    return { ...result, json, model: config.model, provider: "local", estimatedCostUsd: 0, transportAuthMode: "none", billingMode: "local" };
  } catch (cause) {
    const error = new Error(`Local provider unavailable: ${cause.message}`, { cause });
    error.provider = "local";
    error.retryable = true;
    error.code = "LOCAL_UNAVAILABLE";
    throw error;
  }
}

module.exports = { localCandidate, eligibleLocalInput, readLocalRegistration, requireOfflineSnapshot, executeLocalCandidate };

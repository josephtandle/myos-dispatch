const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  loadCatalog,
  normalizeProvider: normalizeCatalogProvider,
  resolveProfileModel,
} = require("../model-catalog");
const {
  CANONICAL_TASK_CLASSES,
  deriveComplianceLane,
  executeDeterministicCandidate,
  isCanonicalTaskClass,
  normalizeComplianceLane,
  normalizeTaskClass,
  resolveExecutionPlan,
  validateExecutionCandidate,
} = require("../myos-routing");
const {
  normalizeAuthMode,
  readLaneState,
} = require("../myos-lane");
const { maybeNotifyProviderIssue } = require("./provider-alerts");
const { appendUsageEvent, summarizeUsage } = require("./myos-usage-ledger");
const { resolveWorkspacePath, workspaceEnvPath } = require("../myos-compat");
const { inferGoalScale } = require("../goal-scale");
const { isSensitiveEnvKey, resolveSecretValue } = require("./runtime-secrets");

const WORKSPACE_ENV_PATH = workspaceEnvPath();
let workspaceEnvLoaded = false;
let spendSummaryCache = null;

function isUnattendedInitiator(env = process.env) {
  // Kill-switch: MYOS_INITIATOR_OAUTH_DISABLED=1 disables OAuth routing and
  // forces every legacy helper back to the API lane (today's pre-rollout
  // behavior). Positive sense: "1" = OAuth off. Set in shell or plist when
  // the new routing misbehaves and a rollback is needed without a code revert.
  if (String(env.MYOS_INITIATOR_OAUTH_DISABLED || "") === "1") return true;
  return String(env.MYOS_INITIATOR || "").trim().toLowerCase() === "unattended";
}
const DEFAULT_SPEND_POLICY = Object.freeze({
  killSwitch: false,
  premiumModels: ["gpt-5.5"],
  premiumFallbackModel: "gpt-5.4",
  premiumAllowlist: {
    agents: [],
    projects: [],
    authLabels: [],
    surfaces: [],
  },
  reserveUsdByTaskClass: {
    default_automation: 0.1,
    heavy_synthesis: 0.5,
    task_class_is_elite: 0.5,
    cheap_routing: 0.05,
    planning: 0.15,
  },
  dailyCapsUsd: {
    global: null,
    byAgent: {},
    byProject: {},
    byAuthLabel: {},
  },
  summaryCacheMs: 5000,
});

let codexExecRunner = defaultCodexExecRunner;

function ensureWorkspaceEnvLoaded() {
  if (workspaceEnvLoaded) return;
  workspaceEnvLoaded = true;

  try {
    const raw = fs.readFileSync(WORKSPACE_ENV_PATH, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;

      const key = trimmed.slice(0, idx).trim();
      if (!key || process.env[key]) continue;

      const value = trimmed
        .slice(idx + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");

      if (isSensitiveEnvKey(key)) continue;

      process.env[key] = value;
    }
  } catch {
    // Best-effort only. Callers still get explicit missing-key errors later.
  }
}

function normalizeProvider(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";

  if (normalized === "claude" || normalized === "local-claude") {
    return "openai";
  }
  if (normalized === "codex" || normalized === "local-codex") return "openai";
  if (normalized === "gemini") return "google";
  if (normalized === "openai" || normalized === "openrouter" || normalized === "google") {
    return normalized;
  }

  return normalized;
}

function enforceInteractiveOauthHumanVisibility({ complianceLane, humanVisible } = {}) {
  if (complianceLane !== "interactive_oauth") return;
  if (humanVisible === true) return;

  throw new Error(
    "MyOS interactive_oauth requires humanVisible=true; OAuth/browser-session auth is only allowed for foreground, human-visible tasks."
  );
}

function resolveProvider() {
  const laneState = readLaneState();
  return normalizeProvider(
    process.env.MYOS_LLM_PROVIDER ||
      process.env.MYOS_API_PROVIDER ||
      process.env.MYOS_INTERNAL_AUTOMATION_PROVIDER ||
      process.env.OPENCLAW_LLM_PROVIDER ||
      laneState.apiProvider ||
      "openai"
  );
}

function resolveAuthMode(value) {
  const laneState = readLaneState();
  return normalizeAuthMode(process.env.MYOS_AUTH_MODE || value || laneState.authMode || "api");
}

function resolveProfileId(profile, taskClass = "default_automation") {
  if (profile) return profile;
  const normalizedTaskClass = normalizeTaskClass(taskClass);
  return (
    process.env.MYOS_MODEL_PROFILE_DEFAULT ||
    normalizedTaskClass ||
    "default_automation"
  );
}

function normalizeExecutionPolicy(policy = "internal_automation") {
  const normalized = String(policy || "").trim().toLowerCase();
  if (!normalized) return "internal_automation";
  if (normalized === "human_only") return "interactive_session";
  if (normalized === "user_internal") return "internal_automation";
  if (normalized === "all_sorted_core") return "product_runtime";
  return normalized;
}

function enforceProviderAgnosticCallOptions(options = {}) {
  if (!options || !options.providerAgnostic) return;

  const forbidden = [];
  if (options.provider != null) forbidden.push("provider");
  if (options.providerPreference != null) forbidden.push("providerPreference");
  if (options.pinnedProvider != null) forbidden.push("pinnedProvider");
  if (options.model != null) forbidden.push("model");

  if (forbidden.length > 0) {
    throw new Error(
      `MyOS provider-agnostic callsites cannot override ${forbidden.join(", ")}; ` +
      "use taskClass and optional provider-agnostic profile/category only."
    );
  }
}

function resolveProviderForPolicy({ executionPolicy, pinnedProvider, providerPreference } = {}) {
  const normalizedPolicy = normalizeExecutionPolicy(executionPolicy);
  const normalizedPinned = normalizeProvider(pinnedProvider);
  const normalizedPreferred = normalizeProvider(providerPreference);

  if (normalizedPolicy === "product_runtime") {
    if (!normalizedPinned) {
      throw new Error("product_runtime requires a pinned provider");
    }
    return { provider: normalizedPinned, pinned: true };
  }

  if (normalizedPolicy === "interactive_session") {
    return {
      provider: normalizedPinned || normalizedPreferred || resolveProvider() || "openai",
      pinned: Boolean(normalizedPinned),
    };
  }

  return {
    provider: normalizedPinned || normalizedPreferred || resolveProvider() || "openai",
    pinned: Boolean(normalizedPinned),
  };
}

function estimateCostUsd(modelMeta, usage) {
  const pricing = modelMeta?.pricing_per_1m_tokens;
  if (!pricing) return null;

  const inputTokens = Number(usage?.inputTokens || 0);
  const outputTokens = Number(usage?.outputTokens || 0);
  const inputUsd = (inputTokens / 1_000_000) * Number(pricing.input_usd || 0);
  const outputUsd = (outputTokens / 1_000_000) * Number(pricing.output_usd || 0);

  return Number((inputUsd + outputUsd).toFixed(6));
}

function buildMessages({ prompt, systemPrompt, messages }) {
  if (Array.isArray(messages) && messages.length > 0) return messages;

  const built = [];
  if (systemPrompt) {
    built.push({ role: "system", content: String(systemPrompt) });
  }
  built.push({ role: "user", content: String(prompt || "") });
  return built;
}

function extractTextContent(content) {
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item.text === "string") return item.text;
        return "";
      })
      .join("");
  }
  return typeof content === "string" ? content : "";
}

async function callOpenAI({
  apiKey,
  model,
  messages,
  timeoutMs,
  maxOutputTokens,
  responseMode,
  temperature,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        max_completion_tokens: maxOutputTokens,
        temperature,
        response_format: responseMode === "json" ? { type: "json_object" } : undefined,
      }),
      signal: controller.signal,
    });

    const json = await parseJsonResponse("openai", response, {
      retryableStatuses: [408, 409, 429, 500, 502, 503, 504],
      invalidJsonReason: "non_json_response",
      invalidJsonRetryable: true,
    });
    if (!response.ok) {
      throw buildProviderError(
        "openai",
        response.status,
        json?.error?.message || `OpenAI request failed (${response.status})`,
        { code: json?.error?.code, retryable: [408, 409, 429, 500, 502, 503, 504].includes(response.status) }
      );
    }

    return {
      text: extractTextContent(json?.choices?.[0]?.message?.content),
      raw: json,
      usage: {
        inputTokens: json?.usage?.prompt_tokens || 0,
        outputTokens: json?.usage?.completion_tokens || 0,
      },
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw buildProviderError("openai", 408, `OpenAI request timed out after ${timeoutMs}ms`, {
        code: "ETIMEDOUT",
        retryable: true,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isGpt55OauthAllowed(options = {}) {
  return (
    options.authMode === "oauth" &&
    options.complianceLane === "interactive_oauth" &&
    normalizeTaskClass(options.taskClass) === "planning" &&
    String(options.intent || "").trim() === "planning_evaluation" &&
    options.humanVisible === true
  );
}

function resolveCodexOauthModel(model, options = {}) {
  const normalized = String(model || "").trim().toLowerCase();
  if (!normalized) return "gpt-5.4-mini";
  if (normalized.includes("5.5")) return options.allowGpt55 ? "gpt-5.5" : "gpt-5.4";
  if (normalized.includes("mini") || normalized.includes("nano")) return "gpt-5.4-mini";
  if (normalized.includes("o3") || normalized.includes("o4")) return "o3";
  return "gpt-5.4";
}

function buildCodexExecPrompt(messages = [], responseMode = "text") {
  const prompt = messages
    .map((message) => {
      const content = extractTextContent(message.content);
      if (message.role === "system") return `System: ${content}`;
      if (message.role === "user") return `User: ${content}`;
      if (message.role === "assistant") return `Assistant: ${content}`;
      return `${message.role}: ${content}`;
    })
    .join("\n\n");

  if (responseMode !== "json") return prompt;
  return (
    `${prompt}\n\n` +
    "IMPORTANT: Respond with ONLY valid JSON. No markdown, no explanation, no code fences. Raw JSON only."
  );
}

function resolveCodexCommand(env = process.env) {
  const candidates = [
    env.MYOS_CODEX_COMMAND,
    env.CODEX_COMMAND,
    resolveWorkspacePath("bin", "codex"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const command = String(candidate).trim();
    if (!command) continue;
    if (command.includes(path.sep) && fs.existsSync(command)) return command;
  }

  return "codex";
}

function defaultCodexExecRunner({ prompt, model, timeoutMs, allowGpt55 }) {
  const outFile = path.join(
    os.tmpdir(),
    `myos-codex-oauth-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  );
  const codexModel = resolveCodexOauthModel(model, { allowGpt55 });

  try {
    execFileSync(
      resolveCodexCommand(),
      ["exec", "-m", codexModel, "--skip-git-repo-check", "-o", outFile, "-"],
      {
        cwd: os.homedir(),
        input: prompt,
        encoding: "utf8",
        timeout: Number(timeoutMs || 180000) + 2000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    return fs.readFileSync(outFile, "utf8").trim();
  } finally {
    try {
      fs.unlinkSync(outFile);
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function setCodexExecRunnerForTest(runner) {
  codexExecRunner = typeof runner === "function" ? runner : defaultCodexExecRunner;
}

function resetCodexExecRunnerForTest() {
  codexExecRunner = defaultCodexExecRunner;
}

async function callOpenAIViaCodexOauth({
  model,
  messages,
  timeoutMs,
  responseMode,
  allowGpt55,
}) {
  const text = codexExecRunner({
    prompt: buildCodexExecPrompt(messages, responseMode),
    model,
    timeoutMs,
    allowGpt55,
  });

  return {
    text,
    raw: { provider: "codex-oauth", model: resolveCodexOauthModel(model, { allowGpt55 }) },
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

async function callOpenAITranscription({
  apiKey,
  model,
  audio,
  timeoutMs,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const boundary = `----MyOSAudioBoundary${Date.now().toString(36)}`;
    const filename = audio.filename || "audio.bin";
    const mimeType = audio.mimeType || "application/octet-stream";
    const parts = [];

    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
    );
    parts.push(Buffer.isBuffer(audio.buffer) ? audio.buffer : Buffer.from(audio.buffer));
    parts.push("\r\n");
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `${model}\r\n`
    );
    if (audio.prompt) {
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="prompt"\r\n\r\n` +
        `${audio.prompt}\r\n`
      );
    }
    parts.push(`--${boundary}--\r\n`);

    const body = Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part) : part)));

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: controller.signal,
    });

    const json = await response.json();
    if (!response.ok) {
      throw buildProviderError(
        "openai",
        response.status,
        json?.error?.message || `OpenAI transcription request failed (${response.status})`,
        { code: json?.error?.code, retryable: [408, 409, 429, 500, 502, 503, 504].includes(response.status) }
      );
    }

    return {
      text: String(json?.text || "").trim(),
      raw: json,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
      },
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw buildProviderError("openai", 408, `OpenAI transcription request timed out after ${timeoutMs}ms`, {
        code: "ETIMEDOUT",
        retryable: true,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenRouter({
  apiKey,
  model,
  messages,
  timeoutMs,
  maxOutputTokens,
  responseMode,
  temperature,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxOutputTokens,
        temperature,
        response_format: responseMode === "json" ? { type: "json_object" } : undefined,
      }),
      signal: controller.signal,
    });

    const json = await response.json();
    if (!response.ok) {
      throw buildProviderError(
        "openrouter",
        response.status,
        json?.error?.message || `OpenRouter request failed (${response.status})`,
        { code: json?.error?.code, retryable: [408, 409, 429, 500, 502, 503, 504].includes(response.status) }
      );
    }

    return {
      text: extractTextContent(json?.choices?.[0]?.message?.content),
      raw: json,
      usage: {
        inputTokens: json?.usage?.prompt_tokens || 0,
        outputTokens: json?.usage?.completion_tokens || 0,
      },
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw buildProviderError("openrouter", 408, `OpenRouter request timed out after ${timeoutMs}ms`, {
        code: "ETIMEDOUT",
        retryable: true,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function callGoogle({
  apiKey,
  model,
  messages,
  timeoutMs,
  maxOutputTokens,
  temperature,
  searchGrounding,
  tools,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Separate system instruction from user/model messages
  const systemParts = messages
    .filter((m) => m.role === "system")
    .map((m) => ({ text: extractTextContent(m.content) }));

  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: extractTextContent(m.content) }],
    }));

  const body = {
    contents,
    generationConfig: {
      maxOutputTokens,
      ...(temperature != null ? { temperature } : {}),
    },
  };

  if (systemParts.length > 0) {
    body.systemInstruction = { parts: systemParts };
  }

  // Search grounding: pass tools with google_search to get live web-grounded responses.
  // Only supported on gemini-2.5-* models. Adds groundingMetadata to the response.
  // IMPORTANT: Must set thinkingBudget: 0 when using search grounding. With thinking enabled
  // (the gemini-2.5 default), search grounding returns empty content.parts. Disabling thinking
  // resolves this. If you need thinking + live data, use two calls: grounding first, then thinking.
  if (searchGrounding) {
    body.tools = [{ google_search: {} }];
    body.generationConfig = {
      ...body.generationConfig,
      thinkingConfig: { thinkingBudget: 0 },
    };
  } else if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const json = await response.json();
    if (!response.ok) {
      const msg = json?.error?.message || `Google Gemini request failed (${response.status})`;
      throw buildProviderError("google", response.status, msg, {
        code: json?.error?.status || json?.error?.code,
        retryable: [408, 409, 429, 500, 502, 503, 504].includes(response.status),
      });
    }

    const text = (json?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("");

    // Extract grounding metadata when search grounding was used
    const groundingMeta = json?.candidates?.[0]?.groundingMetadata;
    const groundingSources = groundingMeta
      ? (groundingMeta.groundingChunks || [])
          .map((chunk) => chunk?.web?.uri)
          .filter(Boolean)
      : [];
    const searchQueries = groundingMeta
      ? (groundingMeta.webSearchQueries || [])
      : [];

    return {
      text,
      raw: json,
      usage: {
        inputTokens: json?.usageMetadata?.promptTokenCount || 0,
        outputTokens: json?.usageMetadata?.candidatesTokenCount || 0,
      },
      groundingSources,
      searchQueries,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw buildProviderError("google", 408, `Google Gemini request timed out after ${timeoutMs}ms`, {
        code: "ETIMEDOUT",
        retryable: true,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function resolveModelForProvider(provider, profile, explicitModel) {
  const normalizedProvider = normalizeCatalogProvider(provider);
  const catalog = loadCatalog(normalizedProvider);

  if (explicitModel) {
    const explicit = catalog.models.find(
      (entry) => entry.id === explicitModel || entry.model === explicitModel
    );
    if (explicit) {
      return { model: explicit.model, meta: explicit, catalog };
    }
    return { model: explicitModel, meta: null, catalog };
  }

  const resolved = resolveProfileModel(catalog, resolveProfileId(profile));
  return { model: resolved.model.model, meta: resolved.model, catalog };
}

const CODEX_AUTH_PATH = path.join(
  process.env.HOME || os.homedir(),
  ".codex",
  "auth.json"
);

function getCodexAuthPath() {
  return process.env.MYOS_CODEX_AUTH_PATH || CODEX_AUTH_PATH;
}

function readCodexOAuthToken() {
  const authPath = getCodexAuthPath();
  try {
    const raw = fs.readFileSync(authPath, "utf8");
    const parsed = JSON.parse(raw);
    const token = parsed?.tokens?.access_token;
    if (!token) throw new Error(`No access_token found in ${authPath}`);
    return token;
  } catch (err) {
    throw new Error(`Failed to read Codex OAuth token from ${authPath}: ${err.message}`);
  }
}

function resolveOpenAICredential(authMode) {
  if (authMode === "oauth") {
    return readCodexOAuthToken();
  }
  ensureWorkspaceEnvLoaded();
  return resolveSecretValue({
    envKeys: ["OPENAI_API_KEY"],
    workspaceEnvKeys: ["OPENAI_API_KEY"],
  });
}

function resolveProviderApiKey(provider) {
  ensureWorkspaceEnvLoaded();

  if (provider === "openai") {
    return resolveSecretValue({
      envKeys: ["OPENAI_API_KEY"],
      workspaceEnvKeys: ["OPENAI_API_KEY"],
    });
  }
  if (provider === "openrouter") {
    return resolveSecretValue({
      envKeys: ["OPENROUTER_API_KEY"],
      workspaceEnvKeys: ["OPENROUTER_API_KEY"],
    });
  }
  if (provider === "google") {
    return (
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_AI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      resolveSecretValue({
        workspaceEnvKeys: ["GEMINI_API_KEY", "GOOGLE_AI_API_KEY", "GOOGLE_API_KEY"],
      }) ||
      ""
    );
  }
  return "";
}

function resolveSpendPolicyPath() {
  return (
    process.env.MYOS_SPEND_POLICY_PATH ||
    path.join(
      path.dirname(WORKSPACE_ENV_PATH),
      "agents",
      "shared",
      "data",
      "myos-spend-policy.json"
    )
  );
}

function mergeSpendPolicy(base, override) {
  const incoming = override && typeof override === "object" ? override : {};
  return {
    ...base,
    ...incoming,
    premiumModels: Array.isArray(incoming.premiumModels)
      ? incoming.premiumModels
      : base.premiumModels,
    premiumAllowlist: {
      ...base.premiumAllowlist,
      ...(incoming.premiumAllowlist || {}),
    },
    reserveUsdByTaskClass: {
      ...base.reserveUsdByTaskClass,
      ...(incoming.reserveUsdByTaskClass || {}),
    },
    dailyCapsUsd: {
      ...base.dailyCapsUsd,
      ...(incoming.dailyCapsUsd || {}),
      byAgent: {
        ...base.dailyCapsUsd.byAgent,
        ...((incoming.dailyCapsUsd && incoming.dailyCapsUsd.byAgent) || {}),
      },
      byProject: {
        ...base.dailyCapsUsd.byProject,
        ...((incoming.dailyCapsUsd && incoming.dailyCapsUsd.byProject) || {}),
      },
      byAuthLabel: {
        ...base.dailyCapsUsd.byAuthLabel,
        ...((incoming.dailyCapsUsd && incoming.dailyCapsUsd.byAuthLabel) || {}),
      },
    },
  };
}

function loadSpendPolicy() {
  const policyPath = resolveSpendPolicyPath();
  try {
    const raw = fs.readFileSync(policyPath, "utf8");
    return mergeSpendPolicy(DEFAULT_SPEND_POLICY, JSON.parse(raw));
  } catch {
    return DEFAULT_SPEND_POLICY;
  }
}

function isPremiumModel(model, policy) {
  return (policy?.premiumModels || []).includes(String(model || "").trim());
}

function isAllowlisted(policy, caller, authLabel) {
  const allowlist = policy?.premiumAllowlist || {};
  return (
    (allowlist.agents || []).includes(caller.agentId) ||
    (allowlist.projects || []).includes(caller.project) ||
    (allowlist.authLabels || []).includes(authLabel) ||
    (allowlist.surfaces || []).includes(caller.surface)
  );
}

function isOauthPremiumAllowed({ candidate, authMode }) {
  if (String(authMode || "").trim().toLowerCase() !== "oauth") return false;
  if (candidate?.type !== "llm") return false;
  if (String(candidate.provider || "").trim().toLowerCase() !== "openai") return false;
  return String(process.env.MYOS_ALLOW_OAUTH_PREMIUM || "").trim() === "1";
}

function isPlanningEvaluationOauthPremiumAllowed({ candidate, authMode, options, taskClass, complianceLane } = {}) {
  if (candidate?.type !== "llm") return false;
  if (String(candidate.provider || "").trim().toLowerCase() !== "openai") return false;
  return isGpt55OauthAllowed({
    authMode,
    complianceLane,
    taskClass,
    intent: options.intent,
    humanVisible: options.humanVisible,
  });
}

function readSpendSummaryCached(policy) {
  const ttlMs = Number(policy?.summaryCacheMs || DEFAULT_SPEND_POLICY.summaryCacheMs || 5000);
  const now = Date.now();
  if (spendSummaryCache && now - spendSummaryCache.ts < ttlMs) {
    return spendSummaryCache.summary;
  }

  const summary = summarizeUsage({ windowHours: 24 });
  spendSummaryCache = { ts: now, summary };
  return summary;
}

function resolveCandidateModel(candidate, options, taskClass) {
  if (candidate.type !== "llm") {
    return {
      model: candidate.tool,
      provider: candidate.tool,
      profile: null,
    };
  }

  const profile = candidate.profile || resolveProfileId(options.profile, taskClass);
  const resolved = resolveModelForProvider(candidate.provider, profile, candidate.model || options.model);
  return {
    model: resolved.model,
    provider: candidate.provider,
    profile,
  };
}

function resolveSpendReserveUsd({ options, taskClass, policy }) {
  if (options.budgetCapUsd != null && Number.isFinite(Number(options.budgetCapUsd))) {
    return Number(options.budgetCapUsd);
  }
  return Number(policy?.reserveUsdByTaskClass?.[taskClass] || 0);
}

function readBucketCost(bucketMap, key) {
  if (!bucketMap || !key || !bucketMap[key]) return 0;
  return Number(bucketMap[key].costUsd || 0);
}

function enforceDailyCaps({ summary, policy, caller, authLabel, reserveUsd }) {
  const caps = policy?.dailyCapsUsd || {};
  const checks = [
    {
      cap: caps.global,
      current: Number(summary.totalCostUsd || 0),
      label: "global",
    },
    {
      cap: caps.byAgent?.[caller.agentId],
      current: readBucketCost(summary.byAgent, caller.agentId),
      label: `agent ${caller.agentId}`,
    },
    {
      cap: caps.byProject?.[caller.project],
      current: readBucketCost(summary.byProject, caller.project),
      label: `project ${caller.project}`,
    },
    {
      cap: caps.byAuthLabel?.[authLabel],
      current: readBucketCost(summary.byAuthLabel, authLabel),
      label: `auth label ${authLabel}`,
    },
  ];

  for (const check of checks) {
    if (check.cap == null || Number.isNaN(Number(check.cap))) continue;
    if (check.current + reserveUsd > Number(check.cap)) {
      throw new Error(
        `MyOS spend policy blocked call: ${check.label} daily cap would be exceeded ` +
          `($${(check.current + reserveUsd).toFixed(4)} > $${Number(check.cap).toFixed(4)})`
      );
    }
  }
}

function applySpendPolicyToCandidate({ candidate, options, taskClass, complianceLane, caller, authLabel, authMode }) {
  if (candidate.type !== "llm") {
    return {
      candidate,
      spendControlAction: null,
    };
  }

  const policy = loadSpendPolicy();
  if (policy.killSwitch) {
    throw new Error("MyOS spend policy kill switch is active");
  }

  const resolved = resolveCandidateModel(candidate, options, taskClass);
  const reserveUsd = resolveSpendReserveUsd({ options, taskClass, policy });
  const summary = readSpendSummaryCached(policy);
  enforceDailyCaps({ summary, policy, caller, authLabel, reserveUsd });

  if (!isPremiumModel(resolved.model, policy)) {
    return {
      candidate: {
        ...candidate,
        model: resolved.model,
        profile: resolved.profile,
      },
      spendControlAction: null,
    };
  }

  if (isAllowlisted(policy, caller, authLabel)) {
    return {
      candidate: {
        ...candidate,
        model: resolved.model,
        profile: resolved.profile,
      },
      spendControlAction: null,
    };
  }

  if (isPlanningEvaluationOauthPremiumAllowed({ candidate, authMode, options, taskClass, complianceLane })) {
    return {
      candidate: {
        ...candidate,
        model: resolved.model,
        profile: resolved.profile,
      },
      spendControlAction: null,
    };
  }

  if (isOauthPremiumAllowed({ candidate, authMode })) {
    return {
      candidate: {
        ...candidate,
        model: resolved.model,
        profile: resolved.profile,
      },
      spendControlAction: null,
    };
  }

  const fallbackModel = String(policy.premiumFallbackModel || "").trim();
  if (!fallbackModel) {
    throw new Error(`MyOS spend policy blocked premium model ${resolved.model} for ${caller.agentId}`);
  }

  return {
    candidate: {
      ...candidate,
      model: fallbackModel,
      profile: null,
    },
    spendControlAction: `downgraded ${resolved.model} -> ${fallbackModel}`,
  };
}

function sanitizeCallerValue(value, fallback = "unknown") {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function sanitizeOptionalCallerValue(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function inferCallerFromPath(targetPath = "") {
  const segments = String(targetPath || "")
    .split(path.sep)
    .filter(Boolean);

  const agentIndex = segments.lastIndexOf("agents");
  if (agentIndex >= 0 && segments[agentIndex + 1]) {
    return {
      agentId: segments[agentIndex + 1],
      surface: "agent",
      project: segments[agentIndex + 1],
    };
  }

  const appIndex = segments.lastIndexOf("apps");
  if (appIndex >= 0 && segments[appIndex + 1]) {
    return {
      agentId: "unknown",
      surface: "app",
      project: segments[appIndex + 1],
    };
  }

  const projectIndex = segments.lastIndexOf("projects");
  if (projectIndex >= 0 && segments[projectIndex + 1]) {
    const project = segments[projectIndex + 1];
    if (segments[projectIndex + 2] === "mission-control") {
      return {
        agentId: "mission-control",
        surface: "mission-control",
        project: "mission-control",
      };
    }

    return {
      agentId: "unknown",
      surface: "project",
      project,
    };
  }

  return {
    agentId: "unknown",
    surface: "unknown",
    project: "unknown",
  };
}

function inferCallerFromCwd(cwd = process.cwd()) {
  const fromCwd = inferCallerFromPath(cwd);
  if (fromCwd.agentId !== "unknown" || fromCwd.project !== "unknown") {
    return fromCwd;
  }

  return inferCallerFromPath(process.argv[1] || "");
}

function resolveCallerContext(options = {}) {
  const explicitCaller =
    options.caller && typeof options.caller === "object" ? options.caller : {};
  const inferred = inferCallerFromCwd();

  return {
    agentId: sanitizeCallerValue(
      explicitCaller.agentId || options.agentId || process.env.MYOS_AGENT_ID || inferred.agentId
    ),
    surface: sanitizeCallerValue(
      explicitCaller.surface || options.surface || process.env.MYOS_SURFACE || inferred.surface
    ),
    project: sanitizeCallerValue(
      explicitCaller.project || options.project || process.env.MYOS_PROJECT || inferred.project
    ),
    jobId: sanitizeOptionalCallerValue(
      explicitCaller.jobId || options.jobId || process.env.MYOS_JOB_ID
    ),
    runId: sanitizeOptionalCallerValue(
      explicitCaller.runId || options.runId || process.env.MYOS_RUN_ID
    ),
    traceId:
      sanitizeOptionalCallerValue(
        explicitCaller.traceId || options.traceId || process.env.MYOS_TRACE_ID
      ) ||
      (typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    callerVersion: sanitizeOptionalCallerValue(
      explicitCaller.callerVersion ||
        options.callerVersion ||
        process.env.MYOS_CALLER_VERSION
    ),
  };
}

function resolveAuthLabel({ provider, authMode, options = {} } = {}) {
  const explicitCaller =
    options.caller && typeof options.caller === "object" ? options.caller : {};
  const explicitLabel =
    explicitCaller.authLabel || options.authLabel || process.env.MYOS_AUTH_LABEL;
  if (explicitLabel) return sanitizeCallerValue(explicitLabel);

  if (authMode === "oauth" && provider === "openai") {
    return "codex-oauth";
  }
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "google") return "GEMINI_API_KEY";
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  if (provider) return `${provider}:${authMode || "api"}`;
  return "unknown";
}

function extractProviderRequestId(result) {
  return (
    result?.providerRequestId ||
    result?.raw?.id ||
    result?.raw?.response_id ||
    null
  );
}

function enforceBudgetCap(estimatedCostUsd, budgetCapUsd) {
  if (
    budgetCapUsd == null ||
    estimatedCostUsd == null ||
    Number.isNaN(Number(budgetCapUsd)) ||
    estimatedCostUsd <= Number(budgetCapUsd)
  ) {
    return;
  }
  throw new Error(
    `MyOS budget cap exceeded: estimated $${estimatedCostUsd.toFixed(6)} > $${Number(
      budgetCapUsd
    ).toFixed(6)}`
  );
}

function buildProviderError(provider, responseStatus, message, extra = {}) {
  const error = new Error(message);
  error.provider = provider;
  error.responseStatus = responseStatus;
  error.retryable = Boolean(extra.retryable);
  if (extra.code) error.code = extra.code;
  if (extra.reason) error.reason = extra.reason;
  return error;
}

async function parseJsonResponse(provider, response, options = {}) {
  const {
    retryableStatuses = [],
    invalidJsonReason = "invalid_json",
    invalidJsonRetryable = false,
  } = options;

  if (typeof response?.text !== "function") {
    if (typeof response?.json === "function") {
      return response.json();
    }
    throw buildProviderError(provider, response?.status || 0, `${provider} response did not expose text/json`, {
      code: "EINVALIDRESPONSE",
      reason: invalidJsonReason,
      retryable: invalidJsonRetryable || retryableStatuses.includes(response?.status),
    });
  }

  const rawText = await response.text();
  try {
    return rawText ? JSON.parse(rawText) : {};
  } catch (error) {
    const snippet = rawText.replace(/\s+/g, " ").slice(0, 160) || "<empty>";
    throw buildProviderError(
      provider,
      response.status,
      `${provider} returned invalid JSON: ${snippet}`,
      {
        code: "EINVALIDJSON",
        reason: invalidJsonReason,
        retryable: invalidJsonRetryable || retryableStatuses.includes(response.status),
      }
    );
  }
}

function classifyUsageIssue(error) {
  const message = String(error?.message || "").toLowerCase();
  const status = Number(error?.responseStatus || error?.status || 0);
  const code = String(error?.code || "").toLowerCase();
  const reason = String(error?.reason || "").toLowerCase();

  if (
    message.includes("insufficient_quota") ||
    message.includes("credit balance is too low") ||
    message.includes("billing hard limit") ||
    message.includes("purchase credits") ||
    message.includes("quota exceeded")
  ) {
    return "credits";
  }

  if (status === 429 || message.includes("rate limit") || message.includes("too many requests")) {
    return "rate_limit";
  }

  if (
    [500, 502, 503, 504].includes(status) ||
    message.includes("service unavailable") ||
    message.includes("bad gateway") ||
    message.includes("gateway timeout") ||
    message.includes("temporarily unavailable") ||
    message.includes("overloaded") ||
    reason === "non_json_response" ||
    code === "einvalidjson"
  ) {
    return "outage";
  }

  if (status === 408 || code === "etimedout" || message.includes("timed out") || message.includes("timeout")) {
    return "timeout";
  }

  if (message.includes("budget cap exceeded")) {
    return "budget_cap";
  }

  return null;
}

function isRetryableProviderError(error) {
  if (!error) return false;
  if (error.retryable === true) return true;

  const status = Number(error.responseStatus || error.status || 0);
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;

  const code = String(error.code || "").toUpperCase();
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "RESOURCE_EXHAUSTED"].includes(code)) {
    return true;
  }

  const message = String(error.message || "").toLowerCase();
  return [
    "rate limit",
    "too many requests",
    "quota",
    "resource exhausted",
    "temporarily unavailable",
    "overloaded",
    "timed out",
    "timeout",
    "network error",
    "connection reset",
    "connection refused",
    "service unavailable",
    "bad gateway",
    "gateway timeout",
    "fetch failed",
    "upstream error",
  ].some((fragment) => message.includes(fragment));
}

function maybeParseJson(text, responseMode) {
  if (responseMode !== "json") return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `MyOS expected JSON output but received invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function llmCallAsync(options = {}) {
  const provider = normalizeProvider(options.provider || resolveProvider());
  const authMode = options.authMode || "api";
  const timeoutMs = Number(options.timeoutMs || 180000);
  const maxOutputTokens = Number(options.maxOutputTokens || 4000);
  const responseMode = options.responseMode === "json" ? "json" : "text";
  const temperature = options.temperature;
  const messages = buildMessages(options);
  const { model, meta } = resolveModelForProvider(provider, options.profile, options.model);

  let result;
  if (provider === "openai") {
    if (authMode === "oauth" && !options.audio?.buffer) {
      result = await callOpenAIViaCodexOauth({
        model,
        messages,
        timeoutMs,
        responseMode,
        allowGpt55: isGpt55OauthAllowed(options),
      });
    } else {
      const apiKey = resolveOpenAICredential(authMode);
      if (!apiKey) throw new Error("OPENAI_API_KEY is not set and no OAuth token found");
      result = options.audio?.buffer
        ? await callOpenAITranscription({
            apiKey,
            model,
            audio: options.audio,
            timeoutMs,
          })
        : await callOpenAI({
            apiKey,
            model,
            messages,
            timeoutMs,
            maxOutputTokens,
            responseMode,
            temperature,
          });
    }
  } else if (provider === "openrouter") {
    const apiKey = resolveProviderApiKey(provider);
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
    result = await callOpenRouter({
      apiKey,
      model,
      messages,
      timeoutMs,
      maxOutputTokens,
      responseMode,
      temperature,
    });
  } else if (provider === "google") {
    const apiKey = resolveProviderApiKey(provider);
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    result = await callGoogle({
      apiKey,
      model,
      messages,
      timeoutMs,
      maxOutputTokens,
      temperature,
      searchGrounding: options.searchGrounding,
      tools: options.tools,
    });
  } else {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  const estimatedCostUsd = estimateCostUsd(meta, result.usage);
  enforceBudgetCap(estimatedCostUsd, options.budgetCapUsd);
  const json = maybeParseJson(result.text, responseMode);

  const enriched = {
    ...result,
    provider,
    model,
    meta,
    estimatedCostUsd,
    finishReason: result.raw?.stop_reason || result.raw?.choices?.[0]?.finish_reason || "stop",
    json,
    groundingSources: result.groundingSources || [],
    providerRequestId: extractProviderRequestId(result),
    searchQueries: result.searchQueries || [],
  };

  return options.includeMetadata ? enriched : result.text;
}

async function myosRun(options = {}) {
  enforceProviderAgnosticCallOptions(options);
  const executionPolicy = normalizeExecutionPolicy(options.executionPolicy);
  const authMode = resolveAuthMode(options.authMode);
  const rawTaskClass = String(options.taskClass || "default_automation").trim();
  if (options.taskClass && !isCanonicalTaskClass(rawTaskClass)) {
    throw new Error(
      `Unsupported MyOS taskClass: ${rawTaskClass}. Use one of: ${CANONICAL_TASK_CLASSES.join(", ")}`
    );
  }
  const taskClass = normalizeTaskClass(rawTaskClass);
  const intent = options.intent || null;
  const complianceLane = deriveComplianceLane({
    complianceLane: options.complianceLane,
    executionPolicy,
    authMode,
    taskClass,
    audio: options.audio,
  });

  if (executionPolicy === "interactive_session" && complianceLane !== "interactive_oauth") {
    throw new Error(
      `MyOS interactive_session must resolve to compliance_lane=interactive_oauth, got ${complianceLane}`
    );
  }

  if (executionPolicy !== "interactive_session" && complianceLane === "interactive_oauth") {
    throw new Error(
      `MyOS automation cannot run with compliance_lane=${complianceLane}; unattended flows must not use OAuth`
    );
  }

  if (complianceLane !== "interactive_oauth" && authMode !== "api") {
    throw new Error(
      `MyOS automation cannot run with auth_mode=${authMode}; unattended flows must use API auth`
    );
  }

  if (complianceLane === "interactive_oauth" && authMode !== "oauth") {
    throw new Error(
      `MyOS interactive_session requires auth_mode=oauth; human-driven work should use myOSrunOauth`
    );
  }

  enforceInteractiveOauthHumanVisibility({
    complianceLane,
    humanVisible: options.humanVisible,
  });

  const caller = resolveCallerContext(options);

  const plan = resolveExecutionPlan({
    taskClass,
    intent,
    complianceLane,
    executionPolicy,
    authMode,
    audio: options.audio,
    pinnedProvider: options.pinnedProvider,
    providerPreference: options.providerPreference || options.provider,
    model: options.model,
    profile: options.profile,
    responseMode: options.responseMode,
  });
  const goalMetadata = options.dispatchPlan?.goalScale
    ? inferGoalScale(options.dispatchPlan)
    : inferGoalScale(options, {
        taskClass,
        intent,
        complianceLane,
        authMode,
        routeKey: plan.routeKey,
        routingSource: plan.routingSource,
        candidates: plan.candidates,
        route: {
          lane: plan.routeKey,
          candidates: plan.candidates,
        },
      });
  let lastError = null;
  const runStartedAt = Date.now();
  const attemptEvents = [];

  for (let index = 0; index < plan.candidates.length; index += 1) {
    const candidate = plan.candidates[index];
    const authLabel = resolveAuthLabel({
      provider:
        candidate.type === "deterministic"
          ? candidate.tool
          : candidate.provider,
      authMode,
      options,
    });
    const attemptStartedAt = Date.now();
    let executionCandidate = candidate;
    let spendControlAction = null;

    try {
      ({
        candidate: executionCandidate,
        spendControlAction,
      } = applySpendPolicyToCandidate({
        candidate,
        options,
        taskClass,
        complianceLane,
        caller,
        authLabel,
        authMode,
      }));
      validateExecutionCandidate(plan, executionCandidate, { authMode, audio: options.audio });
      const result =
        executionCandidate.type === "deterministic"
          ? await executeDeterministicCandidate(executionCandidate, options)
          : await llmCallAsync({
              provider: executionCandidate.provider,
              authMode,
              prompt: options.prompt,
              systemPrompt: options.systemPrompt,
              messages: options.messages,
              audio: options.audio,
              profile: executionCandidate.profile || resolveProfileId(options.profile, taskClass),
              model: executionCandidate.model || options.model,
              timeoutMs: options.timeoutMs,
              maxOutputTokens: options.maxOutputTokens,
              responseMode: options.responseMode,
              budgetCapUsd: options.budgetCapUsd,
              temperature: options.temperature,
              includeMetadata: true,
              taskClass,
              intent,
              complianceLane,
              humanVisible: complianceLane === "interactive_oauth" ? true : Boolean(options.humanVisible),
              searchGrounding: options.searchGrounding,
              tools: options.tools,
            });

      const finalResult = {
        ...result,
        authMode,
        authLabel,
        caller,
        executionPolicy,
        complianceLane,
        humanVisible: complianceLane === "interactive_oauth" ? true : Boolean(options.humanVisible),
        deterministicBypassReason: plan.deterministicBypassReason,
        fallbackIndex: index,
        spendControlAction,
        intent: intent || null,
        pinnedProvider:
          executionCandidate.type === "llm" && options.pinnedProvider
            ? executionCandidate.provider
            : null,
        resolvedProfile: executionCandidate.profile || null,
        resolvedTargetType: executionCandidate.type,
        resolvedProviderOrTool:
          executionCandidate.type === "deterministic"
            ? executionCandidate.tool
            : executionCandidate.provider,
        resolvedModelOrEngine:
          executionCandidate.type === "deterministic" ? executionCandidate.tool : result.model,
        routingSource: plan.routingSource,
        taskClass,
        taskClassInferred: !options.taskClass,
        ...goalMetadata,
        goal: goalMetadata,
        providerRequestId: extractProviderRequestId(result),
      };
      attemptEvents.push({
        index,
        status: "success",
        type: executionCandidate.type,
        providerOrTool:
          executionCandidate.type === "deterministic"
            ? executionCandidate.tool
            : executionCandidate.provider,
        modelOrEngine:
          executionCandidate.type === "deterministic"
            ? executionCandidate.tool
            : finalResult.resolvedModelOrEngine || executionCandidate.model || null,
        latencyMs: Date.now() - attemptStartedAt,
        retryable: false,
        estimatedCostUsd: Number(result.estimatedCostUsd || 0),
        inputTokens: Number(result.usage?.inputTokens || 0),
        outputTokens: Number(result.usage?.outputTokens || 0),
        spendControlAction,
      });
      appendUsageEvent({
        ts: new Date().toISOString(),
        outcome: "success",
        billable: authMode === "api" && executionCandidate.type === "llm",
        caller,
        taskClass,
        intent,
        complianceLane,
        executionPolicy,
        routingSource: plan.routingSource,
        routeKey: plan.routeKey,
        authMode,
        resolvedTargetType: finalResult.resolvedTargetType,
        resolvedProviderOrTool: finalResult.resolvedProviderOrTool,
        resolvedModelOrEngine: finalResult.resolvedModelOrEngine,
        resolvedProfile: finalResult.resolvedProfile,
        fallbackIndex: index,
        authLabel: finalResult.authLabel,
        estimatedCostUsd: Number(finalResult.estimatedCostUsd || 0),
        inputTokens: Number(result.usage?.inputTokens || 0),
        outputTokens: Number(result.usage?.outputTokens || 0),
        totalLatencyMs: Date.now() - runStartedAt,
        deterministicBypassReason: plan.deterministicBypassReason,
        providerRequestId: finalResult.providerRequestId,
        spendControlAction,
        goalScale: goalMetadata.goalScale,
        goalMode: goalMetadata.goalMode,
        goalConfidence: goalMetadata.goalConfidence,
        goalReasons: goalMetadata.goalReasons,
        stopRules: goalMetadata.stopRules,
        requiresPlan: goalMetadata.requiresPlan,
        requiresApproval: goalMetadata.requiresApproval,
        blockedBy: goalMetadata.blockedBy,
        attempts: attemptEvents,
      });
      spendSummaryCache = null;
      return finalResult;
    } catch (error) {
      lastError = error;
      const retryableError = isRetryableProviderError(error);
      attemptEvents.push({
        index,
        status: "error",
        type: executionCandidate.type,
        providerOrTool:
          executionCandidate.type === "deterministic"
            ? executionCandidate.tool
            : executionCandidate.provider,
        modelOrEngine:
          executionCandidate.type === "deterministic"
            ? executionCandidate.tool
            : executionCandidate.model || executionCandidate.profile || null,
        latencyMs: Date.now() - attemptStartedAt,
        retryable: retryableError,
        issueType: classifyUsageIssue(error),
        errorCode: error?.code || null,
        errorStatus: error?.responseStatus || error?.status || null,
        errorMessage: String(error?.message || "unknown error").slice(0, 300),
        spendControlAction,
      });
      const fallbackCandidate = index < plan.candidates.length - 1 ? plan.candidates[index + 1] : null;
      if (fallbackCandidate && retryableError) {
        continue;
      }
      await maybeNotifyProviderIssue({
        provider:
          executionCandidate.type === "llm"
            ? executionCandidate.provider
            : executionCandidate.tool,
        error,
        taskClass,
        fallbackProvider:
          fallbackCandidate?.type === "llm"
            ? fallbackCandidate.provider
            : fallbackCandidate?.tool || null,
        fallbackIndex: fallbackCandidate ? index + 1 : null,
      });
      appendUsageEvent({
        ts: new Date().toISOString(),
        outcome: "error",
        billable: authMode === "api" && executionCandidate.type === "llm",
        caller,
        taskClass,
        intent,
        complianceLane,
        executionPolicy,
        routingSource: plan.routingSource,
        routeKey: plan.routeKey,
        authMode,
        resolvedTargetType: executionCandidate.type,
        resolvedProviderOrTool:
          executionCandidate.type === "deterministic"
            ? executionCandidate.tool
            : executionCandidate.provider,
        resolvedModelOrEngine:
          executionCandidate.type === "deterministic"
            ? executionCandidate.tool
            : executionCandidate.model || executionCandidate.profile || null,
        resolvedProfile: executionCandidate.profile || null,
        fallbackIndex: index,
        authLabel,
        estimatedCostUsd: 0,
        totalLatencyMs: Date.now() - runStartedAt,
        deterministicBypassReason: plan.deterministicBypassReason,
        spendControlAction,
        goalScale: goalMetadata.goalScale,
        goalMode: goalMetadata.goalMode,
        goalConfidence: goalMetadata.goalConfidence,
        goalReasons: goalMetadata.goalReasons,
        stopRules: goalMetadata.stopRules,
        requiresPlan: goalMetadata.requiresPlan,
        requiresApproval: goalMetadata.requiresApproval,
        blockedBy: goalMetadata.blockedBy,
        attempts: attemptEvents,
      });
      spendSummaryCache = null;
      throw error;
    }
  }

  throw lastError || new Error(`No MyOS candidates available for ${plan.routeKey}:${plan.complianceLane}`);
}

async function myOSrunOauth(options = {}) {
  return myosRun({
    ...options,
    authMode: "oauth",
    complianceLane: options.complianceLane || "interactive_oauth",
    executionPolicy: options.executionPolicy || "interactive_session",
  });
}

async function myOSrunAPI(options = {}) {
  return myosRun({
    ...options,
    authMode: "api",
    complianceLane:
      options.complianceLane ||
      (normalizeTaskClass(options.taskClass) === "audio_transcription" && options.audio
        ? "unattended_local"
        : "unattended_api"),
    executionPolicy: options.executionPolicy || "internal_automation",
  });
}

function llmCall(options = {}) {
  const script = `
    const { llmCallAsync } = require(${JSON.stringify(path.join(__dirname, "llm-call.js"))});
    (async () => {
      const result = await llmCallAsync(${JSON.stringify({ ...options, includeMetadata: true })});
      process.stdout.write(JSON.stringify(result));
    })().catch((err) => {
      console.error(err.message || String(err));
      process.exit(1);
    });
  `;

  const output = execFileSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: process.env,
    timeout: Number(options.timeoutMs || 180000) + 2000,
  });

  const parsed = JSON.parse(output);
  return options.includeMetadata ? parsed : parsed.text;
}

function myosRunSync(options = {}) {
  const script = `
    const { myosRun } = require(${JSON.stringify(path.join(__dirname, "llm-call.js"))});
    (async () => {
      const result = await myosRun(${JSON.stringify(options)});
      process.stdout.write(JSON.stringify(result));
    })().catch((err) => {
      console.error(err.message || String(err));
      process.exit(1);
    });
  `;

  const output = execFileSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: process.env,
    timeout: Number(options.timeoutMs || 180000) + 2000,
  });

  return JSON.parse(output);
}

function normalizeLegacyCallArgs(promptOrOptions, model, timeoutMs, provider) {
  if (
    promptOrOptions &&
    typeof promptOrOptions === "object" &&
    !Array.isArray(promptOrOptions)
  ) {
    return { ...promptOrOptions };
  }

  return {
    prompt: String(promptOrOptions || ""),
    model,
    timeoutMs,
    provider,
    includeMetadata: true,
  };
}

function resolveLegacyTaskClass(existingTaskClass, model) {
  if (existingTaskClass) return normalizeTaskClass(existingTaskClass);
  const normalizedModel = String(model || "").trim().toLowerCase();
  if (normalizedModel.includes("haiku")) return "cheap_routing";
  if (normalizedModel.includes("sonnet") || normalizedModel.includes("opus")) {
    return "heavy_synthesis";
  }
  return "default_automation";
}

function clearLegacyClaudeModel(model) {
  const normalizedModel = String(model || "").trim().toLowerCase();
  return normalizedModel.startsWith("claude") ? undefined : model;
}

function applyLegacyAuthRoute(options = {}, env = process.env) {
  // Any explicit lane/auth/policy from the caller means they own the routing
  // contract; do not let the initiator marker re-route them.
  if (options.authMode || options.complianceLane || options.executionPolicy) {
    return options;
  }

  if (normalizeTaskClass(options.taskClass) === "audio_transcription" && options.audio) {
    return {
      ...options,
      authMode: "api",
      complianceLane: "unattended_local",
      executionPolicy: options.executionPolicy || "internal_automation",
    };
  }

  if (isUnattendedInitiator(env)) {
    return {
      ...options,
      authMode: "api",
      complianceLane: "unattended_api",
      executionPolicy: options.executionPolicy || "internal_automation",
    };
  }

  if (process.stdin && process.stdin.isTTY === false && !env.MYOS_INITIATOR) {
    try {
      appendUsageEvent({
        ts: new Date().toISOString(),
        outcome: "warning",
        warningType: "human_oauth_no_tty",
        caller: options.caller || null,
        taskClass: options.taskClass || null,
        message:
          "Legacy helper routed to OAuth without TTY and without MYOS_INITIATOR marker; verify the call is truly human-initiated.",
      });
    } catch {
      // Telemetry must never break the call.
    }
  }

  return {
    ...options,
    authMode: "oauth",
    complianceLane: "interactive_oauth",
    executionPolicy: "interactive_session",
    humanVisible: options.humanVisible ?? true,
  };
}

async function claudeCallAsync(promptOrOptions, model, timeoutMs = 180000) {
  const options = normalizeLegacyCallArgs(promptOrOptions, model, timeoutMs, "");
  const routed = applyLegacyAuthRoute({
    ...options,
    model: clearLegacyClaudeModel(options.model),
    taskClass: resolveLegacyTaskClass(options.taskClass, options.model),
    providerPreference: undefined,
    provider: undefined,
    pinnedProvider: undefined,
  });
  const result = await myosRun(routed);
  return options.includeMetadata ? result : result.text;
}

function claudeCall(promptOrOptions, model, timeoutMs = 180000) {
  const options = normalizeLegacyCallArgs(promptOrOptions, model, timeoutMs, "");
  const routed = applyLegacyAuthRoute({
    ...options,
    model: clearLegacyClaudeModel(options.model),
    taskClass: resolveLegacyTaskClass(options.taskClass, options.model),
    providerPreference: undefined,
    provider: undefined,
    pinnedProvider: undefined,
  });
  const result = myosRunSync(routed);
  return options.includeMetadata ? result : result.text;
}

async function runTaskModelAsync(promptOrOptions, model, timeoutMs = 180000) {
  const options = normalizeLegacyCallArgs(promptOrOptions, model, timeoutMs, "");
  const routed = applyLegacyAuthRoute({
    ...options,
    model: clearLegacyClaudeModel(options.model),
    taskClass: resolveLegacyTaskClass(options.taskClass, options.model),
    providerPreference: undefined,
    provider: undefined,
    pinnedProvider: undefined,
  });
  const result = await myosRun(routed);
  return options.includeMetadata ? result : result.text;
}

function runTaskModel(promptOrOptions, model, timeoutMs = 180000) {
  const options = normalizeLegacyCallArgs(promptOrOptions, model, timeoutMs, "");
  const routed = applyLegacyAuthRoute({
    ...options,
    model: clearLegacyClaudeModel(options.model),
    taskClass: resolveLegacyTaskClass(options.taskClass, options.model),
    providerPreference: undefined,
    provider: undefined,
    pinnedProvider: undefined,
  });
  const result = myosRunSync(routed);
  return options.includeMetadata ? result : result.text;
}

async function codexCallAsync(promptOrOptions, model, timeoutMs = 180000) {
  const options = normalizeLegacyCallArgs(promptOrOptions, model, timeoutMs, "openai");
  if (!options.providerPreference && !options.provider) options.providerPreference = "openai";
  const routed = applyLegacyAuthRoute(options);
  const result = await myosRun(routed);
  return options.includeMetadata ? result : result.text;
}

function codexCall(promptOrOptions, model, timeoutMs = 180000) {
  const options = normalizeLegacyCallArgs(promptOrOptions, model, timeoutMs, "openai");
  if (!options.providerPreference && !options.provider) options.providerPreference = "openai";
  const routed = applyLegacyAuthRoute(options);
  const result = myosRunSync(routed);
  return options.includeMetadata ? result : result.text;
}

async function geminiCallAsync(promptOrOptions, model, timeoutMs = 180000) {
  const options = normalizeLegacyCallArgs(promptOrOptions, model, timeoutMs, "google");
  if (!options.providerPreference && !options.provider) options.providerPreference = "google";
  const routed = applyLegacyAuthRoute(options);
  const result = await myosRun(routed);
  return options.includeMetadata ? result : result.text;
}

function geminiCall(promptOrOptions, model, timeoutMs = 180000) {
  const options = normalizeLegacyCallArgs(promptOrOptions, model, timeoutMs, "google");
  if (!options.providerPreference && !options.provider) options.providerPreference = "google";
  const routed = applyLegacyAuthRoute(options);
  const result = myosRunSync(routed);
  return options.includeMetadata ? result : result.text;
}

module.exports = {
  claudeCall,
  claudeCallAsync,
  codexCall,
  codexCallAsync,
  geminiCall,
  geminiCallAsync,
  estimateCostUsd,
  enforceInteractiveOauthHumanVisibility,
  applyLegacyAuthRoute,
  isUnattendedInitiator,
  llmCall,
  llmCallAsync,
  myOSrunAPI,
  myOSrunOauth,
  myosRun,
  myosRunSync,
  setCodexExecRunnerForTest,
  resetCodexExecRunnerForTest,
  clearLegacyClaudeModel,
  deriveComplianceLane,
  enforceProviderAgnosticCallOptions,
  isGpt55OauthAllowed,
  normalizeExecutionPolicy,
  normalizeComplianceLane,
  normalizeProvider,
  normalizeTaskClass,
  resolveLegacyTaskClass,
  resolveAuthMode,
  resolveCodexOauthModel,
  resolveExecutionPlan,
  resolveProfileId,
  resolveProvider,
  resolveProviderForPolicy,
  runTaskModel,
  runTaskModelAsync,
  isRetryableProviderError,
  validateExecutionCandidate,
};

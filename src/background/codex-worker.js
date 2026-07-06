const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const { loadCatalog, resolveProfileModel } = require("../model-catalog");
const { resolveWorkspacePath } = require("../myos-compat");
const { resolveCodexOauthModel } = require("../runtime/llm-call");
const {
  appendEvent,
  buildBaseState,
  detectPauseCondition,
  markCompleted,
  markFailed,
  markPaused,
  markStarted,
  readSessionState,
} = require("./codex-worker-state");

const DEFAULT_WORKER_CWD = process.env.HOME || os.homedir();
const MC_GRAPH_PATH = resolveWorkspacePath("mission-control", "graphify-out", "graph.json");

function queryGraphContext(userText) {
  if (!userText || !fs.existsSync(MC_GRAPH_PATH)) return "";
  try {
    const result = execFileSync(
      "graphify",
      ["query", userText, "--graph", MC_GRAPH_PATH, "--budget", "600"],
      { timeout: 4000, encoding: "utf8" }
    ).trim();
    if (!result || result.startsWith("No matching nodes found")) return "";
    return result;
  } catch {
    return "";
  }
}

const CLOSED_SESSION_PATTERNS = [
  /write_stdin failed: stdin is closed/i,
  /written stdin failed/i,
  /stdin is closed for this session/i,
  /rerun exec_command with tty=true to keep stdin open/i,
];

const STALE_AUTH_SESSION_PATTERNS = [
  /access token could not be refreshed because your refresh token was already used/i,
  /please log out and sign in again/i,
];

const TOOL_ARGUMENT_PARSE_PATTERNS = [
  /failed to parse function arguments/i,
  /duplicate field/i,
];

const TOOL_ARGUMENT_PARSE_RECOVERY_HINT =
  "Start one fresh Codex session and retry with valid tool-call JSON. Each field may appear at most once, including yield_time_ms.";

function ensureDirectory(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (error) {
    if (error?.code === "ENOSPC") {
      throw new Error(`ENOSPC: no space left on device while creating worker outbox ${dirPath}`);
    }
    throw error;
  }
}

function buildRunOutboxDir(baseOutboxDir, chatId) {
  return path.join(baseOutboxDir, chatId, `${Date.now()}-${randomUUID().slice(0, 8)}`);
}

function resolveRunOutboxDir(baseOutboxDir, chatId) {
  const primaryOutboxDir = buildRunOutboxDir(baseOutboxDir, chatId);
  try {
    ensureDirectory(primaryOutboxDir);
    return primaryOutboxDir;
  } catch (error) {
    if (!String(error?.message || "").includes("ENOSPC:")) {
      throw error;
    }

    const fallbackBaseDir = path.join(os.tmpdir(), "myos-worker-outbox");
    const fallbackOutboxDir = buildRunOutboxDir(fallbackBaseDir, chatId);
    ensureDirectory(fallbackOutboxDir);
    console.warn(
      `[codex-worker] Primary outbox unavailable; using fallback ${fallbackOutboxDir} instead of ${primaryOutboxDir}`
    );
    return fallbackOutboxDir;
  }
}

function parseCodexJsonl(stdout) {
  let sessionId = null;
  const messages = [];
  let errorMessage = null;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      sessionId = event.thread_id;
      continue;
    }

    if (event.type === "error" && typeof event.message === "string" && event.message.trim()) {
      errorMessage = event.message.trim();
      continue;
    }

    if (event.type === "item.completed" && isAssistantMessageEvent(event.item)) {
      const text = extractAssistantMessageText(event.item);
      if (text) messages.push(text);
      continue;
    }

    if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
      usage.inputTokens = Number(event.usage.input_tokens || usage.inputTokens || 0);
      usage.cachedInputTokens = Number(event.usage.cached_input_tokens || usage.cachedInputTokens || 0);
      usage.outputTokens = Number(event.usage.output_tokens || usage.outputTokens || 0);
      continue;
    }

    if (event.type === "turn.failed" && event.error?.message) {
      errorMessage = String(event.error.message).trim();
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    errorMessage,
  };
}

function isAssistantMessageEvent(item) {
  return item && typeof item === "object" && ["agent_message", "assistant_message", "message"].includes(item.type);
}

function extractAssistantMessageText(item) {
  if (!item || typeof item !== "object") return "";
  if (typeof item.text === "string" && item.text.trim()) return item.text.trim();
  if (item.text && typeof item.text === "object") {
    const directText = collectTextFragments(item.text).join("").trim();
    if (directText) return directText;
  }

  if (!Array.isArray(item.content)) return "";

  return collectTextFragments(item.content).join("").trim();
}

function collectTextFragments(value, depth = 0) {
  if (depth > 6 || value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectTextFragments(entry, depth + 1));
  }
  if (typeof value !== "object") return [];

  const fragments = [];
  for (const key of ["text", "value", "content", "parts", "items", "segments"]) {
    if (key in value) {
      fragments.push(...collectTextFragments(value[key], depth + 1));
    }
  }

  if (fragments.length > 0) return fragments;
  return Object.values(value).flatMap((entry) => collectTextFragments(entry, depth + 1));
}

function isStructuredReplyPayload(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.reply === "string" &&
    Array.isArray(value.artifacts)
  );
}

function extractFirstJsonObject(text) {
  const source = String(text || "").trim();
  if (!source) return null;

  const directPayload = parseCandidateJson(source);
  if (directPayload) return directPayload;

  const fencedMatches = source.match(/```(?:json)?\s*([\s\S]*?)```/gi) || [];
  for (const block of fencedMatches) {
    const inner = block.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const payload = parseCandidateJson(inner);
    if (payload) return payload;
  }

  const candidates = [];

  for (let start = source.indexOf("{"); start !== -1; start = source.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaping = false;

    for (let index = start; index < source.length; index += 1) {
      const char = source[index];

      if (inString) {
        if (escaping) {
          escaping = false;
        } else if (char === "\\") {
          escaping = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = parseCandidateJson(source.slice(start, index + 1));
          if (candidate) candidates.push(candidate);
          break;
        }
      }
    }
  }

  const structured = candidates.filter(isStructuredReplyPayload);
  if (structured.length > 0) return structured[structured.length - 1];
  if (candidates.length > 0) return candidates[candidates.length - 1];
  return null;
}

function normalizeStructuredReplyPayload(payload, fallbackReply = "") {
  if (isStructuredReplyPayload(payload)) {
    return {
      reply: payload.reply,
      artifacts: payload.artifacts,
    };
  }

  if (payload && typeof payload === "object") {
    const replyCandidate = typeof payload.reply === "string"
      ? payload.reply
      : typeof payload.text === "string"
        ? payload.text
        : typeof payload.content === "string"
          ? payload.content
          : "";
    const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
    if (replyCandidate.trim() || artifacts.length > 0) {
      return {
        reply: replyCandidate,
        artifacts,
      };
    }
  }

  const reply = String(fallbackReply || "").trim();
  if (!reply) return null;

  return {
    reply,
    artifacts: [],
  };
}

function parseCandidateJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function summarizeInvalidStructuredReply({ parsed, stderr, code, signal }) {
  if (parsed?.errorMessage) return parsed.errorMessage;

  const stderrFailure = firstFailure(stderr);
  if (stderrFailure) return stderrFailure;

  const summary = String(parsed?.summary || "").trim();
  if (summary) {
    const excerpt = summary.replace(/\s+/g, " ").slice(0, 240);
    return `Codex worker returned a non-JSON reply: ${excerpt}`;
  }

  if (code || signal) {
    return `Codex worker exited before producing a structured reply (code=${code ?? "null"}, signal=${signal ?? "null"})`;
  }

  return "Codex worker returned an invalid structured reply";
}

function normalizeArtifactKind(filePath, explicitKind) {
  if (explicitKind === "photo" || explicitKind === "document") return explicitKind;
  const ext = path.extname(filePath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return "photo";
  return "document";
}

function normalizeArtifacts(artifacts, allowedRoot) {
  const root = path.resolve(allowedRoot);
  const normalized = [];

  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    if (!artifact || typeof artifact !== "object") continue;
    if (typeof artifact.path !== "string" || !artifact.path.trim()) continue;

    const resolvedPath = path.resolve(artifact.path);
    if (!resolvedPath.startsWith(`${root}${path.sep}`) && resolvedPath !== root) continue;
    if (!fs.existsSync(resolvedPath)) continue;

    normalized.push({
      path: resolvedPath,
      caption: typeof artifact.caption === "string" ? artifact.caption.trim() : "",
      mimeType: typeof artifact.mimeType === "string" ? artifact.mimeType.trim() : "",
      filename: typeof artifact.filename === "string" ? artifact.filename.trim() : "",
      kind: normalizeArtifactKind(resolvedPath, artifact.kind),
    });
  }

  return normalized;
}

function buildWorkerPrompt({
  systemPrompt,
  userText,
  outboxDir,
  displayName,
  sourceLabel,
  graphContext,
  dispatchPlan,
  retryHint,
}) {
  const dispatchLines = dispatchPlan ? [
    "Dispatch contract for this task:",
    `- branch: ${dispatchPlan.branch}`,
    `- stopAfterMatch: ${dispatchPlan.stopAfterMatch ? "true" : "false"}`,
    `- allowBroadSearch: ${dispatchPlan.allowBroadSearch ? "true" : "false"}`,
    dispatchPlan.searchScope ? `- searchScope: ${dispatchPlan.searchScope}` : "",
    dispatchPlan.parallelizationPlan?.requiredDigest
      ? "- requiredSidecarDigest follows below and should be treated as advisory evidence, not final truth."
      : "",
    !dispatchPlan.allowBroadSearch
      ? "- Broad search is forbidden for this task. Stay within the resolved branch and scoped search root."
      : "- Broad search is allowed only if the scoped branch does not answer the request.",
    dispatchPlan.stopAfterMatch
      ? "- Stop at the first authoritative answer inside the branch. Do not keep exploring for alternatives."
      : "",
  ].filter(Boolean) : [];

  return [
    "You are the local worker running inside MyOS on the user's machine.",
    `Current Telegram user: ${displayName}.`,
    sourceLabel ? `Incoming message source: ${sourceLabel}.` : "",
    "",
    "Execution rules:",
    `- You have full workspace access and should do real work, not describe hypothetical steps.`,
    `- Read local files and use local tools as needed.`,
    "- Use MyOS Dispatch as the execution contract for workspace tasks.",
    "- Follow this lookup order before searching broadly: DISPATCH-FASTPATHS.json, project _index.json, capabilities-index.json, TOOLS.md, then targeted rg only if still unresolved.",
    "- Treat MyOS requests as local-workspace tasks by default. Resolve the MyOS project/data branch first, and only use the web or external internet lookup as a last resort if local authoritative sources do not answer the request.",
    "- Do not jump from a weak first hit into broad workspace or repo searches. Go one step deeper through the dispatch breadcrumbs first.",
    "- Stop after a strong fast-path, project context, or capability match unless the user asks for the exact handler, command, or implementation file.",
    "- Do not tell the user to run commands in Terminal, copy-paste scripts, or perform manual local steps when you can do the work yourself.",
    "- If the request is to create, edit, render, convert, research, or fetch something, perform the task locally and return the result.",
    "- If the user request is underspecified but you can make a reasonable default choice, choose the default and proceed instead of asking a clarifying question.",
    "- Ask a clarifying question only when a missing detail would materially block the task or create a real risk of doing the wrong thing.",
    `- If you generate a file meant to be returned to Telegram, write it under this outbox directory only: ${outboxDir}`,
    "- For PDFs, images, videos, documents, and similar outputs, prefer returning an artifact rather than pasting source code or shell snippets.",
    "- Never claim you lack access to the workspace if the task can be handled locally.",
    "- Do not spawn ad hoc background scouts or call myos-sidecar.js yourself. MyOS Dispatch owns fan-out; if more lanes are needed, name them in your JSON reply so the orchestrator can issue tracked sidecars.",
    "- Keep the reply concise and factual.",
    "- The final response must be JSON only with this exact structure:",
    "{\"reply\":\"string\",\"artifacts\":[{\"path\":\"string\",\"caption\":\"string\",\"filename\":\"string\",\"mimeType\":\"string\",\"kind\":\"document|photo\"}]}",
    "- If no file should be returned, set artifacts to an empty array.",
    "",
    dispatchLines.length > 0 ? dispatchLines.join("\n") : "",
    "",
    "Role and policy context:",
    systemPrompt,
    "",
    retryHint ? "Retry guidance:" : "",
    retryHint || "",
    "",
    graphContext ? "Codebase graph context (relevant nodes for this request):" : "",
    graphContext || "",
    "",
    dispatchPlan?.parallelizationPlan?.requiredDigest ? "Required background sidecar digest:" : "",
    dispatchPlan?.parallelizationPlan?.requiredDigest || "",
    dispatchPlan?.parallelizationPlan?.requiredDigest ? "" : "",
    dispatchPlan?.parallelizationPlan?.requiredDigest
      ? "If the digest includes patch artifacts or changed files, review them before finalizing the answer."
      : "",
    dispatchPlan?.parallelizationPlan?.requiredDigest ? "" : "",
    dispatchPlan?.priorSidecarDigest ? "Background findings from the previous turn (advisory, may be stale):" : "",
    dispatchPlan?.priorSidecarDigest || "",
    dispatchPlan?.priorSidecarDigest ? "" : "",
    "User request:",
    userText,
  ].filter(Boolean).join("\n");
}

function resolveWorkerProfileId(dispatchPlan = {}) {
  const defaultProfile = process.env.MYOS_MODEL_PROFILE_DEFAULT || "bot_default";
  const smartProfile = process.env.MYOS_MODEL_PROFILE_SMART || "openai_heavy_reasoning";
  const writeProfile = process.env.MYOS_MODEL_PROFILE_WRITE || "default_automation";
  const backgroundTaskCount = Array.isArray(dispatchPlan?.parallelizationPlan?.backgroundTasks)
    ? dispatchPlan.parallelizationPlan.backgroundTasks.length
    : 0;

  if (
    dispatchPlan?.intentType === "exploratory" ||
    dispatchPlan?.requiresPlan ||
    Number(dispatchPlan?.goalScale || 0) >= 4 ||
    dispatchPlan?.route?.lane === "workflow"
  ) {
    return smartProfile;
  }

  if (dispatchPlan?.actionType === "write" || backgroundTaskCount >= 10) {
    return writeProfile;
  }

  return defaultProfile;
}

function resolveCodexWorkerModelSelection(options = {}) {
  if (options.model) {
    return {
      model: resolveCodexOauthModel(options.model),
      profileId: null,
      source: "explicit_option",
    };
  }

  const envOverride = process.env.MYOS_LOCAL_WORKER_MODEL || "";
  if (envOverride) {
    return {
      model: resolveCodexOauthModel(envOverride),
      profileId: null,
      source: "env_override",
    };
  }

  const profileId = resolveWorkerProfileId(options.dispatchPlan || {});
  try {
    const resolved = resolveProfileModel(loadCatalog("openai"), profileId);
    return {
      model: resolveCodexOauthModel(resolved.model.model),
      profileId,
      source: "routing_profile",
    };
  } catch {
    return {
      model: "gpt-5.4-mini",
      profileId,
      source: "fallback_default",
    };
  }
}

function isClosedSessionError(text = "") {
  const source = String(text || "").trim();
  if (!source) return false;
  return CLOSED_SESSION_PATTERNS.some((pattern) => pattern.test(source));
}

function isStaleResumeError(text = "") {
  const source = String(text || "").trim();
  if (!source) return false;
  return (
    isClosedSessionError(source) ||
    STALE_AUTH_SESSION_PATTERNS.some((pattern) => pattern.test(source))
  );
}

function isToolArgumentParseError(text = "") {
  const source = String(text || "").trim();
  if (!source) return false;
  return TOOL_ARGUMENT_PARSE_PATTERNS.every((pattern) => pattern.test(source));
}

function runCommand({ command, args, cwd, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "pipe",
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (finished) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, timeoutMs) : null;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finished = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      finished = true;
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });

    child.stdin.on("error", (error) => {
      if (finished) return;
      // The worker can exit before stdin finishes flushing; treat that as a
      // normal worker failure path and let the close/error handlers resolve it.
      if (error?.code === "EPIPE" || error?.code === "ERR_STREAM_DESTROYED") {
        stderr += `${error.message}\n`;
        return;
      }
      finished = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });

    if (input) {
      try {
        child.stdin.write(input);
      } catch (error) {
        if (error?.code !== "EPIPE" && error?.code !== "ERR_STREAM_DESTROYED") {
          throw error;
        }
        stderr += `${error.message}\n`;
      }
    }
    child.stdin.end();
  });
}

async function runCodexWorker(options = {}) {
  const chatId = String(options.chatId || "unknown");
  const baseOutboxDir = path.resolve(options.outboxDir || resolveWorkspacePath("agents", "worker", "data", "outbox"));
  const runOutboxDir = resolveRunOutboxDir(baseOutboxDir, chatId);
  const backgroundMode = Boolean(options.ephemeral || options.background);
  const effectiveSessionId = backgroundMode ? null : options.sessionId || null;
  const stateOptions = backgroundMode
    ? {
        ...options,
        sessionId: null,
        taskId: options.taskId
          ? `${options.taskId}-background-${randomUUID().slice(0, 8)}`
          : `${chatId}-background-${randomUUID().slice(0, 8)}`,
        taskLabel: `${options.taskLabel || options.displayName || options.chatId || "Codex task"} (background)`,
      }
    : {
        ...options,
        sessionId: effectiveSessionId,
      };
  const existingState = !backgroundMode && options.taskId ? readSessionState(String(options.taskId)) : null;
  const taskState = markStarted(existingState || buildBaseState(stateOptions), stateOptions);

  const userText = String(options.userText || "").trim();
  const prompt = buildWorkerPrompt({
    systemPrompt: String(options.systemPrompt || "").trim(),
    userText,
    outboxDir: runOutboxDir,
    displayName: String(options.displayName || "User"),
    sourceLabel: options.sourceLabel,
    graphContext: queryGraphContext(userText),
    dispatchPlan: options.dispatchPlan || null,
    retryHint: options.retryHint || "",
  });
  const workerModelSelection = resolveCodexWorkerModelSelection(options);

  const args = ["exec"];
  const isResume = Boolean(effectiveSessionId);
  if (isResume) {
    args.push("resume");
  }
  args.push("--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox");
  if (!isResume && (options.cwd || DEFAULT_WORKER_CWD)) {
    args.push("-C", options.cwd || DEFAULT_WORKER_CWD);
  }
  if (workerModelSelection.model) {
    args.push("-m", workerModelSelection.model);
  }
  if (isResume) {
    args.push(String(effectiveSessionId));
  }
  args.push("-");

  try {
    const { code, signal, stdout, stderr } = await runCommand({
      command: options.command || "codex",
      args,
      cwd: options.cwd || DEFAULT_WORKER_CWD,
      input: prompt,
      timeoutMs: Number(options.timeoutMs || 20 * 60 * 1000),
    });

    const parsed = parseCodexJsonl(stdout);
    const payload = normalizeStructuredReplyPayload(
      extractFirstJsonObject(parsed.summary),
      parsed.summary,
    );
    if (!payload) {
      const failureMessage = summarizeInvalidStructuredReply({ parsed, stderr, code, signal });
      if (!options.toolArgRetryAttempt && isToolArgumentParseError(failureMessage)) {
        markFailed(taskState, failureMessage, parsed.sessionId || effectiveSessionId || null);
        appendEvent({
          type: "session.retry_tool_args",
          task_id: taskState.task_id,
          session_id: parsed.sessionId || effectiveSessionId || null,
          status: "retrying",
          raw_error_excerpt: String(failureMessage).trim().slice(0, 500),
          recovery_hint: TOOL_ARGUMENT_PARSE_RECOVERY_HINT,
        });
        return runCodexWorker({
          ...options,
          sessionId: null,
          toolArgRetryAttempt: 1,
          retryHint: TOOL_ARGUMENT_PARSE_RECOVERY_HINT,
        });
      }
      if (isResume && isStaleResumeError(failureMessage)) {
        markFailed(taskState, failureMessage, parsed.sessionId || effectiveSessionId || null);
        appendEvent({
          type: "session.retry_fresh",
          task_id: taskState.task_id,
          session_id: parsed.sessionId || effectiveSessionId || null,
          status: "retrying",
          raw_error_excerpt: String(failureMessage).trim().slice(0, 500),
        });
        return runCodexWorker({
          ...options,
          sessionId: null,
        });
      }
      const pauseInfo = detectPauseCondition({ parsed, stderr, stdout, fallbackError: failureMessage });
      if (pauseInfo.isPaused) {
        markPaused(taskState, pauseInfo, parsed.sessionId || effectiveSessionId || null);
      } else {
        markFailed(taskState, failureMessage, parsed.sessionId || effectiveSessionId || null);
      }
      throw new Error(failureMessage);
    }

    const artifacts = normalizeArtifacts(payload.artifacts, runOutboxDir);
    if (!payload.reply.trim() && artifacts.length === 0) {
      const failureMessage = "Codex worker returned neither a reply nor an artifact";
      markFailed(taskState, failureMessage, parsed.sessionId || effectiveSessionId || null);
      throw new Error(failureMessage);
    }
    const completedState = markCompleted(taskState, {
      sessionId: parsed.sessionId || effectiveSessionId || null,
      artifacts,
      usage: parsed.usage,
    });
    return {
      taskId: completedState.task_id,
      sessionId: parsed.sessionId || effectiveSessionId || null,
      reply: payload.reply.trim(),
      artifacts,
      usage: parsed.usage,
      model: workerModelSelection.model,
      modelProfile: workerModelSelection.profileId,
      modelSource: workerModelSelection.source,
      code,
      signal,
      stdout,
      stderr,
      outboxDir: runOutboxDir,
      background: backgroundMode,
    };
  } catch (error) {
    if (error && typeof error.message === "string") {
      const currentState = readSessionState(taskState.task_id);
      if (!currentState || (currentState.status !== "paused" && currentState.status !== "failed")) {
        markFailed(taskState, error.message, effectiveSessionId || null);
      }
    }
    throw error;
  } finally {
    // no cleanup required
  }
}

function firstFailure(stderr) {
  return String(stderr || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

module.exports = {
  DEFAULT_WORKER_CWD,
  buildWorkerPrompt,
  extractFirstJsonObject,
  extractAssistantMessageText,
  isToolArgumentParseError,
  isStructuredReplyPayload,
  normalizeStructuredReplyPayload,
  normalizeArtifacts,
  parseCodexJsonl,
  resolveCodexWorkerModelSelection,
  resolveRunOutboxDir,
  runCodexWorker,
  TOOL_ARGUMENT_PARSE_RECOVERY_HINT,
};

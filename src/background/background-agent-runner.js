"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");

const { loadCatalog, resolveProfileModel } = require("../model-catalog");
const { resolveCodexOauthModel } = require("../runtime/llm-call");
const { parseCodexJsonl } = require("./codex-worker");
const {
  isParallelizationTargetQuarantined,
  readVersionState,
} = require("../promotion/parallelization-version-policy");

const EXECUTION_MODES = Object.freeze({
  NONE: "none",
  READ_ONLY: "read_only",
  WRITE: "workspace_write",
});
const LEGACY_METADATA_ONLY_MODES = new Set(["observe"]);
const DEFAULT_TIMEOUT_MS = 180 * 1000;
const DEFAULT_MAX_CONCURRENT_SIDECARS = 4;
const DEFAULT_MAX_LOAD_AVG = 12;
const DEFAULT_MIN_FREE_DISK_GIB_FOR_WRITABLE = 12;
const STRUCTURED_RESULT_CONTRACT = '- End your reply with a single line containing only this JSON object: {"findings":[{"file":"...","note":"..."}],"risks":["..."],"checks":["..."],"confidence":"low|medium|high"}';
const ORCHESTRATOR_NAME = "myos-dispatch";
const DEFAULT_OPTIONAL_SIDECAR_GRACE_MS = 1000;
const MIN_OPTIONAL_SIDECAR_GRACE_MS = 0;
const MAX_OPTIONAL_SIDECAR_GRACE_MS = 5000;
const CODEX_API_KEY_ENV_KEYS = Object.freeze([
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_ORG_ID",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
]);
const ANTHROPIC_ENV_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_API_KEY",
  "CLAUDE_CODE_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);
const ANTHROPIC_KEY_PATTERN = /^ANTHROPIC_/;
const SECRET_LIKE_ENV_PATTERN = /(API[_-]?KEY|(?:^|[_-])KEY(?:[_-]|$)|TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|CREDENTIAL|PRIVATE[_-]?KEY|AUTH[_-]?TOKEN|SESSION[_-]?(?:ID|KEY|TOKEN)|(?:^|[_-])PAT(?:[_-]|$)|BEARER)/i;
const SAFE_AUTH_METADATA_KEYS = new Set([
  "MYOS_AUTH_MODE",
  "MYOS_BACKGROUND_AUTH_MODE",
  "MYOS_BACKGROUND_AUTH_LABEL",
]);
const SAFE_SIDECAR_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CODEX_HOME",
  "CI",
]);

function normalizeWorkerKind(command = "") {
  const base = path.basename(String(command || "codex").trim()).toLowerCase();
  if (base === "claude" || base === "claude-code" || base === "claude_code") return "claude";
  if (base === "gemini" || base === "gemini-cli" || base === "gemini_cli") return "gemini";
  return "codex";
}

function findGeminiApiKeyEnv(env = process.env) {
  return ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_AI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]
    .filter((key) => Boolean(env?.[key]));
}

const { backgroundAgentsDisabled, isUnattendedContext } = require("../env-context");

function stripAnthropicKeys(childEnv) {
  for (const key of ANTHROPIC_ENV_KEYS) delete childEnv[key];
  for (const key of Object.keys(childEnv)) {
    if (ANTHROPIC_KEY_PATTERN.test(key)) delete childEnv[key];
  }
}

function buildCodexOauthEnv(env = process.env) {
  const childEnv = { ...env };
  for (const key of CODEX_API_KEY_ENV_KEYS) delete childEnv[key];
  stripAnthropicKeys(childEnv);
  childEnv.MYOS_AUTH_MODE = "oauth";
  childEnv.MYOS_BACKGROUND_AUTH_MODE = "oauth";
  childEnv.MYOS_BACKGROUND_AUTH_LABEL = "codex-oauth";
  return childEnv;
}

function buildCodexApiKeyEnv(env = process.env) {
  const childEnv = { ...env };
  stripAnthropicKeys(childEnv);
  childEnv.MYOS_AUTH_MODE = "api";
  childEnv.MYOS_BACKGROUND_AUTH_MODE = "api";
  childEnv.MYOS_BACKGROUND_AUTH_LABEL = "codex-api";
  return childEnv;
}

function assertNoAnthropicKeysInChildEnv(env, taskId = "") {
  const suffix = taskId ? ` (task=${taskId})` : "";
  for (const key of ANTHROPIC_ENV_KEYS) {
    if (key in env) {
      throw new Error(`Security: Anthropic credential ${key} must not appear in Codex sidecar env${suffix}`);
    }
  }
  for (const key of Object.keys(env || {})) {
    if (ANTHROPIC_KEY_PATTERN.test(key)) {
      throw new Error(`Security: potential Anthropic credential ${key} must not appear in Codex sidecar env${suffix}`);
    }
  }
}

function sanitizeSidecarEnv(env = process.env, options = {}) {
  const unattendedCodex = options.kind === "codex" && options.unattended === true;
  const allowedCredentialKeys = unattendedCodex ? new Set(CODEX_API_KEY_ENV_KEYS) : new Set();
  const sanitized = {};
  for (const [key, value] of Object.entries(env || {})) {
    const safeMetadata = SAFE_AUTH_METADATA_KEYS.has(key);
    const allowedCredential = allowedCredentialKeys.has(key);
    const allowedRuntime = SAFE_SIDECAR_ENV_KEYS.has(key) || key.startsWith("LC_");
    const allowedMyosPolicy = key.startsWith("MYOS_") && !SECRET_LIKE_ENV_PATTERN.test(key);
    if (!safeMetadata && !allowedCredential && !allowedRuntime && !allowedMyosPolicy) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function randomToken(prefix) {
  if (typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

function isSidecarProcess(env = process.env) {
  return String(env?.MYOS_BACKGROUND_IS_SIDECAR || "") === "1" ||
    String(env?.MYOS_SIDECAR_ORCHESTRATED || "") === "1";
}

function createOrchestratorContext(options = {}) {
  const existing = options.orchestratorContext || {};
  return {
    orchestrator: existing.orchestrator || ORCHESTRATOR_NAME,
    runId: existing.runId || options.sidecarRunId || randomToken("sidecar-run"),
    token: existing.token || options.sidecarOrchestratorToken || randomToken("sidecar-token"),
    parentTaskId: existing.parentTaskId || options.parentTaskId || "root",
  };
}

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function resolveOptionalSidecarGraceMs(env = process.env) {
  return clampInt(
    env?.MYOS_OPTIONAL_SIDECAR_GRACE_MS,
    DEFAULT_OPTIONAL_SIDECAR_GRACE_MS,
    MIN_OPTIONAL_SIDECAR_GRACE_MS,
    MAX_OPTIONAL_SIDECAR_GRACE_MS,
  );
}

function assertOrchestratedTask(options = {}) {
  if (isSidecarProcess(options.env || process.env)) {
    throw new Error("Nested background fan-out is blocked: sidecars must report needed follow-up to the parent MyOS Dispatch orchestrator.");
  }
  const context = options.orchestratorContext || {};
  if (!context.runId || !context.token) {
    throw new Error("Background task refused: missing MyOS Dispatch orchestrator context.");
  }
}

function resolveProviderCapabilities(kind, options = {}) {
  const env = options.env || process.env;
  const fromFlag = (value) => String(value || "").trim() === "1";
  // Provider-affine fan-out: a sidecar on the caller's own provider inherits
  // the caller's human OAuth lane without needing an explicit enable flag.
  const callerKind = options.callerProvider ? normalizeWorkerKind(options.callerProvider) : null;
  const sameProviderAsCaller = callerKind != null && callerKind === kind;
  if (kind === "codex") {
    return {
      supportsReadOnly: true,
      supportsStructuredJson: true,
      supportsHumanOauth: true,
      supportsWritablePatchWorktree: true,
    };
  }
  if (kind === "claude") {
    return {
      supportsReadOnly: true,
      supportsStructuredJson: true,
      supportsHumanOauth: sameProviderAsCaller || fromFlag(env.MYOS_BACKGROUND_CLAUDE_HUMAN_OAUTH),
      supportsWritablePatchWorktree: false,
    };
  }
  return {
    supportsReadOnly: true,
    supportsStructuredJson: true,
    supportsHumanOauth: sameProviderAsCaller || fromFlag(env.MYOS_BACKGROUND_GEMINI_HUMAN_OAUTH),
    supportsWritablePatchWorktree: fromFlag(env.MYOS_BACKGROUND_GEMINI_WRITABLE),
  };
}

function assertProviderAffinity(kind, options = {}, task = {}) {
  const caller = options.callerProvider;
  if (!["codex", "claude", "gemini"].includes(caller)) {
    throw new Error("Provider-affine fan-out requires an explicit valid callerProvider.");
  }
  const delegation = options.delegation;
  if (delegation) {
    const env = options.env || process.env;
    const protectedContext = isUnattendedContext(env) || isSidecarProcess(env) ||
      options.protectedSurface === true || task.protectedSurface === true ||
      ["bot", "unattended", "scheduler", "cron", "sidecar"].includes(String(env.MYOS_INITIATOR || "").toLowerCase()) ||
      ["allsorted", "goldenclaw"].includes(String(task.projectSlug || options.projectSlug || "").toLowerCase());
    if (caller !== "claude" || kind !== "codex" ||
        delegation.callerProvider !== caller || delegation.workerProvider !== kind ||
        delegation.purpose !== "code-write" || delegation.context !== "human-interactive" ||
        task.effectiveMode !== EXECUTION_MODES.WRITE || protectedContext ||
        !Array.isArray(task.ownershipPaths) || task.ownershipPaths.length === 0) {
      throw new Error("Explicit delegation refused: requires human-interactive Claude to Codex code-write with ownership and matching caller.");
    }
    return;
  }
  if (caller !== kind) {
    throw new Error(`Provider-affine fan-out refuses ${kind} sidecars for a ${caller} caller (cross-provider mixing is disabled).`);
  }
}

function assertGeminiOauthOnly(options = {}) {
  if (options.allowGeminiApiKey === true) return;
  const keys = findGeminiApiKeyEnv(options.env || process.env);
  if (!keys.length) return;
  throw new Error(
    `Gemini background sidecars require OAuth-only auth; refusing API-key environment: ${keys.join(", ")}.`,
  );
}

function assertOauthOnlyWorker(kind, options = {}) {
  const capabilities = resolveProviderCapabilities(kind, options);
  if (capabilities.supportsHumanOauth) return;
  throw new Error(
    `OAuth-only background fan-out refuses ${kind} worker because safe human OAuth support is not enabled.`,
  );
}

function resolveBackgroundModel({ provider, profile, command }) {
  const kind = normalizeWorkerKind(command);
  if (kind === "claude") return process.env.MYOS_BACKGROUND_CLAUDE_MODEL || "haiku";
  if (kind === "gemini") return process.env.MYOS_BACKGROUND_GEMINI_MODEL || null;

  let resolvedModel = null;
  try {
    resolvedModel = resolveProfileModel(
      loadCatalog(provider || process.env.MYOS_LLM_PROVIDER || "openai"),
      profile || "cheap_routing",
    ).model.model;
  } catch {
    resolvedModel = process.env.MYOS_BACKGROUND_CODEX_MODEL || null;
  }

  if (kind === "codex") {
    return resolveCodexOauthModel(resolvedModel || process.env.MYOS_BACKGROUND_CODEX_MODEL || "gpt-5.4-mini");
  }

  return resolvedModel;
}

function resolveTaskModel(task = {}, options = {}) {
  const command = options.command || "codex";
  const kind = normalizeWorkerKind(command);
  if (kind === "codex" && task.model) {
    return task.model;
  }
  return task.model || resolveBackgroundModel({
    provider: options.provider,
    profile: task.modelProfile,
    command,
  });
}

function buildReadOnlyPrompt(task = {}) {
  return [
    "You are a disposable MyOS Dispatch background agent.",
    `Agent profile: ${task.agentProfile || "myos_code_mapper"}.`,
    `Role contract: ${task.roleContract || "Inspect only the assigned bounded scope and report evidence."}`,
    "Mode: READ ONLY.",
    "Hard rules:",
    "- Do not edit, create, delete, move, or modify files.",
    "- Do not send messages, make purchases, authenticate, deploy, or mutate external systems.",
    "- Use only read-only inspection and reasoning.",
    "- OAuth/auth lane work is human-driven: you may reason about routing, but must not log in, refresh tokens, or read secret material.",
    "- Do not spawn background agents, sidecars, myos-sidecar.js, Codex/Claude/Gemini subagents, or nested workers.",
    "- All fan-out is owned by the parent MyOS Dispatch orchestrator; if more lanes are needed, report that as a finding.",
    "- Return concise findings, confidence, and any blockers.",
    `Execution envelope: ${JSON.stringify(task.executionEnvelope || {})}.`,
    STRUCTURED_RESULT_CONTRACT,
    "Your context will be discarded after this subtask.",
    "",
    "Subtask:",
    task.prompt || "",
  ].join("\n");
}

function buildWritablePrompt(task = {}) {
  const ownership = Array.isArray(task.ownershipPaths) && task.ownershipPaths.length > 0
    ? task.ownershipPaths.join(", ")
    : "assigned ownership scope";
  return [
    "You are a disposable MyOS Dispatch background agent.",
    `Agent profile: ${task.agentProfile || "worker"}.`,
    `Role contract: ${task.roleContract || "Implement only the assigned bounded scope."}`,
    "Mode: WRITABLE ISOLATED GIT WORKTREE.",
    "Hard rules:",
    "- You are operating inside an isolated ephemeral git worktree, never the shared workspace.",
    `- You may edit only within these ownership paths: ${ownership}.`,
    "- Do not authenticate, refresh tokens, read secret material, or mutate external systems.",
    "- Do not spawn background agents, sidecars, myos-sidecar.js, Codex/Claude/Gemini subagents, or nested workers.",
    "- All fan-out is owned by the parent MyOS Dispatch orchestrator; if more lanes are needed, report that as a finding.",
    "- Do not commit, apply patches to the source checkout, publish, or change Git configuration.",
    "- Do not access the source checkout. Work only in this worktree; one owner per file.",
    "- Report verification commands and their real results. Your report is not independent review.",
    "- Keep edits narrow and produce a clean patch artifact.",
    "- Return concise findings, changed files, verification result, and blockers.",
    `Execution envelope: ${JSON.stringify(task.executionEnvelope || {})}.`,
    STRUCTURED_RESULT_CONTRACT,
    "Your context will be discarded after this subtask.",
    "",
    "Subtask:",
    task.prompt || "",
  ].join("\n");
}

function buildBackgroundWorkerInvocation(task = {}, options = {}) {
  const command = options.command || "codex";
  const kind = normalizeWorkerKind(command);
  const cwd = options.cwd || task.scope || process.cwd();
  const model = resolveTaskModel(task, options);
  const readOnly = task.effectiveMode !== EXECUTION_MODES.WRITE;
  const prompt = readOnly ? buildReadOnlyPrompt(task) : buildWritablePrompt(task);

  assertProviderAffinity(kind, options, task);
  if (kind === "claude" && !readOnly) throw new Error("Claude code authoring is disabled.");
  if (!isUnattendedContext(options.env || process.env)) {
    assertOauthOnlyWorker(kind, options);
  }
  if (kind === "gemini" && !isUnattendedContext(options.env || process.env)) {
    assertGeminiOauthOnly(options);
  }

  if (kind === "claude") {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--permission-mode",
      readOnly ? "plan" : "acceptEdits",
      "--no-session-persistence",
      "--tools",
      readOnly ? "Read,Grep,Glob,LS" : "Read,Grep,Glob,LS,Edit,MultiEdit,Write",
    ];
    if (model) args.push("--model", model);
    return { kind, command, args, cwd, input: "", model: model || null, readOnly };
  }

  if (kind === "gemini") {
    const args = [
      "--prompt",
      prompt,
      "--approval-mode",
      readOnly ? "plan" : "auto-edit",
      "--sandbox",
      "--skip-trust",
      "--output-format",
      "json",
    ];
    if (model) args.push("--model", model);
    return { kind, command, args, cwd, input: "", model: model || null, readOnly };
  }

  const args = [
    "-a",
    "never",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "-s",
    readOnly ? "read-only" : "workspace-write",
  ];
  args.push("-c", "sandbox_workspace_write.network_access=false", "-c", "sandbox_workspace_write.writable_roots=[]");
  if (!isUnattendedContext(options.env || process.env)) {
    args.push("-c", 'forced_login_method="chatgpt"', "-c", 'model_provider="openai"');
  }
  if (cwd) args.push("-C", cwd);
  if (model) args.push("-m", model);
  args.push("-");
  return { kind, command, args, cwd, input: prompt, model: model || null, readOnly };
}

function runCommand({ command, args, cwd, input, timeoutMs, env }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd, stdio: ["pipe", "pipe", "pipe"], env: env || process.env,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer;
    const stop = (signal) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) { if (error.code !== "ESRCH") child.kill(signal); }
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      stderr += `\nTimed out after ${timeoutMs || DEFAULT_TIMEOUT_MS}ms`;
      stop("SIGTERM");
      killTimer = setTimeout(() => stop("SIGKILL"), 2000);
    }, Number(timeoutMs || DEFAULT_TIMEOUT_MS));
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") stderr += `\n${error.message}`; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      resolve({ code: null, signal: null, stdout, stderr: error.message });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      // Close means inherited output pipes have closed too. Capture only now.
      resolve({ code: timedOut ? null : code, signal: timedOut ? "SIGTERM" : signal, stdout, stderr });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function stringifyJsonValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(stringifyJsonValue).filter(Boolean).join("\n");
  if (typeof value === "object") {
    if (value.text) return stringifyJsonValue(value.text);
    if (value.content) return stringifyJsonValue(value.content);
    if (value.result) return stringifyJsonValue(value.result);
    if (value.response) return stringifyJsonValue(value.response);
    if (value.message) return stringifyJsonValue(value.message);
    if (value.candidates) return stringifyJsonValue(value.candidates);
    return JSON.stringify(value);
  }
  return String(value);
}

function extractBackgroundSummary(stdout = "", kind = "codex") {
  const text = String(stdout || "").trim();
  if (!text) return "";
  if (kind === "codex") {
    const parsed = parseCodexJsonl(text);
    return parsed.summary || parsed.errorMessage || text;
  }
  try {
    const parsed = JSON.parse(text);
    return stringifyJsonValue(parsed).trim() || text;
  } catch {
    return text;
  }
}

function parseStructuredFindings(summary = "") {
  const text = String(summary || "");
  let searchFrom = text.length;
  while (searchFrom > 0) {
    const keyIndex = text.lastIndexOf('"findings"', searchFrom);
    if (keyIndex === -1) return null;
    searchFrom = keyIndex - 1;
    const start = text.lastIndexOf("{", keyIndex);
    if (start === -1) continue;
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (!Array.isArray(parsed.findings)) continue;
      return {
        findings: parsed.findings
          .filter((finding) => finding && (finding.file || finding.note))
          .map((finding) => ({
            file: String(finding.file || ""),
            note: String(finding.note || ""),
          })),
        risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
        checks: Array.isArray(parsed.checks) ? parsed.checks.map(String) : [],
        confidence: ["low", "medium", "high"].includes(parsed.confidence) ? parsed.confidence : null,
      };
    } catch {
      continue;
    }
  }
  return null;
}

function validateWriterResponse(result, kind) {
  if (!result || result.code !== 0 || result.signal) return { error: "provider_failed" };
  try {
    const events = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    if (kind !== "codex" || !events.some((event) => event?.type === "turn.completed") ||
        events.some((event) => !event || typeof event.type !== "string" || ["error", "turn.failed"].includes(event.type))) {
      return { error: "provider_response_incomplete_or_failed" };
    }
    const parsed = parseCodexJsonl(result.stdout);
    const finalLine = parsed.summary.trim().split(/\r?\n/).filter(Boolean).at(-1);
    const report = JSON.parse(finalLine);
    if (!report || !Array.isArray(report.findings) ||
        !report.findings.every((item) => item && typeof item.file === "string" && typeof item.note === "string") ||
        !Array.isArray(report.risks) || !report.risks.every((item) => typeof item === "string") ||
        !Array.isArray(report.checks) || !report.checks.every((item) => typeof item === "string") ||
        !["low", "medium", "high"].includes(report.confidence)) {
      return { error: "malformed_writer_report" };
    }
    const reportedModels = [...new Set(events.flatMap((event) => typeof event.model === "string" ? [event.model] : []))];
    return { report, reportedModels };
  } catch {
    return { error: "malformed_provider_response" };
  }
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

let activeSidecarCount = 0;
const sidecarSlotWaiters = [];

function resolveMaxConcurrentSidecars(env = process.env) {
  return clampNumber(env?.MYOS_BACKGROUND_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT_SIDECARS, 1, 20);
}

async function acquireSidecarSlot(env) {
  const max = resolveMaxConcurrentSidecars(env);
  while (activeSidecarCount >= max) {
    await new Promise((resolve) => sidecarSlotWaiters.push(resolve));
  }
  activeSidecarCount += 1;
}

function releaseSidecarSlot() {
  activeSidecarCount = Math.max(0, activeSidecarCount - 1);
  const next = sidecarSlotWaiters.shift();
  if (next) next();
}

function freeDiskGib(targetPath) {
  try {
    const stats = fs.statfsSync(targetPath || process.env.HOME || os.homedir());
    return (stats.bavail * stats.bsize) / (1024 ** 3);
  } catch {
    return null;
  }
}

function detectHostBackpressure(options = {}) {
  const env = options.env || process.env;
  if (String(env?.MYOS_BACKGROUND_BACKPRESSURE_ENABLED || "1") === "0") return null;
  const maxLoad = clampNumber(env?.MYOS_BACKGROUND_MAX_LOAD, DEFAULT_MAX_LOAD_AVG, 1, 128);
  const load = os.loadavg()[0];
  if (load > maxLoad) {
    return { reason: "host_backpressure", detail: `1m load average ${load.toFixed(1)} exceeds ${maxLoad}` };
  }
  return null;
}

function cleanupOrphanSidecarWorktrees() {
  // Age is not proof of review or integration. Only the owning orchestrator
  // may retire a retained handback after independent review and preservation.
  return { removed: 0, reason: "explicit_review_required" };
}

function plannedResult(task, reason = "Background task planned but not executed.") {
  return {
    taskId: task.id,
    taskKind: task.kind || null,
    role: task.role || task.kind || null,
    required: Boolean(task.required),
    mode: task.mode || EXECUTION_MODES.READ_ONLY,
    effectiveMode: task.effectiveMode || task.mode || EXECUTION_MODES.READ_ONLY,
    status: "planned",
    summary: reason,
    findings: [],
    confidence: "not_run",
    artifacts: [],
    durationMs: 0,
    usage: null,
    model: null,
    runner: null,
  };
}

function skippedResult(task, reason, extra = {}) {
  return {
    taskId: task.id,
    taskKind: task.kind || null,
    role: task.role || task.kind || null,
    required: Boolean(task.required),
    mode: task.mode || EXECUTION_MODES.READ_ONLY,
    effectiveMode: task.effectiveMode || task.mode || EXECUTION_MODES.READ_ONLY,
    status: "skipped",
    summary: reason,
    findings: [],
    confidence: "not_run",
    artifacts: [],
    durationMs: 0,
    usage: null,
    model: null,
    runner: null,
    ...extra,
  };
}

function isReadOnlyTask(task = {}) {
  return task.effectiveMode === EXECUTION_MODES.READ_ONLY ||
    (Array.isArray(task.writeScope) && task.writeScope.length === 0);
}

function gitExec(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}


function validateOwnershipPaths(repoRoot, paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("ownership paths are required");
  const root = fs.realpathSync(repoRoot);
  return [...new Set(paths.map((entry) => {
    if (typeof entry !== "string" || !entry || /[\\\x00-\x1f]/.test(entry) || entry.split("/").includes("..")) {
      throw new Error(`invalid ownership path: ${entry}`);
    }
    const relative = path.relative(root, path.resolve(root, entry)).split(path.sep).join("/");
    if (!relative || relative === ".." || relative.startsWith("../") || relative.split("/").some((part) => part.toLowerCase() === ".git")) {
      throw new Error(`ownership_scope_outside_repository:${entry}`);
    }
    let current = root;
    for (const part of relative.split("/")) {
      current = path.join(current, part);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`ownership_symlink_refused:${entry}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return relative;
  }))];
}

function resolveWritableWorktree(task = {}, options = {}) {
  const scope = task.scope || options.cwd || process.cwd();
  let repoRoot;
  try {
    repoRoot = gitExec(["rev-parse", "--show-toplevel"], scope);
  } catch {
    return null;
  }
  const ownershipPaths = validateOwnershipPaths(repoRoot, task.ownershipPaths);
  cleanupOrphanSidecarWorktrees(repoRoot);
  if (gitExec(["status", "--porcelain"], repoRoot)) return null;
  const baseSha = gitExec(["rev-parse", "HEAD"], repoRoot);
  const runId = String(options.orchestratorContext?.runId || "unscoped-run").replace(/[^a-zA-Z0-9_-]/g, "_");
  const defaultArtifactRoot = path.join(
    (options.env || process.env).MYOS_HOME_ROOT || path.join(os.homedir(), ".myos"),
    "state", "myos-dispatch", "sidecar-artifacts", runId,
  );
  const requestedRoot = path.resolve(options.artifactRoot || defaultArtifactRoot);
  let existing = requestedRoot;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const canonicalRoot = path.resolve(fs.realpathSync(existing), path.relative(existing, requestedRoot));
  const relativeRoot = path.relative(fs.realpathSync(repoRoot), canonicalRoot);
  if (!relativeRoot || (!relativeRoot.startsWith(`..${path.sep}`) && relativeRoot !== ".." && !path.isAbsolute(relativeRoot))) {
    throw new Error("Artifact root must be outside the source checkout");
  }
  fs.mkdirSync(canonicalRoot, { recursive: true });
  const artifactRoot = fs.mkdtempSync(path.join(canonicalRoot, "handback-"));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "myos-sidecar-writer-"));
  try {
    gitExec(["worktree", "add", "--detach", tempRoot, baseSha], repoRoot);
  } catch (error) {
    // Preserve even an incomplete allocation; never assume a failed Git operation wrote nothing.
    throw new Error(`Cannot create isolated worktree; retained ${tempRoot}: ${error.message}`);
  }
  return { repoRoot, baseSha, worktreePath: tempRoot, artifactRoot, ownershipPaths };
}


function verifyPatchArtifact(file, expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 || "")) throw new Error("Invalid patch SHA256");
  const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (actual !== expectedSha256) throw new Error("Patch hash mismatch; independent review is invalidated");
  return true;
}

function collectWorktreeArtifacts(context, task = {}) {
  if (!context?.worktreePath || !context?.baseSha) {
    return { changedFiles: [], patchArtifact: null, patchSha256: null, verificationResult: null };
  }
  fs.mkdirSync(context.artifactRoot, { recursive: true });
  const indexPath = path.join(context.artifactRoot, `capture-${crypto.randomUUID()}.index`);
  const git = (args, encoding = "utf8") => execFileSync("git", args, {
    cwd: context.worktreePath, encoding, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_INDEX_FILE: indexPath }, stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    git(["read-tree", context.baseSha]);
    git(["add", "-A"]);
    const changedFiles = git(["diff", "--cached", "--no-renames", "--name-only", "-z", context.baseSha, "--"]).split("\0").filter(Boolean);
    const allowedRoots = context.ownershipPaths || validateOwnershipPaths(context.repoRoot, task.ownershipPaths);
    const ownershipViolations = changedFiles.filter((file) => !allowedRoots.some((root) => file === root || file.startsWith(`${root}/`)));
    const patch = git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", "--full-index", context.baseSha, "--"], null);
    let patchArtifact = null;
    let patchSha256 = null;
    let verificationResult = "no_changes";
    if (changedFiles.length) {
      patchArtifact = path.join(context.artifactRoot, "changes.patch");
      fs.writeFileSync(patchArtifact, patch, { flag: "wx", mode: 0o600 });
      patchSha256 = crypto.createHash("sha256").update(patch).digest("hex");
      verifyPatchArtifact(patchArtifact, patchSha256);
      git(["apply", "--check", "--cached", "--reverse", patchArtifact]);
      verificationResult = "patch_reverse_check_passed";
    }
    if (ownershipViolations.length) verificationResult = `ownership_violation:${ownershipViolations.join(",")}`;
    try { validateOwnershipPaths(context.worktreePath, changedFiles.length ? changedFiles : allowedRoots); }
    catch (error) { verificationResult = error.message; }
    return { changedFiles, ownedChangedFiles: changedFiles.filter((file) => !ownershipViolations.includes(file)), ownershipViolations, patchArtifact, patchSha256, verificationResult };
  } finally {
    // This is a temporary capture index, never the writer's real index or work.
    fs.rmSync(indexPath, { force: true });
  }
}

function effectiveModeForTask(task = {}, options = {}) {
  const requested = task.mode || EXECUTION_MODES.READ_ONLY;
  if (requested !== EXECUTION_MODES.WRITE) return EXECUTION_MODES.READ_ONLY;
  const env = options.env || process.env;
  if (String(env?.MYOS_ORCHESTRATION_GOLD_ENABLED ?? "1") === "0") return EXECUTION_MODES.READ_ONLY;
  if (String(env?.MYOS_WRITABLE_SIDECARS_ENABLED ?? "1") === "0") return EXECUTION_MODES.READ_ONLY;
  if (isUnattendedContext(options.env || process.env)) return EXECUTION_MODES.READ_ONLY;
  const runner = normalizeWorkerKind(options.command || "codex");
  const capabilities = resolveProviderCapabilities(runner, options);
  if (!capabilities.supportsWritablePatchWorktree) return EXECUTION_MODES.READ_ONLY;
  const minFreeGib = clampNumber(env?.MYOS_BACKGROUND_MIN_FREE_DISK_GIB, DEFAULT_MIN_FREE_DISK_GIB_FOR_WRITABLE, 0, 1024);
  const freeGib = freeDiskGib(task.scope || options.cwd);
  if (freeGib != null && freeGib < minFreeGib) return EXECUTION_MODES.READ_ONLY;
  return EXECUTION_MODES.WRITE;
}

async function runBackgroundTask(task, options = {}) {
  if (backgroundAgentsDisabled(options.env || process.env)) {
    return skippedResult(task, "Skipped: background agents disabled by MYOS_BACKGROUND_AGENTS_ENABLED=0.", {
      runner: normalizeWorkerKind(options.command || "codex"),
    });
  }
  assertOrchestratedTask(options);
  const effectiveMode = effectiveModeForTask(task, options);
  const normalizedTask = { ...task, effectiveMode };
  const orchestratorContext = createOrchestratorContext(options);
  const started = Date.now();
  if (task.mode === EXECUTION_MODES.WRITE && effectiveMode !== EXECUTION_MODES.WRITE) {
    return skippedResult(normalizedTask, "Writable task refused: execution is disabled or unsafe in this context.", {
      status: task.required ? "failed" : "skipped",
      confidence: task.required ? "failed" : "not_run",
      runner: normalizeWorkerKind(options.command || "codex"),
      capabilityEvidence: "writablePatchWorktreeUnavailable",
    });
  }

  let worktree = null;
  if (effectiveMode === EXECUTION_MODES.WRITE) {
    try {
      // Refuse invalid callers before allocating a worktree or running any provider.
      assertProviderAffinity(normalizeWorkerKind(options.command || "codex"), options, normalizedTask);
      worktree = resolveWritableWorktree(normalizedTask, { ...options, orchestratorContext });
    } catch (error) {
      return skippedResult(normalizedTask, `Writable task refused: ${error.message}`, { status: "failed", reviewRequired: true });
    }
    if (!worktree) {
      return skippedResult(normalizedTask, "Writable task refused: repository is dirty, unavailable, or cannot create an isolated worktree.", {
        status: normalizedTask.required ? "failed" : "skipped",
        confidence: normalizedTask.required ? "failed" : "not_run",
        runner: normalizeWorkerKind(options.command || "codex"),
        capabilityEvidence: "writablePatchWorktreeUnavailable",
      });
    }
  }

  if (worktree) {
    normalizedTask.ownershipPaths = worktree.ownershipPaths;
    normalizedTask.writeScope = worktree.ownershipPaths;
    normalizedTask.scope = worktree.worktreePath;
  }
  let invocation;
  try {
    invocation = buildBackgroundWorkerInvocation(normalizedTask, {
      ...options,
      cwd: worktree?.worktreePath || normalizedTask.scope || options.cwd,
    });
  } catch (error) {
    return skippedResult(normalizedTask, `Skipped: ${error?.message || String(error)}`, {
      ...(worktree ? { status: "failed", worktreePath: worktree.worktreePath, baseSha: worktree.baseSha, reviewRequired: true } : {}),
      runner: normalizeWorkerKind(options.command || "codex"),
    });
  }

  const runCommandImpl = options.runCommand || runCommand;
  const unattended = isUnattendedContext(options.env || process.env);
  const authEnv = invocation.kind === "codex"
    ? (isUnattendedContext(options.env || process.env)
        ? buildCodexApiKeyEnv(options.env || process.env)
        : buildCodexOauthEnv(options.env || process.env))
    : { ...(options.env || process.env) };
  const childEnv = sanitizeSidecarEnv(authEnv, {
    kind: invocation.kind,
    unattended,
  });
  childEnv.MYOS_BACKGROUND_PROVIDER = invocation.kind;
  childEnv.MYOS_BACKGROUND_EXECUTION_MODE = normalizedTask.effectiveMode;
  childEnv.MYOS_BACKGROUND_IS_SIDECAR = "1";
  childEnv.MYOS_BACKGROUND_ORCHESTRATOR = orchestratorContext.orchestrator;
  childEnv.MYOS_SIDECAR_ORCHESTRATED = "1";
  childEnv.MYOS_SIDECAR_RUN_ID = orchestratorContext.runId;
  childEnv.MYOS_SIDECAR_TASK_ID = normalizedTask.id || "";
  childEnv.MYOS_SIDECAR_PARENT_TASK_ID = orchestratorContext.parentTaskId || "root";
  childEnv.MYOS_SIDECAR_ORCHESTRATOR_TOKEN = orchestratorContext.token;
  childEnv.MYOS_BACKGROUND_AGENTS_ENABLED = "0";
  if (invocation.kind === "codex") {
    assertNoAnthropicKeysInChildEnv(childEnv, normalizedTask.id);
  }

  await acquireSidecarSlot(options.env || process.env);
  let result;
  try {
    try {
      result = await runCommandImpl({
        command: invocation.command,
        args: invocation.args,
        cwd: invocation.cwd,
        input: invocation.input,
        env: childEnv,
        timeoutMs: Number(task.timeoutMs || options.timeoutMs || DEFAULT_TIMEOUT_MS),
        invocation,
        task: normalizedTask,
        worktree,
      });
    } catch (error) {
      result = {
        code: null,
        signal: null,
        stdout: "",
        stderr: error?.message || String(error),
      };
    }
  } finally {
    releaseSidecarSlot();
  }
  result = result && typeof result === "object" ? result : { code: null, stderr: "Missing provider result" };
  const writerResponse = worktree ? validateWriterResponse(result, invocation.kind) : null;
  const summary = extractBackgroundSummary(result.stdout, invocation.kind);
  const structured = parseStructuredFindings(summary);
  let ok = result.code === 0 && !result.signal && !writerResponse?.error;
  if (writerResponse?.reportedModels?.some((model) => model !== invocation.model)) ok = false;
  const artifacts = [];
  let changedFiles = [];
  let patchArtifact = null;
  let patchSha256 = null;
  let verificationResult = null;
  let ownedChangedFiles = [];
  let ownershipViolations = [];

  if (normalizedTask.effectiveMode === EXECUTION_MODES.WRITE && worktree) {
    try {
      const collected = collectWorktreeArtifacts(worktree, normalizedTask);
      changedFiles = collected.changedFiles;
      ownedChangedFiles = collected.ownedChangedFiles;
      ownershipViolations = collected.ownershipViolations;
      patchArtifact = collected.patchArtifact;
      patchSha256 = collected.patchSha256;
      verificationResult = collected.verificationResult;
      if (patchArtifact) artifacts.push({ kind: "patch", path: patchArtifact, sha256: patchSha256 });
      if (!changedFiles.length || verificationResult !== "patch_reverse_check_passed") ok = false;
    } catch (error) {
      ok = false;
      changedFiles = [];
      verificationResult = `artifact_error:${error.message}`;
    }
  }

  const response = {
    taskId: normalizedTask.id,
    taskKind: normalizedTask.kind || null,
    role: normalizedTask.role || normalizedTask.kind || null,
    agentProfile: normalizedTask.agentProfile || null,
    required: Boolean(normalizedTask.required),
    mode: normalizedTask.mode || EXECUTION_MODES.READ_ONLY,
    effectiveMode: normalizedTask.effectiveMode || EXECUTION_MODES.READ_ONLY,
    status: ok ? (worktree ? "needs-review" : "completed") : "failed",
    summary: summary || result.stderr || (ok ? "Completed with no output" : "Background task failed"),
    findings: structured?.findings || [],
    risks: structured?.risks || [],
    checks: structured?.checks || [],
    confidence: ok ? (structured?.confidence || "medium") : "failed",
    artifacts,
    durationMs: Date.now() - started,
    usage: null,
    model: invocation.model || null,
    runner: invocation.kind,
    orchestrator: orchestratorContext.orchestrator,
    sidecarRunId: orchestratorContext.runId,
    parentTaskId: orchestratorContext.parentTaskId || "root",
    stderr: result.stderr || "",
    ownershipPaths: Array.isArray(normalizedTask.ownershipPaths) ? normalizedTask.ownershipPaths : [],
    writeScope: Array.isArray(normalizedTask.writeScope) ? normalizedTask.writeScope : [],
    reviewRequired: Boolean(worktree),
    requestedModel: normalizedTask.model || null,
    resolvedModel: invocation.model || null,
    providerReportedModel: writerResponse?.reportedModels?.length === 1 ? writerResponse.reportedModels[0] : null,
    providerResponseError: writerResponse?.error || null,
    baseSha: worktree?.baseSha || null,
    worktreePath: worktree?.worktreePath || null,
    artifactRoot: worktree?.artifactRoot || null,
    patchArtifact,
    patchSha256,
    changedFiles,
    ownedChangedFiles,
    ownershipViolations,
    verificationResult,
    verificationEvidence: { patch: verificationResult, providerResponse: writerResponse?.error || (worktree ? "valid_structured_response" : "not_checked"), writerReportedChecks: structured?.checks || [], independentReview: "pending" },
    executionEnvelope: normalizedTask.executionEnvelope || null,
    capabilityEvidence: normalizedTask.effectiveMode === EXECUTION_MODES.WRITE ? "writablePatchWorktree" : "readOnlySidecars",
  };


  return response;
}

const DIGEST_SUMMARY_CHARS = 1200;

function buildBackgroundDigest(results = [], options = {}) {
  const completed = results.filter((result) => result && ["completed", "needs-review", "failed", "skipped"].includes(result.status));
  if (!completed.length) return "";
  const summaryChars = Number(options.summaryChars || DIGEST_SUMMARY_CHARS);
  const lines = completed.map((result) => {
    const files = Array.isArray(result.changedFiles) && result.changedFiles.length > 0
      ? ` changedFiles=${result.changedFiles.join(",")}`
      : "";
    const verify = result.verificationResult ? ` verification=${result.verificationResult}` : "";
    const findings = Array.isArray(result.findings) && result.findings.length > 0
      ? `\n${result.findings.slice(0, 8).map((finding) => `  - ${finding.file ? `${finding.file}: ` : ""}${finding.note}`).join("\n")}`
      : "";
    return `- ${result.taskId} [${result.runner || "none"} ${result.effectiveMode || result.mode || "read_only"} ${result.status}] ${String(result.summary || "").replace(/\s+/g, " ").slice(0, summaryChars)}${files}${verify}${findings}`;
  });
  if (options.artifactPath) {
    lines.push(`Full sidecar results: ${options.artifactPath}`);
  }
  return lines.join("\n");
}

function persistSidecarResults(results = [], options = {}) {
  if (!options.file || !Array.isArray(results) || results.length === 0) return null;
  try {
    fs.mkdirSync(path.dirname(options.file), { recursive: true });
    fs.writeFileSync(options.file, `${JSON.stringify({
      updatedAt: new Date().toISOString(),
      results,
    }, null, 2)}\n`, "utf8");
    return options.file;
  } catch {
    return null;
  }
}

function startBackgroundTasks(plan = {}, options = {}) {
  const tasks = Array.isArray(plan?.backgroundTasks) ? plan.backgroundTasks : [];
  if (!tasks.length) {
    const empty = Promise.resolve([]);
    return { requiredPromise: empty, allPromise: empty, selectedTasks: [] };
  }

  if (backgroundAgentsDisabled(options.env || process.env)) {
    const results = tasks.map((task) => plannedResult(task, "Background execution disabled by MYOS_BACKGROUND_AGENTS_ENABLED=0."));
    const resolved = Promise.resolve(results);
    return { requiredPromise: resolved, allPromise: resolved, selectedTasks: tasks };
  }
  const enabled = Boolean(options.enabled);
  if (!enabled) {
    const results = tasks.map((task) => plannedResult(task, "Background execution disabled by runtime configuration."));
    const resolved = Promise.resolve(results);
    return { requiredPromise: resolved, allPromise: resolved, selectedTasks: tasks };
  }
  if (LEGACY_METADATA_ONLY_MODES.has(plan?.mode)) {
    const results = tasks.map((task) => plannedResult(task, "Legacy observe mode is metadata-only."));
    const resolved = Promise.resolve(results);
    return { requiredPromise: resolved, allPromise: resolved, selectedTasks: tasks };
  }
  if (plan?.mode === EXECUTION_MODES.NONE || !tasks.length) {
    const resolved = Promise.resolve([]);
    return { requiredPromise: resolved, allPromise: resolved, selectedTasks: [] };
  }

  const selected = tasks.slice(0, Math.max(0, Number(plan?.budget?.maxAgents || tasks.length)));
  if (isSidecarProcess(options.env || process.env)) {
    const results = selected.map((task) => skippedResult(
      task,
      "Skipped: nested background fan-out is blocked; all sidecars must be issued by the parent MyOS Dispatch orchestrator.",
    ));
    const resolved = Promise.resolve(results);
    return { requiredPromise: resolved, allPromise: resolved, selectedTasks: selected };
  }
  const backpressure = detectHostBackpressure(options);
  if (backpressure) {
    const results = selected.map((task) => skippedResult(
      task,
      `Skipped: ${backpressure.reason} (${backpressure.detail}).`,
    ));
    const resolved = Promise.resolve(results);
    return { requiredPromise: resolved, allPromise: resolved, selectedTasks: selected };
  }
  const state = readVersionState({ stateFile: options.parallelizationStateFile || options.stateFile });
  const runner = normalizeWorkerKind(options.command || "codex");
  const providerQuarantine = isParallelizationTargetQuarantined(state, "provider", runner, {
    now: options.now,
  });
  if (providerQuarantine) {
    const results = selected.map((task) => skippedResult(
      task,
      `Skipped: background provider ${runner} is quarantined until ${providerQuarantine.until}. Repair action: ${providerQuarantine.repairActionId || "none"}.`,
      { runner },
    ));
    const resolved = Promise.resolve(results);
    return { requiredPromise: resolved, allPromise: resolved, selectedTasks: selected };
  }

  const orchestratorContext = createOrchestratorContext(options);
  const resultPromises = selected.map((task) => {
    const taskKindQuarantine = isParallelizationTargetQuarantined(state, "taskKind", task.kind, {
      now: options.now,
    });
    if (taskKindQuarantine) {
      return Promise.resolve(skippedResult(
        task,
        `Skipped: background task kind ${task.kind} is quarantined until ${taskKindQuarantine.until}. Repair action: ${taskKindQuarantine.repairActionId || "none"}.`,
        { runner },
      ));
    }
    return runBackgroundTask(task, {
      ...options,
      orchestratorContext,
    });
  });

  // Only explicitly required tasks block the caller. Plans with no required
  // tasks are fully non-blocking; their results arrive via allPromise.
  const requiredPromises = selected
    .map((task, index) => (task.required === true ? resultPromises[index] : null))
    .filter(Boolean);
  return {
    requiredPromise: Promise.all(requiredPromises),
    allPromise: Promise.all(resultPromises),
    selectedTasks: selected,
  };
}

async function runBackgroundTasks(plan = {}, options = {}) {
  return startBackgroundTasks(plan, options).allPromise;
}

module.exports = {
  ANTHROPIC_ENV_KEYS,
  assertGeminiOauthOnly,
  assertNoAnthropicKeysInChildEnv,
  assertOauthOnlyWorker,
  assertProviderAffinity,
  buildBackgroundDigest,
  cleanupOrphanSidecarWorktrees,
  collectWorktreeArtifacts,
  detectHostBackpressure,
  parseStructuredFindings,
  persistSidecarResults,
  buildCodexApiKeyEnv,
  buildCodexOauthEnv,
  buildBackgroundWorkerInvocation,
  buildReadOnlyPrompt,
  buildWritablePrompt,
  createOrchestratorContext,
  effectiveModeForTask,
  extractBackgroundSummary,
  findGeminiApiKeyEnv,
  isUnattendedContext,
  isSidecarProcess,
  normalizeWorkerKind,
  sanitizeSidecarEnv,
  resolveBackgroundModel,
  resolveOptionalSidecarGraceMs,
  resolveProviderCapabilities,
  verifyPatchArtifact,
  validateOwnershipPaths,
  runCommand,
  runBackgroundTask,
  runBackgroundTasks,
  startBackgroundTasks,
  EXECUTION_MODES,
};

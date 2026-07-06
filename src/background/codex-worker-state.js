"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { resolveStateRoot } = require("../myos-compat");

const CODEX_STATE_ROOT = resolveStateRoot("codex-worker");
const SESSION_DIR = path.join(CODEX_STATE_ROOT, "sessions");
const EVENT_LOG_PATH = path.join(CODEX_STATE_ROOT, "events.jsonl");
const DEFAULT_RETRY_DELAY_MS = 60 * 60 * 1000;

const PAUSE_PATTERNS = [
  /usage limit/i,
  /rate limit/i,
  /quota/i,
  /too many requests/i,
  /\b429\b/,
  /try again in/i,
];

function ensureStateDirs() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function slugify(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "codex-task";
}

function sessionFilePath(taskId) {
  ensureStateDirs();
  return path.join(SESSION_DIR, `${taskId}.json`);
}

function readSessionState(taskId) {
  try {
    return JSON.parse(fs.readFileSync(sessionFilePath(taskId), "utf8"));
  } catch {
    return null;
  }
}

function writeSessionState(state) {
  const payload = {
    ...state,
    updated_at: nowIso(),
  };
  fs.writeFileSync(sessionFilePath(payload.task_id), JSON.stringify(payload, null, 2));
  return payload;
}

function appendEvent(event) {
  ensureStateDirs();
  const payload = {
    event_id: event.event_id || randomUUID(),
    at: event.at || nowIso(),
    ...event,
  };
  fs.appendFileSync(EVENT_LOG_PATH, `${JSON.stringify(payload)}\n`);
  return payload;
}

function parseRetryDelayMs(text) {
  const source = String(text || "");
  if (!source) return null;

  const compact = source.match(/try again in\s+(\d+)\s*h(?:ours?)?\s*(\d+)?\s*m?/i);
  if (compact) {
    const hours = Number(compact[1] || 0);
    const minutes = Number(compact[2] || 0);
    return ((hours * 60) + minutes) * 60 * 1000;
  }

  const hoursOnly = source.match(/try again in\s+(\d+(?:\.\d+)?)\s*hours?/i);
  if (hoursOnly) {
    return Math.ceil(Number(hoursOnly[1]) * 60) * 60 * 1000;
  }

  const minutesOnly = source.match(/try again in\s+(\d+(?:\.\d+)?)\s*minutes?/i);
  if (minutesOnly) {
    return Math.ceil(Number(minutesOnly[1])) * 60 * 1000;
  }

  const hms = source.match(/(\d+)\s*h(?:ours?)?\s*(\d+)\s*m(?:in(?:utes?)?)?/i);
  if (hms && /try again in/i.test(source)) {
    return ((Number(hms[1]) * 60) + Number(hms[2])) * 60 * 1000;
  }

  return null;
}

function classifyPauseText(text) {
  const source = String(text || "").trim();
  if (!source) return null;
  if (!PAUSE_PATTERNS.some((pattern) => pattern.test(source))) return null;

  if (/usage limit|quota/i.test(source)) {
    return "usage_limit";
  }
  if (/rate limit|too many requests|\b429\b/i.test(source)) {
    return "rate_limit";
  }
  return "temporary_pause";
}

function detectPauseCondition({ parsed, stderr, stdout, fallbackError }) {
  const candidates = [
    parsed?.errorMessage,
    fallbackError,
    stderr,
    stdout,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const reason = classifyPauseText(candidate);
    if (!reason) continue;
    return {
      isPaused: true,
      reason,
      retryDelayMs: parseRetryDelayMs(candidate) || DEFAULT_RETRY_DELAY_MS,
      errorExcerpt: String(candidate).trim().split(/\r?\n/).filter(Boolean).slice(0, 3).join(" | ").slice(0, 500),
    };
  }

  return {
    isPaused: false,
    reason: null,
    retryDelayMs: null,
    errorExcerpt: String(fallbackError || parsed?.errorMessage || stderr || "").trim().split(/\r?\n/).filter(Boolean).slice(0, 3).join(" | ").slice(0, 500),
  };
}

function buildTaskId(options = {}) {
  if (options.taskId) return slugify(options.taskId);
  if (options.chatId) return slugify(`chat-${options.chatId}`);
  if (options.displayName) return slugify(options.displayName);
  return `codex-${Date.now()}`;
}

function buildBaseState(options = {}) {
  return {
    task_id: buildTaskId(options),
    session_id: options.sessionId || null,
    status: "starting",
    task_label: String(options.taskLabel || options.displayName || options.chatId || "Codex task"),
    runner: {
      command: String(options.command || "codex"),
      cwd: String(options.cwd || process.env.HOME || os.homedir()),
      model: options.model ? String(options.model) : null,
      timeout_ms: Number(options.timeoutMs || 20 * 60 * 1000),
      source_label: options.sourceLabel ? String(options.sourceLabel) : null,
    },
    request: {
      chat_id: options.chatId ? String(options.chatId) : null,
      display_name: options.displayName ? String(options.displayName) : null,
      system_prompt: String(options.systemPrompt || ""),
      user_text: String(options.userText || ""),
    },
    retry: {
      count: 0,
      next_retry_at: null,
      last_error_at: null,
      paused_at: null,
      resumed_at: null,
      resolved_at: null,
      pause_reason: null,
      raw_error_excerpt: null,
    },
    artifacts: [],
    usage: {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
    },
    created_at: nowIso(),
  };
}

function markStarted(existingState, options = {}) {
  const state = existingState || buildBaseState(options);
  state.status = options.sessionId ? "resuming" : "running";
  state.session_id = options.sessionId || state.session_id || null;
  state.last_started_at = nowIso();
  writeSessionState(state);
  appendEvent({
    type: options.sessionId ? "session.resume_started" : "session.started",
    task_id: state.task_id,
    session_id: state.session_id,
    status: state.status,
  });
  return state;
}

function markCompleted(state, result = {}) {
  const nextState = {
    ...state,
    status: "completed",
    session_id: result.sessionId || state.session_id || null,
    artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
    usage: {
      input_tokens: Number(result.usage?.inputTokens || 0),
      cached_input_tokens: Number(result.usage?.cachedInputTokens || 0),
      output_tokens: Number(result.usage?.outputTokens || 0),
    },
    retry: {
      ...state.retry,
      next_retry_at: null,
      resumed_at: state.status === "resuming" ? nowIso() : state.retry?.resumed_at || null,
      resolved_at: nowIso(),
      raw_error_excerpt: null,
    },
  };
  writeSessionState(nextState);
  appendEvent({
    type: "session.completed",
    task_id: nextState.task_id,
    session_id: nextState.session_id,
    status: nextState.status,
  });
  return nextState;
}

function markPaused(state, pauseInfo = {}, nextSessionId = null) {
  const pausedAt = nowIso();
  const nextRetryAt = new Date(Date.now() + Number(pauseInfo.retryDelayMs || DEFAULT_RETRY_DELAY_MS)).toISOString();
  const retryCount = Number(state.retry?.count || 0) + 1;

  const nextState = {
    ...state,
    status: "paused",
    session_id: nextSessionId || state.session_id || null,
    retry: {
      ...state.retry,
      count: retryCount,
      paused_at: pausedAt,
      last_error_at: pausedAt,
      next_retry_at: nextRetryAt,
      pause_reason: pauseInfo.reason || "temporary_pause",
      raw_error_excerpt: pauseInfo.errorExcerpt || null,
    },
  };
  writeSessionState(nextState);
  appendEvent({
    type: "session.paused",
    task_id: nextState.task_id,
    session_id: nextState.session_id,
    status: nextState.status,
    pause_reason: nextState.retry.pause_reason,
    next_retry_at: nextState.retry.next_retry_at,
    raw_error_excerpt: nextState.retry.raw_error_excerpt,
  });
  return nextState;
}

function markFailed(state, errorMessage, nextSessionId = null) {
  const failedAt = nowIso();
  const nextState = {
    ...state,
    status: "failed",
    session_id: nextSessionId || state.session_id || null,
    retry: {
      ...state.retry,
      last_error_at: failedAt,
      raw_error_excerpt: String(errorMessage || "").trim() || null,
      next_retry_at: null,
    },
  };
  writeSessionState(nextState);
  appendEvent({
    type: "session.failed",
    task_id: nextState.task_id,
    session_id: nextState.session_id,
    status: nextState.status,
    raw_error_excerpt: nextState.retry.raw_error_excerpt,
  });
  return nextState;
}

function listDuePausedSessions(now = new Date()) {
  ensureStateDirs();
  const due = [];
  for (const entry of fs.readdirSync(SESSION_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const state = readSessionState(entry.name.replace(/\.json$/, ""));
    if (!state || state.status !== "paused") continue;
    const retryAt = Date.parse(state.retry?.next_retry_at || "");
    if (!Number.isFinite(retryAt)) continue;
    if (retryAt <= now.getTime()) due.push(state);
  }
  return due.sort((a, b) => Date.parse(a.retry?.next_retry_at || 0) - Date.parse(b.retry?.next_retry_at || 0));
}

module.exports = {
  CODEX_STATE_ROOT,
  DEFAULT_RETRY_DELAY_MS,
  EVENT_LOG_PATH,
  SESSION_DIR,
  appendEvent,
  buildBaseState,
  buildTaskId,
  detectPauseCondition,
  listDuePausedSessions,
  markCompleted,
  markFailed,
  markPaused,
  markStarted,
  parseRetryDelayMs,
  readSessionState,
  writeSessionState,
};

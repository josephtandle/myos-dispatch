// jev.js: zero-dependency Node 22+ client for TypeSafe's Jev (System One) decision API.
// createJevClient() -> { isConfigured, ask }; builders choice/noul/score throw on misuse;
// ask() never throws for expected failures, it resolves { ok:false, reason } instead.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-1.13.0';
const DEFAULT_ENV_FILE = path.join(os.homedir(), '.myos', 'workspace', '.env');
const REASONS = Object.freeze([
  'typesafe_key_missing', 'schema_error', 'auth_error', 'rate_limited',
  'overloaded', 'timeout', 'network_error', 'http_error',
]);

function readKeyFromEnvFile(file) {
  try {
    const m = fs.readFileSync(file, 'utf8').match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*)$/m);
    return m ? m[1].trim().replace(/^(["'])(.*)\1$/, '$2').trim() : '';
  } catch {
    return '';
  }
}

function resolveKey(opts) {
  if (opts.apiKey !== undefined) return String(opts.apiKey ?? '').trim();
  const fromEnv = (process.env.TYPESAFE_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  if (opts.envFile === false) return '';
  return readKeyFromEnvFile(opts.envFile || DEFAULT_ENV_FILE);
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isContent(v) {
  return (typeof v === 'string' && v.trim().length > 0) || (typeof v === 'object' && v !== null);
}

function checkInstructions(kind, instructions) {
  if (!isContent(instructions)) throw new TypeError(`${kind}: instructions must be a non-empty string, object or array`);
}

function choice(instructions, criteria) {
  checkInstructions('choice', instructions);
  if (!isPlainObject(criteria)) throw new TypeError('choice: criteria must be a plain object { optionName: description }');
  const names = Object.keys(criteria);
  if (names.length < 2) throw new TypeError('choice: criteria needs at least two options');
  for (const name of names) {
    if (!name.trim()) throw new TypeError('choice: option names must be non-empty strings');
    if (!isContent(criteria[name])) throw new TypeError(`choice: option "${name}" needs a non-empty description`);
  }
  return { type: 'choice', instructions, criteria };
}

function noul(instructions) {
  checkInstructions('noul', instructions);
  return { type: 'noul', instructions };
}

function score(instructions, levels) {
  checkInstructions('score', instructions);
  if (!Array.isArray(levels) || levels.length < 2 || levels.length > 10) throw new TypeError('score: levels must be an ordered array of 2 to 10 level descriptions');
  levels.forEach((lvl, i) => { if (!isContent(lvl)) throw new TypeError(`score: level ${i} must be a non-empty description`); });
  return { type: 'score', instructions, criteria: levels.slice() };
}

function decide(answer, { floor = 0 } = {}) {
  if (!answer || answer.type !== 'choice') throw new TypeError('decide: expects a choice answer');
  const confidence = Number(answer.confidence);
  return { choice: answer.choice, confidence, meetsFloor: Number.isFinite(confidence) && confidence >= floor };
}

function yes(answer, { threshold = 0.5 } = {}) {
  if (!answer || answer.type !== 'noul') throw new TypeError('yes: expects a noul answer');
  return Number(answer.noul) >= threshold;
}

function parseRetryAfter(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function backoffMs(result, attempt) {
  const ra = parseRetryAfter(result.retryAfter);
  if (ra !== null) return ra;
  const base = 300 * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * base * 0.5);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attemptOnce(fetchImpl, apiKey, body, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(0, timeoutMs));
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
      body,
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    const status = res.status;
    if (res.ok) {
      if (!json || typeof json !== 'object' || !isPlainObject(json.answers)) {
        return { ok: false, reason: 'http_error', status, detail: 'malformed response body', retryable: false };
      }
      return { ok: true, answers: json.answers, model: json.model, usage: json.usage || {} };
    }
    const detail = json && (json.detail ?? json.error ?? json) || text.slice(0, 500);
    const retryAfter = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
    if (status === 401 || status === 403) return { ok: false, reason: 'auth_error', status, detail, retryable: false };
    if (status === 422) return { ok: false, reason: 'schema_error', status, detail, retryable: false };
    if (status === 429) return { ok: false, reason: 'rate_limited', status, detail, retryable: true, retryAfter };
    if (status === 529 || status === 503) return { ok: false, reason: 'overloaded', status, detail, retryable: true, retryAfter };
    return { ok: false, reason: 'http_error', status, detail, retryable: status >= 500, retryAfter };
  } catch (err) {
    if (ac.signal.aborted || (err && err.name === 'AbortError')) {
      return { ok: false, reason: 'timeout', detail: `no response within ${timeoutMs}ms`, retryable: true };
    }
    const cause = err && err.cause;
    const detail = (cause && (cause.code || cause.message)) || (err && (err.code || err.message)) || String(err);
    return { ok: false, reason: 'network_error', detail, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

function createJevClient(opts = {}) {
  const {
    model = DEFAULT_MODEL,
    timeoutMs = 8000,
    maxRetries = 3,
    onResult = null,
  } = opts;
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('createJevClient: no fetch available (Node 18+ required)');
  const apiKey = resolveKey(opts);
  const configured = apiKey.length > 0;

  function report(record) {
    if (typeof onResult !== 'function') return;
    try { onResult(record); } catch { /* a logging hook must never break a decision */ }
  }

  async function ask(state, questions, callOpts = {}) {
    const started = Date.now();
    const usedModel = callOpts.model || model;
    const questionKeys = isPlainObject(questions) ? Object.keys(questions) : [];
    const finish = (result) => {
      const out = { ...result, latencyMs: Date.now() - started };
      delete out.retryable;
      delete out.retryAfter;
      report({
        ts: new Date(started).toISOString(),
        model: out.model || usedModel,
        questionKeys,
        latencyMs: out.latencyMs,
        attempts: out.attempts,
        ok: out.ok,
        reason: out.ok ? null : out.reason,
        inputTokens: out.ok && out.usage ? out.usage.input_tokens ?? null : null,
      });
      return out;
    };

    if (!configured) return finish({ ok: false, reason: 'typesafe_key_missing', attempts: 0 });
    if (!isPlainObject(questions) || questionKeys.length === 0) {
      return finish({ ok: false, reason: 'schema_error', detail: 'questions must be a non-empty object', attempts: 0 });
    }

    const perAttemptMs = Math.max(1, Number(callOpts.timeoutMs ?? timeoutMs));
    const retries = Math.max(0, Number(callOpts.maxRetries ?? maxRetries));
    const deadline = started + perAttemptMs * 3;
    const body = JSON.stringify({ state, model: usedModel, questions });
    let attempts = 0;
    let last;
    for (;;) {
      attempts += 1;
      last = await attemptOnce(fetchImpl, apiKey, body, Math.min(perAttemptMs, deadline - Date.now()));
      if (last.ok || !last.retryable || attempts > retries) break;
      const wait = backoffMs(last, attempts);
      if (Date.now() + wait >= deadline) break;
      await sleep(wait);
    }
    return finish({ ...last, attempts });
  }

  return { isConfigured: () => configured, ask, model, endpoint: ENDPOINT };
}

module.exports = { createJevClient, choice, noul, score, decide, yes, REASONS, DEFAULT_MODEL, ENDPOINT };

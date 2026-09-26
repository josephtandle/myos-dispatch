'use strict';
const { loadEnvFile } = require('./runtime-secrets');
const { workspaceEnvPath } = require('../myos-compat');

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-1.13.0';
const REASONS = Object.freeze([
  'typesafe_key_missing', 'schema_error', 'auth_error', 'rate_limited',
  'overloaded', 'timeout', 'network_error', 'http_error', 'disabled',
]);

function resolveKey(opts) {
  if (opts.apiKey !== undefined) return String(opts.apiKey ?? '').trim();
  const fromEnv = (process.env.TYPESAFE_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  if (opts.envFile === false) return '';
  try {
    const env = loadEnvFile({ envPath: opts.envFile || workspaceEnvPath(), env: {} });
    return String(env.TYPESAFE_API_KEY || '').trim();
  } catch {
    return '';
  }
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
  if (names.length > 255) throw new TypeError('choice: at most 255 options are allowed');
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

function level(answer) {
  if (!answer || answer.type !== 'score') throw new TypeError('level: expects a score answer');
  const score = Number(answer.score);
  return { level: Math.round(score), score, confidence: Number(answer.confidence) };
}

function parseRetryAfter(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function backoffMs(result, attempt) {
  const milliseconds = result.retryAfterMs;
  if (milliseconds != null && String(milliseconds).trim() !== '' && Number.isFinite(Number(milliseconds))) {
    return Math.max(0, Number(milliseconds));
  }
  const ra = parseRetryAfter(result.retryAfter);
  if (ra !== null) return ra;
  const base = 300 * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * base * 0.5);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attemptOnce(fetchImpl, apiKey, body, timeoutMs) {
  const ac = new AbortController();
  let timer;
  let requestId = null;
  let responseBody;
  let reader;
  const dispose = () => {
    try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch {}
    try { Promise.resolve(responseBody?.cancel?.()).catch(() => {}); } catch {}
    try { responseBody?.destroy?.(); } catch {}
  };
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve({ ok: false, reason: 'timeout', retryable: true, requestId });
      ac.abort();
      dispose();
    }, Math.max(0, timeoutMs));
  });
  const run = async () => {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
      body,
      signal: ac.signal,
    });
    responseBody = res.body;
    if (ac.signal.aborted) { dispose(); return { ok: false, reason: 'timeout', retryable: true }; }
    const header = (name) => res.headers?.get?.(name) ?? null;
    requestId = header('x-typesafe-request-id');
    let text;
    if (responseBody?.getReader) {
      reader = responseBody.getReader();
      const decoder = new TextDecoder();
      text = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } else text = await res.text();
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
    const retryAfter = header('retry-after');
    const retryAfterMs = header('retry-after-ms');
    if (status === 401 || status === 403) return { ok: false, reason: 'auth_error', status, detail, retryable: false };
    if (status === 422) return { ok: false, reason: 'schema_error', status, detail, retryable: false };
    if (status === 429) return { ok: false, reason: 'rate_limited', status, detail, retryable: true, retryAfter, retryAfterMs };
    if (status === 529 || status === 503) return { ok: false, reason: 'overloaded', status, detail, retryable: true, retryAfter, retryAfterMs };
    return { ok: false, reason: 'http_error', status, detail, retryable: status >= 500 && status < 600, retryAfter, retryAfterMs };
  };
  try {
    const result = await Promise.race([run(), expired]);
    return { ...result, requestId };
  } catch (err) {
    if (ac.signal.aborted || (err && err.name === 'AbortError')) {
      return { ok: false, reason: 'timeout', detail: `no response within ${timeoutMs}ms`, retryable: true };
    }
    return { ok: false, reason: 'network_error', retryable: true, requestId };
  } finally {
    clearTimeout(timer);
  }
}

function createJevClient(opts = {}) {
  const {
    model = DEFAULT_MODEL,
    timeoutMs = 1500,
    maxRetries = 1,
    onResult = null,
  } = opts;
  const testHang = process.env.MYOS_JEV_TEST_HANG === '1';
  const fetchImpl = testHang ? () => { setInterval(() => {}, 1000); return new Promise(() => {}); }
    : opts.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('createJevClient: no fetch available (Node 18+ required)');
  const apiKey = process.env.MYOS_JEV_ENABLED === '0' ? '' : testHang ? 'synthetic-test-key' : resolveKey(opts);
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
      delete out.retryAfterMs;
      report({
        ts: new Date(started).toISOString(),
        model: out.model || usedModel,
        questionKeys,
        requestId: out.requestId ?? null,
        latencyMs: out.latencyMs,
        attempts: out.attempts,
        ok: out.ok,
        reason: out.ok ? null : out.reason,
        inputTokens: out.ok && out.usage ? out.usage.input_tokens ?? null : null,
        outputTokens: out.ok && out.usage ? out.usage.output_tokens ?? null : null,
      });
      return out;
    };

    if (process.env.MYOS_JEV_ENABLED === '0') return finish({ ok: false, reason: 'disabled', attempts: 0 });
    if (!configured) return finish({ ok: false, reason: 'typesafe_key_missing', attempts: 0 });
    if (!isPlainObject(questions) || questionKeys.length === 0) {
      return finish({ ok: false, reason: 'schema_error', detail: 'questions must be a non-empty object', attempts: 0 });
    }

    const requestedTimeout = Number(callOpts.timeoutMs ?? timeoutMs);
    const requestedRetries = Number(callOpts.maxRetries ?? maxRetries);
    const perAttemptMs = Number.isFinite(requestedTimeout) ? Math.max(1, requestedTimeout) : 1500;
    const retries = Number.isFinite(requestedRetries) ? Math.max(0, Math.floor(requestedRetries)) : 1;
    const deadline = started + perAttemptMs;
    const body = JSON.stringify({ state, model: usedModel, questions });
    let attempts = 0;
    let last;
    for (;;) {
      if (Date.now() >= deadline) {
        last = { ok: false, reason: 'timeout', requestId: last?.requestId ?? null };
        break;
      }
      attempts += 1;
      last = await attemptOnce(fetchImpl, apiKey, body, Math.min(perAttemptMs, deadline - Date.now()));
      if (last.ok || !last.retryable || attempts > retries) break;
      const wait = backoffMs(last, attempts);
      if (Date.now() + wait >= deadline) break;
      await sleep(wait);
    }
    return finish({ ...last, attempts });
  }

  return { isConfigured: () => configured && process.env.MYOS_JEV_ENABLED !== '0', ask, model, endpoint: ENDPOINT };
}

module.exports = { createJevClient, choice, noul, score, decide, yes, level, REASONS, DEFAULT_MODEL, ENDPOINT };

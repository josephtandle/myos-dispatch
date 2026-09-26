'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { buildPromptPack, buildToolPack, answersFromRules } = require('./jev-packs');

function now(clock) {
  return Number(typeof clock === 'function' ? clock() : clock?.now ? clock.now() : Date.now());
}

function unit(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validAnswers(pack, answers) {
  if (!answers || typeof answers !== 'object') return false;
  return Object.entries(pack.fields).every(([key, field]) => {
    const answer = answers[key];
    if (!answer || (answer.type && answer.type !== field.kind)) return false;
    if (field.kind === 'noul') return unit(answer.noul);
    if (!unit(answer.confidence)) return false;
    return field.kind === 'choice' ? Object.hasOwn(pack.questions[key].criteria, answer.choice)
      : typeof answer.score === 'number' && Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= pack.questions[key].criteria.length - 1;
  });
}

async function resolveDecisions(pack, { client, legacy = {}, clock } = {}) {
  const started = now(clock);
  let result;
  try {
    if (!client?.isConfigured()) result = { ok: false, reason: 'typesafe_key_missing' };
    else result = await client.ask(pack.state, pack.questions);
  } catch {
    result = { ok: false, reason: 'network_error' };
  }
  const latencyMs = Math.max(0, now(clock) - started);
  if (result?.ok && validAnswers(pack, result.answers)) {
    return { engine: 'jev', answers: result.answers, latencyMs, model: result.model, usage: result.usage };
  }
  return { engine: 'rules', answers: answersFromRules(pack, legacy), latencyMs,
    skipped: result?.ok ? 'schema_error' : result?.reason || 'network_error' };
}

function locations(opts, env) {
  const home = env.MYOS_HOME_ROOT || path.join(os.homedir(), '.myos-dispatch');
  return { stateFile: opts.stateFile || path.join(home, 'state', 'jev-shadow-state.json'),
    ledgerFile: opts.ledgerFile || path.join(home, 'logs', 'jev-shadow.jsonl') };
}

function readState(file) {
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { state = {}; }
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
  return { ...state, authoritativeFields: Array.isArray(state.authoritativeFields) ? state.authoritativeFields.filter((field) => typeof field === 'string') : [],
    floors: state.floors && typeof state.floors === 'object' ? state.floors : {},
    metrics: state.metrics && typeof state.metrics === 'object' && !Array.isArray(state.metrics) ? state.metrics : {} };
}

function persist(file, value, append = false) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (append) fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    else fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  } catch { /* Observation failures must not block dispatch. */ }
}

function legacyField(legacy, field) {
  const [parent, key] = field.split('.');
  if (parent === 'blockedBy') return Array.isArray(legacy.blockedBy)
    ? legacy.blockedBy.includes(key) : Boolean(legacy.blockedBy?.[key]);
  if (parent === 'safety') return legacy.labels.includes(key);
  return legacy[field] ?? null;
}

function compare(pack, answers, legacy, engine, tool) {
  const comparison = {};
  for (const [key, field] of Object.entries(pack.fields)) {
    if (!field.planField) continue;
    const answer = answers[key];
    const decided = field.kind === 'noul' ? answer.noul >= 0.5 : field.kind === 'score' ? Math.round(answer.score) + 1 : answer.choice;
    const confidence = field.kind === 'noul' ? Math.max(answer.noul, 1 - answer.noul) : answer.confidence;
    const value = legacyField(legacy, field.planField);
    comparison[field.planField] = { legacy: value, decided, confidence, agrees: isDeepStrictEqual(value, decided), engine };
  }
  if (!tool && answers.goal_scale) {
    const confidence = answers.goal_scale.confidence;
    comparison.goalConfidence = { legacy: legacy.goalConfidence ?? null, decided: confidence,
      confidence, agrees: isDeepStrictEqual(legacy.goalConfidence, confidence), engine };
  }
  return comparison;
}

function recordComparison(state, comparison) {
  for (const [field, row] of Object.entries(comparison)) {
    // Rules agreeing with themselves are not evidence for model promotion.
    if (row.engine !== 'jev') continue;
    const old = state.metrics[field];
    const valid = old && Number.isInteger(old.n) && old.n >= 0 && Number.isInteger(old.agree) && old.agree >= 0
      && old.agree <= old.n && Number.isFinite(old.sumConfidence) && old.sumConfidence >= 0 && old.sumConfidence <= old.n
      && Array.isArray(old.bins) && old.bins.length === 10 && old.bins.every((bin) => Number.isInteger(bin?.n)
        && bin.n >= 0 && Number.isInteger(bin?.agree) && bin.agree >= 0 && bin.agree <= bin.n);
    const metrics = valid ? old : { n: 0, agree: 0, sumConfidence: 0, bins: Array.from({ length: 10 }, () => ({ n: 0, agree: 0 })) };
    metrics.n += 1;
    metrics.agree += Number(row.agrees);
    metrics.sumConfidence += row.confidence;
    const bin = metrics.bins[Math.min(9, Math.floor(row.confidence * 10))];
    bin.n += 1;
    bin.agree += Number(row.agrees);
    state.metrics[field] = metrics;
  }
}

function applyAuthority(plan, comparison, pack, state, stage, tool) {
  const selected = [];
  const defaults = Object.fromEntries(Object.values(pack.fields).filter((field) => field.planField)
    .map((field) => [field.planField, field.floorDefault]));
  for (const [field, row] of Object.entries(comparison)) {
    const permitted = stage === 'authoritative' ? state.authoritativeFields.includes(field)
      : stage === 'canary' && !tool && ['goalConfidence', 'fanoutAggression'].includes(field);
    const floor = unit(state.floors[field]) ? state.floors[field] : defaults[field] ?? 0.9;
    if (!permitted || row.engine !== 'jev' || row.confidence < floor) continue;
    if (field.startsWith('blockedBy.')) {
      if (stage !== 'authoritative' || !row.decided || row.legacy) continue;
      const label = field.slice('blockedBy.'.length);
      if (Array.isArray(plan.blockedBy) || plan.blockedBy == null) plan.blockedBy = [...(plan.blockedBy || []), label];
      else plan.blockedBy = { ...plan.blockedBy, [label]: true };
    } else if (field.startsWith('safety.')) {
      if (stage !== 'authoritative' || !row.decided || row.legacy) continue;
      plan.labels = [...plan.labels, field.slice('safety.'.length)];
    } else {
      plan[field] = row.decided;
    }
    selected.push({ field, selectedBy: 'jev' });
  }
  return selected;
}

async function attach(pack, query, legacy, opts, tool) {
  const env = opts.env || process.env;
  const files = locations(opts, env);
  const state = readState(files.stateFile);
  const requestedStage = env.MYOS_JEV_STAGE ?? state.stage;
  const stage = ['shadow', 'canary', 'authoritative'].includes(requestedStage) ? requestedStage : 'shadow';
  const result = await resolveDecisions(pack, { ...opts, legacy });
  const comparison = compare(pack, result.answers, legacy, result.engine, tool);
  const plan = { ...legacy };
  const authoritativeFields = applyAuthority(plan, comparison, pack, state, stage, tool);
  plan.jev = { version: 'jev-shadow-v1', stage, engine: result.engine, skipped: result.skipped,
    latencyMs: result.latencyMs, model: result.model, usage: result.usage, comparison, authoritativeFields };
  recordComparison(state, comparison);
  persist(files.stateFile, { ...state, stage: ['shadow', 'canary', 'authoritative'].includes(state.stage) ? state.stage : 'shadow' });
  const text = String(query ?? '');
  persist(files.ledgerFile, { ts: new Date(now(opts.clock)).toISOString(), surface: pack.state.surface || opts.surface || (tool ? 'PreToolUse' : 'UserPromptSubmit'),
    event: tool ? 'tool' : 'prompt', promptHash: createHash('sha256').update(text).digest('hex'), promptLength: text.length,
    stage, engine: result.engine, skipped: result.skipped ?? null,
    legacy: Object.fromEntries(Object.entries(comparison).map(([field, row]) => [field, row.legacy])),
    decided: result.answers, latencyMs: result.latencyMs, inputTokens: result.usage?.input_tokens ?? null, model: result.model ?? null,
    ...(env.MYOS_JEV_LOG_TEXT === '1' ? { promptText: text } : {}) }, true);
  return plan;
}

async function attachJevShadow(query, legacyPlan, signals = {}, opts = {}) {
  return attach(buildPromptPack(query, signals, opts), query, legacyPlan, opts, false);
}

async function attachJevToolSafety(command, description, context = {}, legacyLabels = [], opts = {}) {
  const legacy = Array.isArray(legacyLabels) ? { labels: legacyLabels.slice() } : { ...legacyLabels, labels: [...(legacyLabels.labels || [])] };
  return attach(buildToolPack(command, description, context), command, legacy, { ...opts, surface: opts.surface || context.surface }, true);
}

module.exports = { resolveDecisions, attachJevShadow, attachJevToolSafety, recordComparison };

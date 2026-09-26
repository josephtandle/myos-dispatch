'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const shadow = require('../src/decision/jev-shadow');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { buildPromptPack, answersFromRules } = require('../src/decision/jev-packs');
const { createJevClient } = require('../src/runtime/jev-client');
const { summarizeCalibration, isFieldEligibleForPromotion } = require('../src/decision/jev-promotion-policy');
const { attachJevShadow, attachJevToolSafety, resolveDecisions } = shadow;

test('shadow module provides prompt, tool and decision entry points', () => {
  for (const key of ['resolveDecisions', 'attachJevShadow', 'attachJevToolSafety']) {
    assert.equal(typeof shadow[key], 'function');
  }
});

const legacy = { intentType: 'directive', actionType: 'read', goalScale: 2, goalConfidence: 'medium',
  fanoutAggression: 'off', correctionDetected: false,
  parallelizationPlan: { aggression: 'off', executionEnvelope: { features: { intentFidelity: { correctionDetected: false } } } }, blockedBy: ['auth_sensitive', 'custom_gate'], nested: { untouched: true } };

function fixture(t, state = {}, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-shadow-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stateFile = path.join(home, 'state.json');
  const ledgerFile = path.join(home, 'ledger.jsonl');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  return { env: { MYOS_HOME_ROOT: home, ...env }, stateFile, ledgerFile, clock: () => 1000 };
}

function clientFor(overrides = {}, onAsk = () => {}) {
  return { isConfigured: () => true, ask: async (state, questions) => {
    onAsk(state, questions);
    const answers = Object.fromEntries(Object.entries(questions).map(([key, question]) => [key,
      question.type === 'noul' ? { type: 'noul', noul: 0 }
        : question.type === 'score' ? { type: 'score', score: 3, confidence: 0.96, legend: question.criteria, probabilities: { 3: 0.96 } }
          : { type: 'choice', choice: Object.keys(question.criteria)[0], confidence: 0.96, probabilities: {} }]));
    return { ok: true, answers: { ...answers, ...overrides }, model: 'fake-jev', usage: { input_tokens: 17 } };
  } };
}

test('unconfigured and undefined clients use rules without fetch and preserve the legacy plan', async (t) => {
  let fetchCalls = 0;
  const unconfigured = createJevClient({ apiKey: '', envFile: false, fetch: () => { fetchCalls++; throw new Error('unexpected fetch'); } });
  for (const client of [undefined, unconfigured]) {
    const opts = fixture(t, { stage: 'authoritative', authoritativeFields: ['goalScale', 'goalConfidence'] });
    const result = await attachJevShadow('work', legacy, {}, { ...opts, client });
    const { jev, ...plan } = result;
    assert.deepEqual(plan, legacy);
    assert.notEqual(result, legacy);
    assert.equal(jev.engine, 'rules');
    assert.equal(jev.skipped, 'typesafe_key_missing');
    assert.deepEqual(jev.authoritativeFields, []);
    assert.equal(JSON.parse(fs.readFileSync(opts.stateFile)).metrics, undefined);
  }
  assert.equal(fetchCalls, 0);
});

test('configured client receives a single complete pack and shadow never overrides', async (t) => {
  let asks = 0;
  const opts = fixture(t);
  const result = await attachJevShadow('do work', legacy, { callerProvider: 'codex' }, { ...opts,
    client: clientFor({}, (state, questions) => { asks++; assert.equal(state.prompt, 'do work'); assert.equal(Object.keys(questions).length, 11); }) });
  const { jev, ...plan } = result;
  assert.equal(asks, 1);
  assert.deepEqual(plan, legacy);
  assert.equal(jev.stage, 'shadow');
  assert.equal(jev.engine, 'jev');
  assert.deepEqual(jev.comparison.goalScale, { legacy: 2, decided: 4, confidence: 0.96, agrees: false, engine: 'jev' });
  assert.equal(jev.comparison.intentType.agrees, true);
  assert.equal(jev.model, 'fake-jev');
  assert.equal(jev.usage.input_tokens, 17);
});

test('canary is reserved and never overrides prompt fields', async (t) => {
  const opts = fixture(t, { stage: 'canary', authoritativeFields: ['goalScale', 'actionType'], floors: { fanoutAggression: 0.99 } });
  const overrides = { aggression: { choice: 'deep', confidence: 0.98 } };
  const result = await attachJevShadow('work', legacy, {}, { ...opts, client: clientFor(overrides) });
  assert.equal(result.goalConfidence, 'medium');
  assert.equal(result.goalScale, 2);
  assert.equal(result.actionType, 'read');
  assert.equal(result.fanoutAggression, 'off');
  assert.deepEqual(result.jev.authoritativeFields, []);
  const allowed = await attachJevShadow('work', legacy, {}, { ...fixture(t, { stage: 'canary', floors: { fanoutAggression: 0.98 } }), client: clientFor(overrides) });
  assert.equal(allowed.fanoutAggression, 'off');
});

test('authoritative top-level prompt fields remain shadow only', async (t) => {
  const opts = fixture(t, { stage: 'authoritative', authoritativeFields: ['goalScale', 'actionType'], floors: { goalScale: 0.97, actionType: 0.95 } });
  const result = await attachJevShadow('work', legacy, {}, { ...opts, client: clientFor({ action: { choice: 'write', confidence: 0.96 } }) });
  assert.equal(result.goalScale, 2);
  assert.equal(result.actionType, 'read');
  assert.equal(result.goalConfidence, 'medium');
  assert.deepEqual(result.jev.authoritativeFields, []);
});

test('environment stage overrides state and unknown stages fail closed', async (t) => {
  for (const stage of ['shadow', 'bogus']) {
    const opts = fixture(t, { stage: 'authoritative', authoritativeFields: ['goalScale'] }, { MYOS_JEV_STAGE: stage });
    const result = await attachJevShadow('work', legacy, {}, { ...opts, client: clientFor() });
    assert.equal(result.goalScale, 2);
    assert.equal(result.jev.stage, 'shadow');
  }
});

test('blockers can only be added in authoritative stage and never removed', async (t) => {
  const snapshot = structuredClone(legacy);
  for (const stage of ['shadow', 'canary', 'authoritative']) {
    const opts = fixture(t, { stage, authoritativeFields: ['blockedBy.auth_sensitive', 'blockedBy.browser_control'] });
    const result = await attachJevShadow('work', legacy, {}, { ...opts, client: clientFor({ browser_control: { noul: 1 }, auth_sensitive: { noul: 0 } }) });
    assert.deepEqual(result.blockedBy, stage === 'authoritative' ? [...legacy.blockedBy, 'browser_control'] : legacy.blockedBy);
    assert.equal(result.jev.comparison['blockedBy.auth_sensitive'].confidence, 1);
  }
  assert.deepEqual(legacy, snapshot);
});

test('blocker object representations retain unrelated and existing gates', async (t) => {
  const plan = { ...legacy, blockedBy: { auth_sensitive: true, custom_gate: true } };
  const opts = fixture(t, { stage: 'authoritative', authoritativeFields: ['blockedBy.auth_sensitive', 'blockedBy.browser_control'] });
  const result = await attachJevShadow('work', plan, {}, { ...opts, client: clientFor({ browser_control: { noul: 1 } }) });
  assert.deepEqual(result.blockedBy, { auth_sensitive: true, custom_gate: true, browser_control: true });
  assert.deepEqual(plan.blockedBy, { auth_sensitive: true, custom_gate: true });
});

test('failures and malformed typed answers fall back to complete rules answers', async () => {
  const pack = buildPromptPack('work');
  for (const client of [
    { isConfigured: () => true, ask: async () => ({ ok: false, reason: 'timeout' }) },
    { isConfigured: () => true, ask: async () => { throw new Error('offline'); } },
    { isConfigured: () => true, ask: async () => ({ ok: true, answers: {} }) },
    clientFor({ goal_scale: { score: 99, confidence: 1 } }),
    clientFor({ intent: { choice: 'invalid', confidence: 1 } }),
    clientFor({ auth_sensitive: { noul: NaN } }),
  ]) {
    let tick = 0;
    const result = await resolveDecisions(pack, { client, legacy, clock: () => tick++ * 10 });
    assert.equal(result.engine, 'rules');
    assert.deepEqual(result.answers, answersFromRules(pack, legacy));
    assert.equal(result.latencyMs, 10);
    assert.ok(['timeout', 'network_error', 'schema_error'].includes(result.skipped));
  }
});

test('ledger hashes full prompt, omits text by default and retains probabilities', async (t) => {
  const opts = fixture(t);
  const prompt = 'sensitive prompt'.repeat(700);
  await attachJevShadow(prompt, legacy, { callerProvider: 'codex' }, { ...opts, client: clientFor() });
  const entry = JSON.parse(fs.readFileSync(opts.ledgerFile, 'utf8').trim());
  assert.equal(entry.promptHash, createHash('sha256').update(prompt).digest('hex'));
  assert.equal(entry.promptLength, prompt.length);
  assert.equal(Object.hasOwn(entry, 'promptText'), false);
  assert.equal(entry.surface, 'codex');
  assert.equal(entry.event, 'prompt');
  assert.deepEqual(entry.authoritativeFields, []);
  assert.equal(entry.n, Object.keys(entry.legacy).length);
  assert.equal(entry.agree, 9);
  assert.equal(entry.ts, new Date(1000).toISOString());
  assert.equal(entry.inputTokens, 17);
  assert.deepEqual(entry.decided.goal_scale.probabilities, { 3: 0.96 });
  await attachJevShadow('explicit text', legacy, {}, { ...opts, env: { ...opts.env, MYOS_JEV_LOG_TEXT: '1' } });
  const entries = fs.readFileSync(opts.ledgerFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].promptText, 'explicit text');
});

test('opt-in metrics accumulate and confidence one is assigned to bin nine', async (t) => {
  const opts = fixture(t);
  opts.env.MYOS_JEV_HOOK_METRICS = '1';
  for (let i = 0; i < 2; i++) await attachJevShadow('work', legacy, {}, { ...opts, client: clientFor() });
  const state = { metrics: JSON.parse(fs.readFileSync(path.join(opts.env.MYOS_HOME_ROOT, 'state/jev-shadow-metrics.json'), 'utf8')) };
  assert.equal(state.metrics.intentType.n, 2);
  assert.equal(state.metrics.intentType.agree, 2);
  assert.equal(state.metrics.intentType.sumConfidence, 1.92);
  assert.equal(state.metrics.intentType.bins.length, 10);
  assert.deepEqual(state.metrics.intentType.bins[9], { n: 2, agree: 2 });
  assert.deepEqual(state.metrics['blockedBy.auth_sensitive'].bins[9], { n: 2, agree: 0 });
});

test('corrupt state, invalid floors and unwritable observation paths do not break dispatch', async (t) => {
  const opts = fixture(t);
  fs.writeFileSync(opts.stateFile, '{bad json');
  const result = await attachJevShadow('work', legacy, {}, { ...opts, client: clientFor() });
  assert.equal(result.jev.stage, 'shadow');
  const invalid = fixture(t, { stage: 'authoritative', authoritativeFields: ['goalScale'], floors: { goalScale: -1 }, metrics: { goalScale: { n: 'bad' } } });
  const low = await attachJevShadow('work', legacy, {}, { ...invalid, client: clientFor({ goal_scale: { score: 4, confidence: 0.6 } }) });
  assert.equal(low.goalScale, 2);
  const blocked = path.join(opts.stateFile, 'cannot-write.json');
  const safe = await attachJevShadow('work', legacy, {}, { ...opts, stateFile: blocked, ledgerFile: blocked });
  assert.equal(safe.jev.engine, 'rules');
});

test('default observation locations are relative to MYOS_HOME_ROOT', async (t) => {
  const opts = fixture(t);
  await attachJevShadow('work', legacy, {}, { env: opts.env });
  assert.equal(fs.existsSync(path.join(opts.env.MYOS_HOME_ROOT, 'state/jev-shadow-state.json')), false);
  assert.equal(fs.existsSync(path.join(opts.env.MYOS_HOME_ROOT, 'state/jev-shadow-metrics.json')), false);
  assert.ok(fs.existsSync(path.join(opts.env.MYOS_HOME_ROOT, 'logs/jev-shadow.jsonl')));
});

test('tool safety authoritative adds allowed labels above floor and never removes any', async (t) => {
  const labels = ['auth_sensitive', 'custom_gate'];
  for (const stage of ['shadow', 'canary', 'authoritative']) {
    let asks = 0;
    const opts = fixture(t, { stage, authoritativeFields: ['safety.auth_sensitive', 'safety.user_visible_send', 'safety.browser_control'], floors: { 'safety.browser_control': 0.99 } });
    const result = await attachJevToolSafety('send message', 'send it', { surface: 'codex' }, labels, { ...opts,
      client: clientFor({ user_visible_send: { noul: 1 }, auth_sensitive: { noul: 0 }, browser_control: { noul: 0.98 } }, () => { asks++; }) });
    assert.equal(asks, 1);
    assert.deepEqual(result.labels, stage === 'authoritative' ? [...labels, 'user_visible_send'] : labels);
    assert.equal(result.jev.comparison['safety.auth_sensitive'].legacy, true);
    assert.equal(JSON.parse(fs.readFileSync(opts.ledgerFile, 'utf8')).event, 'tool');
  }
  assert.deepEqual(labels, ['auth_sensitive', 'custom_gate']);
});

test('tool safety with no client preserves labels with rules metadata', async (t) => {
  const result = await attachJevToolSafety('cat file', 'read', {}, ['read_only'], fixture(t));
  assert.deepEqual(result.labels, ['read_only']);
  assert.equal(result.jev.engine, 'rules');
  assert.equal(result.jev.comparison['safety.read_only'].agrees, true);
});

test('calibration reports reliability rows and rejects insufficient or miscalibrated samples', () => {
  const bins = Array.from({ length: 10 }, () => ({ n: 0, agree: 0 }));
  bins[9] = { n: 200, agree: 190 };
  const metrics = { n: 200, agree: 190, sumConfidence: 190, bins };
  const snapshot = structuredClone(metrics);
  assert.equal(isFieldEligibleForPromotion(metrics), true);
  assert.deepEqual(summarizeCalibration(bins)[9], { bin: 9, n: 200, empiricalAgreement: 0.95, midpoint: 0.95, gap: 0 });
  assert.equal(summarizeCalibration(bins)[0].empiricalAgreement, null);
  assert.equal(isFieldEligibleForPromotion(metrics, { minN: 201 }), false);
  assert.equal(isFieldEligibleForPromotion({ ...metrics, agree: 170 }), false);
  const badBins = Array.from({ length: 10 }, () => ({ n: 0, agree: 0 }));
  badBins[5] = { n: 200, agree: 190 };
  assert.equal(isFieldEligibleForPromotion({ ...metrics, bins: badBins }), false);
  assert.equal(isFieldEligibleForPromotion({ ...metrics, bins: [] }), false);
  assert.equal(isFieldEligibleForPromotion(null), false);
  assert.equal(summarizeCalibration(null).length, 10);
  assert.deepEqual(metrics, snapshot);
});

test('live zero-based fractional scores are accepted and mapped to goal scale', async (t) => {
  const live = require('./fixtures/jev-prompt-answers-live.json');
  const client = { isConfigured: () => true, ask: async () => ({ ok: true, ...live }) };
  const result = await resolveDecisions(buildPromptPack('synthetic work'), { client, legacy });
  assert.equal(result.engine, 'jev');
  assert.equal(result.skipped, undefined);
  const plan = await attachJevShadow('synthetic work', legacy, {}, { ...fixture(t), client });
  assert.equal(plan.jev.comparison.goalScale.decided, Math.round(live.answers.goal_scale.score) + 1);
});

test('authoritative browser open adds a missing legacy label and records the change', async (t) => {
  const opts = fixture(t, { stage: 'authoritative', authoritativeFields: ['safety.browser_control'], floors: { 'safety.browser_control': 0.7 } });
  const result = await attachJevToolSafety('open https://console.typesafe.ai/usage', 'Open the usage page', {}, [], {
    ...opts, client: clientFor({ browser_control: { type: 'noul', noul: 0.95 } }),
  });
  assert.deepEqual(result.labels, ['browser_control']);
  assert.deepEqual(result.jev.authoritativeFields, [{ field: 'safety.browser_control', selectedBy: 'jev' }]);
  const entry = JSON.parse(fs.readFileSync(opts.ledgerFile, 'utf8'));
  assert.deepEqual(entry.authoritativeFields, result.jev.authoritativeFields);
  assert.equal(entry.agree, 7);
  assert.equal(entry.n, 8);
  assert.equal(Object.hasOwn(entry, 'promptText'), false);
});

test('truncated config stays byte-identical and fails closed despite environment authority', async (t) => {
  const opts = fixture(t, {}, { MYOS_JEV_STAGE: 'authoritative', MYOS_JEV_HOOK_METRICS: '1' });
  fs.writeFileSync(opts.stateFile, '{"stage":"author');
  const bytes = fs.readFileSync(opts.stateFile);
  const result = await attachJevShadow('work', legacy, {}, { ...opts, client: clientFor() });
  assert.equal(result.jev.stage, 'shadow');
  assert.equal(result.jev.configUnreadable, true);
  assert.deepEqual(fs.readFileSync(opts.stateFile), bytes);
  assert.equal(JSON.parse(fs.readFileSync(opts.ledgerFile)).configUnreadable, true);
});

test('corrupt metrics are not repaired by a hook event', async (t) => {
  const opts = fixture(t, {}, { MYOS_JEV_HOOK_METRICS: '1' });
  opts.metricsFile = path.join(opts.env.MYOS_HOME_ROOT, 'metrics.json');
  fs.writeFileSync(opts.metricsFile, '{torn');
  await attachJevShadow('work', legacy, {}, { ...opts, client: clientFor() });
  assert.equal(fs.readFileSync(opts.metricsFile, 'utf8'), '{torn');
});

test('40 concurrent processes preserve config and expose only complete metrics', async (t) => {
  const { spawn } = require('node:child_process');
  const opts = fixture(t, { stage: 'authoritative', authoritativeFields: ['blockedBy.browser_control'], promotionNote: 'keep' });
  const bytes = fs.readFileSync(opts.stateFile);
  const metricsFile = path.join(opts.env.MYOS_HOME_ROOT, 'state/jev-shadow-metrics.json');
  const code = `const { attachJevShadow } = require(${JSON.stringify(require.resolve('../src/decision/jev-shadow'))});
    const opts = ${JSON.stringify(opts)};
    opts.env.MYOS_JEV_HOOK_METRICS = '1';
    attachJevShadow('synthetic', {}, {}, opts).catch(e => { console.error(e); process.exitCode = 1; });`;
  let reads = 0;
  let readError;
  const timer = setInterval(() => {
    try {
      JSON.parse(fs.readFileSync(opts.stateFile));
      if (fs.existsSync(metricsFile)) { JSON.parse(fs.readFileSync(metricsFile)); reads++; }
    } catch (error) { readError = error; }
  }, 1);
  try {
    await Promise.all(Array.from({ length: 40 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', status => status === 0 ? resolve() : reject(new Error(stderr)));
    })));
  } finally { clearInterval(timer); }
  assert.ifError(readError);
  assert.ok(reads > 0);
  assert.deepEqual(fs.readFileSync(opts.stateFile), bytes);
  assert.equal(fs.readFileSync(opts.ledgerFile, 'utf8').trim().split('\n').map(JSON.parse).length, 40);
  assert.deepEqual(fs.readdirSync(path.dirname(metricsFile)), ['jev-shadow-metrics.json']);
});


test('realistic nested legacy fields compare and reach the ledger', async t => {
  const opts = fixture(t);
  const plan = { intentType: 'directive', actionType: 'write', goalScale: 3, goalConfidence: 0.96,
    parallelizationPlan: { aggression: 'deep', executionEnvelope: {
      features: { intentFidelity: { correctionDetected: true } } } },
    route: { lane: 'worker_skill' }, blockedBy: [] };
  const result = await attachJevShadow('No, fix the report', plan, {}, { ...opts, client: clientFor({
    correction: { noul: 1 }, aggression: { choice: 'deep', confidence: 0.96 },
  }) });
  for (const field of ['parallelizationPlan.executionEnvelope.features.intentFidelity.correctionDetected', 'parallelizationPlan.aggression']) {
    assert.equal(result.jev.comparison[field].agrees, true, field);
    assert.deepEqual(JSON.parse(fs.readFileSync(opts.ledgerFile)).legacy[field], result.jev.comparison[field].legacy);
  }
  // Lane is no longer asked in the production pack; existing/custom packs still resolve dotted paths.
  const pack = { fields: { lane: { kind: 'choice', planField: 'route.lane' } },
    questions: { lane: { criteria: { worker_skill: 'worker', other: 'other' } } } };
  const answers = answersFromRules(pack, plan);
  assert.equal(answers.lane.choice, 'worker_skill');
  assert.equal(shadow.compare(pack, answers, plan, 'jev', false)['route.lane'].agrees, true);
});

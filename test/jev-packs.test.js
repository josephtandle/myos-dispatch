'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const packs = require('../src/decision/jev-packs');
const fs = require('node:fs');
const path = require('node:path');
const { buildPromptPack, buildToolPack, answersFromRules, RULES_ENGINE_BANDS } = packs;

test('pack module provides the bounded public builders and rules engine', () => {
  for (const key of ['buildPromptPack', 'buildToolPack', 'answersFromRules']) {
    assert.equal(typeof packs[key], 'function');
  }
});

const signals = {
  callerProvider: 'codex', isFollowUp: true,
  route: { candidates: Array.from({ length: 12 }, (_, i) => ({ capability: { id: `cap-${i}`, name: `Capability ${i}`, description: `Does task ${i}` } })) },
  projectMatches: Array.from({ length: 8 }, (_, i) => ({ slug: `project-${i}`, name: `Project ${i}` })),
};

test('prompt pack uses only raw prompt and surface, without shortlist questions', () => {
  const pack = buildPromptPack('x'.repeat(7000), signals, { surface: 'codex' });
  assert.deepEqual(pack.state, { prompt: 'x'.repeat(6000), surface: 'codex' });
  assert.deepEqual(Object.keys(pack.questions), ['intent', 'action', 'goal_scale', 'correction', 'aggression',
    'browser_control', 'user_visible_send', 'payment_or_account_mutation', 'auth_sensitive',
    'interactive_auth_action', 'destructive_or_approval_sensitive']);
  assert.deepEqual(buildPromptPack('hello').state, { prompt: 'hello' });
});

test('choice criteria are non-empty plain dictionaries and score has four levels', () => {
  const pack = buildPromptPack('do something', signals);
  for (const [key, question] of Object.entries(pack.questions)) {
    assert.equal(pack.fields[key].kind, question.type);
    assert.ok(pack.fields[key].floorDefault >= 0 && pack.fields[key].floorDefault <= 1);
    if (question.type !== 'choice') continue;
    assert.equal(Object.getPrototypeOf(question.criteria), Object.prototype);
    assert.ok(Object.keys(question.criteria).length >= 2 && Object.keys(question.criteria).length <= 255);
    assert.ok(Object.values(question.criteria).every((value) => typeof value === 'string' && value.trim()));
  }
  assert.equal(pack.questions.goal_scale.criteria.length, 4);
  assert.match(pack.questions.goal_scale.criteria[3], /multi-system/);
  assert.equal(pack.fields.prompt_injection, undefined);
});

test('prompt blocker keys match the planner BLOCKERS declaration exactly', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/parallelization-planner.js'), 'utf8');
  const declaration = source.match(/const BLOCKERS = Object.freeze\(\[([\s\S]*?)\]\);/)[1];
  const keys = [...declaration.matchAll(/id: "([^"]+)"/g)].map((match) => match[1]).sort();
  const pack = buildPromptPack('hello');
  assert.deepEqual(Object.entries(pack.fields).filter(([, field]) => field.planField?.startsWith('blockedBy.')).map(([key]) => key).sort(), keys);
});

test('tool pack supplies seven gates, hard negatives and only argv paths', () => {
  const pack = buildToolPack('cat "./path with spaces.txt" --output=/tmp/result https://example.com/health', 'read a file', { cwd: '/repo/src', repoRoot: '/repo' });
  assert.equal(pack.state.cwd_kind, 'repo');
  assert.deepEqual(pack.state.argv_paths, ['./path with spaces.txt', '/tmp/result']);
  assert.equal(Object.keys(pack.questions).length, 8);
  assert.equal(pack.fields.read_only.planField, 'safety.read_only');
  for (const key of ['needs_human', 'description_matches_command', 'protected_surface_write']) {
    assert.equal(pack.fields[key], undefined);
    assert.equal(pack.questions[key], undefined);
  }
  assert.match(pack.questions.destructive_or_approval_sensitive.instructions, /grepping for the word rm is not deleting/);
  assert.match(pack.questions.destructive_or_approval_sensitive.instructions, /printing a file that mentions git push --force is not pushing/);
  assert.match(pack.questions.user_visible_send.instructions, /curl to localhost health/);
  for (const [cwd, home, kind] of [['/tmp/a', '/home/me', 'tmp'], ['/home/me/a', '/home/me', 'home'], ['/opt/app', '/home/me', 'other']]) {
    assert.equal(buildToolPack('pwd', '', { cwd, home }).state.cwd_kind, kind);
  }
});

test('rules answers have typed Jev shapes and existing confidence bands', () => {
  const pack = buildPromptPack('work', signals);
  const answers = answersFromRules(pack, { intentType: 'directive', intentConfidence: 'high', actionType: 'write',
    goalScale: 3, goalConfidence: 'medium', parallelizationPlan: { aggression: 'off',
      executionEnvelope: { features: { intentFidelity: { correctionDetected: true } } } },
    blockedBy: ['auth_sensitive'], executionLane: 'worker_skill', projectSlug: 'project-0' });
  assert.deepEqual(RULES_ENGINE_BANDS, { high: 0.9, medium: 0.7, low: 0.5, none: 0.5 });
  assert.equal(answers.intent.type, 'choice');
  assert.equal(answers.intent.confidence, 0.9);
  assert.equal(answers.action.confidence, 0.5);
  assert.equal(answers.goal_scale.score, 2);
  assert.equal(answers.goal_scale.confidence, 0.7);
  assert.equal(Object.keys(answers.goal_scale.legend).length, 4);
  assert.equal(answers.lane, undefined);
  assert.equal(answers.aggression.choice, 'off');
  assert.deepEqual(answers.auth_sensitive, { type: 'noul', noul: 1 });
  assert.deepEqual(answers.browser_control, { type: 'noul', noul: 0 });
  assert.deepEqual(answers.correction, { type: 'noul', noul: 1 });
  for (const answer of Object.values(answers).filter((entry) => entry.probabilities)) {
    assert.ok(Math.abs(Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0) - 1) < 1e-10);
  }
  assert.equal(answersFromRules(buildToolPack('cat a', 'read'), ['read_only']).read_only.noul, 1);
  assert.equal(answersFromRules(buildToolPack('rm a', 'delete'), { labels: ['destructive_or_approval_sensitive'] }).destructive_or_approval_sensitive.noul, 1);
});

test('browser criteria explicitly cover macOS URL and application opens', () => {
  const question = buildToolPack('open https://console.typesafe.ai/usage', 'Open the usage page').questions.browser_control;
  assert.equal(question.type, 'noul');
  assert.ok(question.instructions.includes('open <http or https URL>'));
  assert.ok(question.instructions.includes('open -a'));
});

test('model packs redact credential patterns while preserving command semantics', () => {
  const values = ['Bearer abcDEF123', 'apikey: private', 'apikey=private', 'Authorization: Basic abc123',
    'sk-abc123', 'sk_live_abc123', 'sk_test_abc123', 'rk_live_abc123', 'whsec_abc123', 'ghp_abc123',
    'gho_abc123', 'xoxa-123-abc', 'xoxb-123-abc', 'xoxp-123-abc', 'AKIA1234567890ABCDEF',
    'eyJabc.def.ghi', 'apikey_0123456789abcdef0123', 'TYPESAFE_API_KEY=private', 'API_KEY="two words"',
    "TOKEN='two words'", 'SECRET=private', 'PASSWORD=private', 'KEY=private', 'ACCESS_TOKEN=private',
    '-u user:pass', '-u "user:pass"', 'https://user:pass@host/path'];
  for (const value of values) {
    const redacted = packs.redactForModel(value);
    assert.match(redacted, /<REDACTED>/, value);
    assert.notEqual(redacted, value);
    for (const pack of [buildPromptPack(value), buildToolPack(value, value)]) {
      assert.equal(JSON.stringify(pack.state).includes(value), false, value);
      assert.doesNotMatch(JSON.stringify(pack), /apikey_[0-9a-f]{20}/);
    }
  }
  assert.equal(buildToolPack('curl -H "apikey: private" https://host/path', '').state.command,
    'curl -H "apikey: <REDACTED>" https://host/path');
  assert.equal(packs.redactForModel('echo hello && ls ./files'), 'echo hello && ls ./files');
});

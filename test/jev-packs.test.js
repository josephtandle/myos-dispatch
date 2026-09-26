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

test('prompt state uses real shortlist shape, omits empty fields and bounds data', () => {
  const pack = buildPromptPack('x'.repeat(7000), signals, { lastDispatchHint: { projectSlug: 'previous' } });
  assert.equal(pack.state.prompt.length, 6000);
  assert.equal(pack.state.top_capabilities.length, 6);
  assert.equal(pack.state.top_projects.length, 4);
  assert.deepEqual(pack.state.top_capabilities[0], { id: 'cap-0', title: 'Capability 0', summary: 'Does task 0' });
  assert.equal(pack.state.surface, 'codex');
  assert.equal(pack.state.is_follow_up, true);
  assert.equal(pack.state.previous_project, 'previous');
  const empty = buildPromptPack('hello');
  assert.deepEqual(empty.state, { prompt: 'hello' });
  assert.equal(empty.questions.lane, undefined);
  assert.equal(empty.questions.project, undefined);
  assert.equal(buildPromptPack('hello', { isFollowUp: false }).state.is_follow_up, false);
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
  assert.equal(pack.fields.prompt_injection.planField, null);
});

test('prompt blocker keys match the planner BLOCKERS declaration exactly', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/parallelization-planner.js'), 'utf8');
  const declaration = source.match(/const BLOCKERS = Object.freeze\(\[([\s\S]*?)\]\);/)[1];
  const keys = [...declaration.matchAll(/id: "([^"]+)"/g)].map((match) => match[1]).sort();
  const pack = buildPromptPack('hello');
  assert.deepEqual(Object.entries(pack.fields).filter(([, field]) => field.planField?.startsWith('blockedBy.')).map(([key]) => key).sort(), keys);
});

test('shortlist duplicate and reserved ids cannot replace sentinel criteria', () => {
  const pack = buildPromptPack('hello', { route: { candidates: [
    { capability: { id: '__proto__', name: 'Prototype tool' } },
    { capability: { id: 'none_of_these' } },
    { capability: { id: '__proto__', name: 'Prototype tool' } },
  ] }, projectMatches: [{ slug: 'none' }, { slug: 'p' }, { slug: 'p' }] });
  assert.equal(Object.keys(pack.questions.lane.criteria).length, 2);
  assert.equal(Object.keys(pack.questions.project.criteria).length, 2);
  assert.ok(Object.hasOwn(pack.questions.lane.criteria, '__proto__'));
});

test('tool pack supplies eight gates, hard negatives and only argv paths', () => {
  const pack = buildToolPack('cat "./path with spaces.txt" --output=/tmp/result https://example.com/health', 'read a file', { cwd: '/repo/src', repoRoot: '/repo' });
  assert.equal(pack.state.cwd_kind, 'repo');
  assert.deepEqual(pack.state.argv_paths, ['./path with spaces.txt', '/tmp/result']);
  assert.equal(Object.keys(pack.questions).length, 11);
  assert.equal(pack.fields.read_only.planField, 'safety.read_only');
  assert.equal(pack.fields.needs_human.planField, null);
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
    goalScale: 3, goalConfidence: 'medium', correctionDetected: true, fanoutAggression: 'off',
    blockedBy: ['auth_sensitive'], executionLane: 'worker_skill', projectSlug: 'project-0' });
  assert.deepEqual(RULES_ENGINE_BANDS, { high: 0.9, medium: 0.7, low: 0.5, none: 0.5 });
  assert.equal(answers.intent.type, 'choice');
  assert.equal(answers.intent.confidence, 0.9);
  assert.equal(answers.action.confidence, 0.5);
  assert.equal(answers.goal_scale.score, 2);
  assert.equal(answers.goal_scale.confidence, 0.7);
  assert.equal(Object.keys(answers.goal_scale.legend).length, 4);
  assert.equal(answers.lane.choice, 'worker_skill');
  assert.deepEqual(answers.auth_sensitive, { type: 'noul', noul: 1 });
  assert.deepEqual(answers.browser_control, { type: 'noul', noul: 0 });
  assert.deepEqual(answers.correction, { type: 'noul', noul: 1 });
  for (const answer of Object.values(answers).filter((entry) => entry.probabilities)) {
    assert.ok(Math.abs(Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0) - 1) < 1e-10);
  }
  assert.equal(answersFromRules(buildToolPack('cat a', 'read'), ['read_only']).read_only.noul, 1);
  assert.equal(answersFromRules(buildToolPack('rm a', 'delete'), { labels: ['destructive_or_approval_sensitive'] }).destructive_or_approval_sensitive.noul, 1);
});

test('rules fallback retains labels without a mapped plan field', () => {
  const answers = answersFromRules(buildToolPack('login', 'authenticate'), ['needs_human', 'description_matches_command']);
  assert.equal(answers.needs_human.noul, 1);
  assert.equal(answers.description_matches_command.noul, 1);
  assert.equal(answersFromRules(buildPromptPack('work'), { prompt_injection: true }).prompt_injection.noul, 1);
});

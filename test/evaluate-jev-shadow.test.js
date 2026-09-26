'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
test('rules evaluator reports corpus accuracy, label scores and reliability without credentials', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-evaluate-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, MYOS_HOME_ROOT: home, OPENCLAW_HOME_ROOT: home, MYOS_WORKSPACE_ROOT: home, MYOS_JEV_ENABLED: '0', MYOS_BACKGROUND_AGENTS_ENABLED: '0' };
  delete env.TYPESAFE_API_KEY;
  const script = path.resolve(__dirname, '../scripts/evaluate-jev-shadow.js');
  const args = [script, '--prompt-corpus', path.join(__dirname, 'fixtures/jev-prompt-corpus-fixture.jsonl'), '--tool-corpus', path.join(__dirname, 'fixtures/jev-tool-safety-fixture.json'), '--json'];
  const report = JSON.parse(execFileSync(process.execPath, args, { env, encoding: 'utf8' }));
  assert.equal(report.mode, 'rules');
  assert.equal(report.prompts.n, 10);
  assert.equal(report.tools.n, 20);
  assert.equal(report.prompts.fields.actionType.rules.truthN, 9);
  assert.ok(report.prompts.fields.actionType.legacy);
  assert.ok(report.tools.engines.legacy);
  assert.ok(report.tools.engines.rules);
  assert.ok(report.tools.engines.incumbent);
  assert.equal(report.tools.reliability.rules.read_only.reliability.length, 10);
  for (const [engine, labels] of Object.entries(report.tools.reliability)) {
    for (const [label, metrics] of Object.entries(labels)) {
      assert.equal(metrics.reliability.length, 10, `${engine}:${label}`);
      assert.equal(metrics.reliability.reduce((sum, bin) => sum + bin.n, 0), report.tools.n, `${engine}:${label}`);
      assert.equal(metrics.reliability[9].n, report.tools.n);
      const scores = report.tools.engines[engine][label];
      assert.equal(metrics.reliability[9].empiricalAgreement, (report.tools.n - scores.fp - scores.fn) / report.tools.n);
    }
  }
  assert.equal(typeof report.tools.engines.rules.user_visible_send.f1, 'number');
  assert.deepEqual(report.eligibleFields, []);
  const limited = JSON.parse(execFileSync(process.execPath, [...args, '--limit', '2', '--field', 'actionType'], { env, encoding: 'utf8' }));
  assert.equal(limited.prompts.n, 2);
  assert.deepEqual(Object.keys(limited.prompts.fields), ['actionType']);
  const strict = spawnSync(process.execPath, [...args, '--strict'], { env, encoding: 'utf8' });
  assert.equal(strict.status, report.regressions.length ? 1 : 0);
  fs.mkdirSync(path.join(home, 'logs'));
  fs.mkdirSync(path.join(home, 'state'));
  fs.writeFileSync(path.join(home, 'logs/jev-shadow.jsonl'), JSON.stringify({ event: 'prompt', engine: 'jev', legacy: { goalScale: 3 }, decided: { goal_scale: { type: 'score', score: 2.06, confidence: 0.89 } } }) + '\n');
  const bins = Array.from({ length: 10 }, (_, i) => ({ n: i === 9 ? 200 : 0, agree: i === 9 ? 190 : 0 }));
  fs.writeFileSync(path.join(home, 'state/jev-shadow-state.json'), JSON.stringify({ metrics: { goalScale: { n: 200, agree: 190, sumConfidence: 190, bins } } }));
  const ledger = JSON.parse(execFileSync(process.execPath, [script, '--json'], { env, encoding: 'utf8' }));
  assert.equal(ledger.ledger.fields.goalScale.agreement, 1);
  assert.equal(ledger.ledger.fields.goalScale.meanConfidence, 0.89);
  assert.equal(ledger.ledger.fields.goalScale.reliability[8].n, 1);
  assert.deepEqual(ledger.eligibleFields, []);
});

test('evaluator reads directories and globs with a global limit and excludes rules self-agreement', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-ledgers-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const row = { event: 'prompt', engine: 'jev', legacy: { actionType: 'read' }, decided: { action: { choice: 'read', confidence: 0.95 } } };
  fs.writeFileSync(path.join(home, 'jev-shadow.20260926-010101.jsonl'), Array(200).fill(JSON.stringify(row)).join('\n') + '\n');
  fs.writeFileSync(path.join(home, 'jev-shadow.jsonl'), JSON.stringify(row) + '\n' + JSON.stringify({ ...row, engine: 'rules' }) + '\n');
  fs.writeFileSync(path.join(home, 'unrelated.jsonl'), 'not JSON');
  const env = { ...process.env, MYOS_HOME_ROOT: home, MYOS_WORKSPACE_ROOT: home, OPENCLAW_HOME_ROOT: home, MYOS_JEV_ENABLED: '0' };
  for (const input of [home, path.join(home, 'jev-shadow*.jsonl')]) {
    const args = [path.resolve(__dirname, '../scripts/evaluate-jev-shadow.js'), '--ledger', input, '--json'];
    const report = JSON.parse(execFileSync(process.execPath, args, { env, encoding: 'utf8' }));
    assert.equal(report.ledger.fields.actionType.n, 201);
    assert.deepEqual(report.eligibleFields, ['actionType']);
    const limited = JSON.parse(execFileSync(process.execPath, [...args, '--limit', '2'], { env, encoding: 'utf8' }));
    assert.equal(limited.ledger.fields.actionType.n, 2);
  }
});

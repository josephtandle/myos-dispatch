'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const hook = path.resolve(__dirname, '../bin/myos-dispatch-hook');
for (const surface of ['claude', 'codex']) {
  test(`${surface} CLI fails open with disabled or unconfigured Jev`, (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-hook-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const env = { ...process.env, MYOS_HOME_ROOT: home, OPENCLAW_HOME_ROOT: home, MYOS_WORKSPACE_ROOT: home,
      MYOS_DISPATCH_HOOK_LOG_DIR: path.join(home, 'logs'), MYOS_BACKGROUND_AGENTS_ENABLED: '0', MYOS_AUTO_FANOUT: '0' };
    delete env.TYPESAFE_API_KEY;
    const run = (input, flags = [], enabled = '0') => execFileSync(process.execPath,
      [hook, `--surface=${surface}`, ...flags], { input, encoding: 'utf8', env: { ...env, MYOS_JEV_ENABLED: enabled } });
    for (const payload of [
      { hook_event_name: 'UserPromptSubmit', prompt: 'Explain the report format', cwd: home },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf ./synthetic-cache', description: 'Delete synthetic cache' }, cwd: home },
    ]) {
      const input = JSON.stringify(payload);
      const disabled = run(input);
      assert.ok(disabled.length < 10000);
      JSON.parse(disabled);
      assert.equal(disabled, run(input, ['--no-jev'], '1'));
      const missing = run(input, [], '1');
      JSON.parse(missing);
      if (payload.hook_event_name === 'UserPromptSubmit') {
        assert.match(disabled, /\[Jev\] skipped: disabled/);
        assert.match(missing, /\[Jev\] skipped: typesafe_key_missing/);
        assert.equal(missing.replace('typesafe_key_missing', 'disabled'), disabled);
      } else {
        assert.equal(missing, disabled);
        assert.doesNotMatch(missing, /jev=/);
      }
    }
    const rendered = run('Explain the report format', ['--render-route']);
    assert.match(rendered, /\[Jev\] skipped: disabled/);
    assert.equal(rendered, run('Explain the report format', ['--render-route', '--no-jev'], '1'));
    assert.equal(run('Explain the report format', ['--render-route'], '1').replace('typesafe_key_missing', 'disabled'), rendered);
    const records = fs.readFileSync(path.join(home, 'logs/myos-dispatch-hooks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const prompt = records.find(row => row.hookEventName === 'UserPromptSubmit');
    for (const key of ['intentType', 'actionType', 'goalScale', 'goalMode', 'goalConfidence', 'aggression', 'depth', 'requiresPlan', 'requiresApproval', 'blockedBy', 'jev']) assert.ok(Object.hasOwn(prompt, key), key);
  });
}
test('CLI model metadata and thrown attachments preserve the legacy route', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-hook-fake-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const preload = path.join(home, 'preload.cjs');
  const shadowPath = require.resolve('../src/decision/jev-shadow');
  const clientPath = require.resolve('../src/runtime/jev-client');
  const livePath = require.resolve('./fixtures/jev-prompt-answers-live.json');
  fs.writeFileSync(preload, `
    const client = require(${JSON.stringify(clientPath)});
    client.createJevClient = () => ({ isConfigured: () => true, ask: async () => ({ ok: true, ...require(${JSON.stringify(livePath)}), usage: { input_tokens: 12 } }) });
    if (process.env.JEV_TEST_THROW === '1') require(${JSON.stringify(shadowPath)}).attachJevShadow = async () => { throw new Error('synthetic error'); };
  `);
  const env = { ...process.env, MYOS_HOME_ROOT: home, OPENCLAW_HOME_ROOT: home, MYOS_WORKSPACE_ROOT: home,
    MYOS_DISPATCH_HOOK_LOG_DIR: path.join(home, 'logs'), MYOS_BACKGROUND_AGENTS_ENABLED: '0', MYOS_AUTO_FANOUT: '0', MYOS_JEV_ENABLED: '1', MYOS_JEV_STAGE: 'shadow' };
  delete env.TYPESAFE_API_KEY;
  const run = extra => JSON.parse(execFileSync(process.execPath, ['--require', preload, hook, '--surface=codex'], {
    input: JSON.stringify({ prompt: 'Explain the synthetic report', cwd: home }), encoding: 'utf8', env: { ...env, ...extra },
  })).hookSpecificOutput.additionalContext;
  const disabled = run({ MYOS_JEV_ENABLED: '0' });
  const model = run({});
  assert.match(model, /\[Jev\] stage=shadow engine=jev agree=\d+\/\d+ latency=\d+ms/);
  assert.equal(model.replace(/\[Jev\][^\n]+/, '[Jev] skipped: disabled'), disabled);
  assert.equal(run({ JEV_TEST_THROW: '1' }).replace('internal_error', 'disabled'), disabled);
  const records = fs.readFileSync(path.join(home, 'logs/myos-dispatch-hooks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const summary = records.find(row => row.jev.engine === 'jev').jev;
  assert.equal(summary.model, 'jev-1.13.0');
  assert.equal(summary.inputTokens, 12);
  assert.deepEqual(Object.keys(summary).sort(), ['stage', 'engine', 'skipped', 'agree', 'n', 'latencyMs', 'inputTokens', 'model'].sort());
});

"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isTier0Command, shouldSamplePrompt } = require('../bin/myos-dispatch-hook');
const hook = path.resolve(__dirname, '../bin/myos-dispatch-hook');

function isolatedEnv(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tier0-hook-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { ...process.env, MYOS_HOME_ROOT: home, OPENCLAW_HOME_ROOT: home, MYOS_WORKSPACE_ROOT: home,
    MYOS_DISPATCH_HOOK_LOG_DIR: path.join(home, 'logs'), MYOS_BACKGROUND_AGENTS_ENABLED: '0',
    MYOS_AUTO_FANOUT: '0', MYOS_JEV_ENABLED: '0' };
}

for (const prompt of ['ok', 'okay', 'yes', 'no', 'thanks', 'thank you', 'go', 'go ahead', 'continue',
  'keep going', 'do it', 'sure', 'great', 'nice', 'cool', 'got it', 'k', 'y', 'n',
  'https://example.com/a?q=b', 'http://example.com', '<machine>block', '[machine block]']) {
  test(`prompt follows normal routing: ${prompt}`, t => {
    const env = isolatedEnv(t);
    for (const render of [false, true]) {
      const output = execFileSync(process.execPath, [hook, '--surface=codex', ...(render ? ['--render-route'] : [])], {
        env, encoding: 'utf8', input: render ? prompt : JSON.stringify({ prompt }),
      });
      assert.match(output, /\[MyOS Dispatch route\]/);
      assert.match(output, /\[Jev\] skipped: disabled/);
      assert.doesNotMatch(output, /tier0_trivial/);
    }
  });
}

test('tool output is silent and tier0 and safety-only logs retain legacy intent policies', t => {
  const env = isolatedEnv(t);
  const commands = ['cat README.md', 'printf hello'];
  for (const surface of ['claude', 'codex']) {
    for (const command of commands) {
      const output = execFileSync(process.execPath, [hook, `--surface=${surface}`], {
        env, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash',
          tool_input: { command } }),
      });
      assert.equal(output, '');
    }
  }
  const rows = fs.readFileSync(path.join(env.MYOS_HOME_ROOT, 'logs/myos-dispatch-hooks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 4);
  for (const [index, row] of rows.entries()) {
    const tier0 = index % commands.length === 0;
    assert.equal(tier0 ? row.branch : row.route.branch, tier0 ? 'tier0' : 'tool_safety');
    assert.equal(row.jev.skipped, tier0 ? 'tier0_trivial' : 'disabled');
    assert.equal(row.intentFidelity.version, 'intent-fidelity-v1');
    assert.equal(row.intentHorizon.version, 'intent-horizon-v1');
    const legacy = execFileSync(process.execPath, ['-e', `
      const { resolveDispatchPlan } = require('./src/workspace-context');
      const plan = resolveDispatchPlan(process.argv[1], { hookSurface: process.argv[2], hookEventName: 'PreToolUse' });
      process.stdout.write(JSON.stringify(plan.parallelizationPlan.executionEnvelope.features));
    `, commands[index % commands.length], row.surface], { env, encoding: 'utf8', cwd: path.dirname(path.dirname(hook)) });
    const features = JSON.parse(legacy);
    assert.deepEqual(row.intentFidelity, features.intentFidelity);
    assert.deepEqual(row.intentHorizon, features.intentHorizon);
  }
});

for (const command of ['ls', 'cat a', 'head a', 'tail a', 'grep x a', 'rg x', 'find . -name a', 'pwd',
  'echo hello', 'which node', 'wc a', 'stat a', 'du .', 'df', 'ps', 'sysctl -n hw.ncpu', 'uname', 'date',
  'whoami', 'id', 'git status', 'git log', 'git diff', 'git show', 'git branch', 'git rev-parse HEAD',
  'node --version', 'npm --version', 'python3 --version', 'cd /tmp && ls', 'cd "a b" && cat a',
  'export X=Y && ls', 'export PATH="/bin:$PATH" && cd /tmp && ls | head -5', 'cat a | grep x | wc -l']) {
  test(`tier0 command: ${command}`, () => assert.equal(isTier0Command(command), true));
}
for (const command of ['ls; rm -rf x', 'cat a > b', 'cat a >> b', 'grep x $(cat f)', 'echo `date`',
  'sudo ls', 'ls | xargs cat', 'find . -exec cat {} +', 'ls | tee output', 'curl https://example.com', 'ssh host',
  'ls && rm x', 'ls &', 'ls || echo fail', 'ls\nrm x', 'ls |', 'env git status', 'X=Y git status',
  'export GIT_CONFIG_COUNT=1 && git status', 'git branch -D main', 'git branch new', 'git diff --output=a',
  'git show --textconv', 'find . -delete', 'find . -fprint file', 'sysctl -w key=value', 'date --set=now',
  'node --version -e code', 'npm install', 'python3 script.py', 'echo hello | sh', 'rg --pre=sh x',
  'find . "-delete"', 'git diff "--output=file"', 'sysctl -f config', 'date "-s" now',
  'export NODE_OPTIONS=--require=./a.js && node --version', 'export LD_PRELOAD=./a.so && cat a',
  'cat "unterminated', 'cat <(echo hi)', 'printf hello']) {
  test(`nontrivial command: ${command}`, () => assert.equal(isTier0Command(command), false));
}

test('sampling is deterministic with endpoints, invalid defaults and prompt authority bypass', () => {
  const state = { config: { authoritativeFields: ['safety.browser_control'] } };
  const prompts = Array.from({ length: 1000 }, (_, i) => `Explain report ${i}`);
  const sample = prompts.map(prompt => shouldSamplePrompt(prompt, state, {}));
  assert.deepEqual(sample, prompts.map(prompt => shouldSamplePrompt(prompt, state, {})));
  assert.ok(sample.filter(Boolean).length > 150 && sample.filter(Boolean).length < 250);
  for (const prompt of prompts.slice(0, 20)) {
    assert.equal(shouldSamplePrompt(prompt, state, { MYOS_JEV_PROMPT_SAMPLE: '0' }), false);
    assert.equal(shouldSamplePrompt(prompt, state, { MYOS_JEV_PROMPT_SAMPLE: '1' }), true);
    for (const invalid of ['bad', '-1', '1.1', '']) assert.equal(
      shouldSamplePrompt(prompt, state, { MYOS_JEV_PROMPT_SAMPLE: invalid }), shouldSamplePrompt(prompt, state, {}));
    assert.equal(shouldSamplePrompt(prompt, { config: { authoritativeFields: ['blockedBy.auth_sensitive'] } },
      { MYOS_JEV_PROMPT_SAMPLE: '0' }), true);
  }
});

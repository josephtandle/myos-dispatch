"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { isTier0Prompt, isTier0Command, shouldSamplePrompt } = require('../bin/myos-dispatch-hook');

for (const prompt of ['ok', 'okay', 'yes', 'no', 'thanks', 'thank you', 'go', 'go ahead', 'continue',
  'keep going', 'do it', 'sure', 'great', 'nice', 'cool', 'got it', 'k', 'y', 'n']) {
  test(`tier0 acknowledgement: ${prompt}`, () => {
    assert.equal(isTier0Prompt(prompt), true);
    assert.equal(isTier0Prompt(`  ${prompt.toUpperCase()}!!! `), true);
  });
}
for (const prompt of ['https://example.com/a?q=b', 'http://example.com', '<machine>block', '[machine block]']) {
  test(`tier0 raw input: ${prompt}`, () => assert.equal(isTier0Prompt(prompt), true));
}
for (const prompt of ['', 'red lighting', 'mute Mac studio', 'Jarvis good night', 'yes fix it', 'https://example.com fix this']) {
  test(`substantive prompt: ${prompt}`, () => assert.equal(isTier0Prompt(prompt), false));
}
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

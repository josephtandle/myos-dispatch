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
      MYOS_DISPATCH_HOOK_LOG_DIR: path.join(home, 'logs'), MYOS_BACKGROUND_AGENTS_ENABLED: '0', MYOS_AUTO_FANOUT: '0', MYOS_JEV_PROMPT_SAMPLE: '1' };
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
    MYOS_DISPATCH_HOOK_LOG_DIR: path.join(home, 'logs'), MYOS_BACKGROUND_AGENTS_ENABLED: '0', MYOS_AUTO_FANOUT: '0', MYOS_JEV_PROMPT_SAMPLE: '1', MYOS_JEV_ENABLED: '1', MYOS_JEV_STAGE: 'shadow' };
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

test('PreToolUse renders an authoritative Jev label when legacy safety is empty', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-hook-tool-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const preload = path.join(home, 'preload.cjs');
  const clientPath = require.resolve('../src/runtime/jev-client');
  fs.writeFileSync(preload, `
    require(${JSON.stringify(clientPath)}).createJevClient = () => ({
      isConfigured: () => true,
      ask: async (state, questions) => ({ ok: true, answers: Object.fromEntries(Object.keys(questions)
        .map(key => [key, { type: 'noul', noul: key === 'browser_control' ? 0.95 : 0.1 }])) }),
    });
  `);
  fs.mkdirSync(path.join(home, 'state'));
  fs.writeFileSync(path.join(home, 'state/jev-shadow-state.json'), JSON.stringify({
    stage: 'authoritative', authoritativeFields: ['safety.browser_control'], floors: { 'safety.browser_control': 0.7 },
  }));
  const env = { ...process.env, MYOS_HOME_ROOT: home, OPENCLAW_HOME_ROOT: home, MYOS_WORKSPACE_ROOT: home,
    MYOS_DISPATCH_HOOK_LOG_DIR: path.join(home, 'logs'), MYOS_BACKGROUND_AGENTS_ENABLED: '0', MYOS_AUTO_FANOUT: '0', MYOS_JEV_PROMPT_SAMPLE: '1' };
  delete env.TYPESAFE_API_KEY;
  delete env.MYOS_JEV_STAGE;
  const run = enabled => execFileSync(process.execPath, ['--require', preload, hook, '--surface=codex'], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'printf hello', description: 'Print greeting' }, cwd: home }),
    encoding: 'utf8', env: { ...env, MYOS_JEV_ENABLED: enabled },
  });
  assert.doesNotMatch(run('0'), /MyOS Dispatch tool safety/);
  assert.match(run('1'), /\[MyOS Dispatch tool safety\] browser_control/);
  const entry = JSON.parse(fs.readFileSync(path.join(home, 'logs/jev-shadow.jsonl'), 'utf8'));
  assert.equal(entry.legacy['safety.browser_control'], false);
});

function isolatedEnv(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-hook-bounds-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { ...process.env, MYOS_HOME_ROOT: home, OPENCLAW_HOME_ROOT: home, MYOS_WORKSPACE_ROOT: home,
    MYOS_DISPATCH_HOOK_LOG_DIR: path.join(home, 'logs'), MYOS_BACKGROUND_AGENTS_ENABLED: '0', MYOS_AUTO_FANOUT: '0', MYOS_JEV_PROMPT_SAMPLE: '1',
    MYOS_JEV_ENABLED: '1', MYOS_JEV_STAGE: 'shadow', TYPESAFE_API_KEY: 'synthetic' };
}

test('malformed stdin retains exit 1 and a stack on stderr', t => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [hook], { input: '{broken', encoding: 'utf8', env: isolatedEnv(t) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SyntaxError/);
  assert.match(result.stderr, /at /);
});

test('hung transport exits within twice the tool budget after flushing stdout', async t => {
  const { spawn } = require('node:child_process');
  const env = { ...isolatedEnv(t), MYOS_JEV_TEST_HANG: '1', MYOS_JEV_TOOL_TIMEOUT_MS: '900' };
  const started = Date.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook, '--surface=codex'], { env, timeout: 1800 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
    child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf ./synthetic-cache' }, cwd: env.MYOS_HOME_ROOT }));
  });
  const elapsed = Date.now() - started;
  t.diagnostic(`hang hook exit: ${elapsed} ms (900 ms tool budget)`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  JSON.parse(result.stdout);
  assert.ok(elapsed < 1800, `hook exited in ${elapsed} ms`);
  const ledger = JSON.parse(fs.readFileSync(path.join(env.MYOS_HOME_ROOT, 'logs/jev-shadow.jsonl')));
  assert.equal(ledger.skipped, 'timeout');
});

test('shadow flushes before completion, authority waits, and both append the ledger', async t => {
  const { spawn } = require('node:child_process');
  for (const stage of ['shadow', 'authoritative']) {
    const env = { ...isolatedEnv(t), MYOS_JEV_STAGE: stage, MYOS_JEV_TOOL_TIMEOUT_MS: '900' };
    const home = env.MYOS_HOME_ROOT;
    const preload = path.join(home, 'preload.cjs');
    fs.mkdirSync(path.join(home, 'state'));
    fs.writeFileSync(path.join(home, 'state/jev-shadow-state.json'), JSON.stringify({ authoritativeFields: ['safety.browser_control'] }));
    fs.writeFileSync(preload, `require(${JSON.stringify(require.resolve('../src/runtime/jev-client'))}).createJevClient = () => ({
      isConfigured: () => true, ask: async (_, questions) => {
        await new Promise(resolve => setTimeout(resolve, 400));
        require('node:fs').writeFileSync(${JSON.stringify(path.join(home, 'completed'))}, 'yes');
        return { ok: true, answers: Object.fromEntries(Object.keys(questions).map(key => [key, { noul: key === 'browser_control' ? 1 : 0 }])) };
      }
    });`);
    let completedAtOutput;
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--require', preload, hook, '--surface=codex'], { env, timeout: 3000 });
      let text = '';
      child.stdout.on('data', chunk => {
        completedAtOutput ??= fs.existsSync(path.join(home, 'completed'));
        text += chunk;
      });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(text) : reject(new Error(`exit ${code}`)));
      child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf ./synthetic-cache' }, cwd: home }));
    });
    assert.equal(completedAtOutput, stage === 'authoritative');
    if (stage === 'authoritative') assert.match(output, /tool safety.*browser_control/);
    else assert.doesNotMatch(output, /browser_control/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'logs/jev-shadow.jsonl'))).engine, 'jev');
  }
});

test('prompt and tool timeout settings have separate defaults and clamp to 200..2500', t => {
  const env = isolatedEnv(t);
  const preload = path.join(env.MYOS_HOME_ROOT, 'preload.cjs');
  const observed = path.join(env.MYOS_HOME_ROOT, 'timeout.json');
  fs.writeFileSync(preload, `require(${JSON.stringify(require.resolve('../src/runtime/jev-client'))}).createJevClient = opts => {
    require('node:fs').writeFileSync(${JSON.stringify(observed)}, JSON.stringify(opts));
    return { isConfigured: () => false };
  };`);
  for (const tool of [false, true]) for (const [raw, expected] of [[undefined, tool ? 900 : 1500], ['4000', 2500], ['-1', 200], ['0', 200]]) {
    const local = { ...env };
    delete local.MYOS_JEV_TIMEOUT_MS;
    delete local.MYOS_JEV_TOOL_TIMEOUT_MS;
    if (raw !== undefined) local[tool ? 'MYOS_JEV_TOOL_TIMEOUT_MS' : 'MYOS_JEV_TIMEOUT_MS'] = raw;
    const payload = tool ? { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'printf hello' } } : { prompt: 'Explain a report' };
    execFileSync(process.execPath, ['--require', preload, hook], { env: local, input: JSON.stringify(payload) });
    assert.equal(JSON.parse(fs.readFileSync(observed)).timeoutMs, expected);
  }
});


test('tier0 bypasses indexes, rules and Jev while retaining logging and RTK rewriting', t => {
  const env = isolatedEnv(t);
  const home = env.MYOS_HOME_ROOT;
  const preload = path.join(home, 'preload-tier0.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const read = fs.readFileSync;
    fs.readFileSync = (file, ...args) => {
      if (typeof file === 'string' && /(?:capabilities-index|DISPATCH-FASTPATHS|_index)\\.json$/.test(file)) throw new Error('index loaded');
      return read(file, ...args);
    };
    const ws = require(${JSON.stringify(require.resolve('../src/workspace-context'))});
    ws.resolveDispatchPlan = ws.resolveToolSafetyPlan = () => { throw new Error('rules invoked'); };
    require(${JSON.stringify(require.resolve('../src/runtime/jev-client'))}).createJevClient = () => { throw new Error('Jev invoked'); };
    require('node:child_process').spawnSync = (command) => {
      if (command !== 'rtk') throw new Error('unexpected subprocess');
      return { status: 0, stdout: JSON.stringify({hookSpecificOutput:{updatedInput:{command:'rtk ls'}}}) };
    };
  `);
  const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } };
  const output = JSON.parse(execFileSync(process.execPath, ['--require', preload, hook, '--surface=claude', '--rewrite'], {
    env, encoding: 'utf8', input: JSON.stringify(payload),
  })).hookSpecificOutput;
  assert.deepEqual(output, { hookEventName: 'PreToolUse', updatedInput: { command: 'rtk ls' } });
  const rows = fs.readFileSync(path.join(home, 'logs/myos-dispatch-hooks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.ok(rows.every(row => row.branch === 'tier0' && row.jev.skipped === 'tier0_trivial'));
  assert.equal(fs.existsSync(path.join(home, 'logs/jev-shadow.jsonl')), false);
});

test('sampled-out prompts retain the route and authority bypasses sampling; tools always run', t => {
  const env = { ...isolatedEnv(t), MYOS_JEV_PROMPT_SAMPLE: '0' };
  const home = env.MYOS_HOME_ROOT;
  const preload = path.join(home, 'sample.cjs');
  fs.writeFileSync(preload, `require(${JSON.stringify(require.resolve('../src/runtime/jev-client'))}).createJevClient = () => ({
    isConfigured: () => true, ask: async (_, questions) => ({ok:true, answers:Object.fromEntries(Object.entries(questions).map(([key,q]) => [key,
      q.type === 'noul' ? {noul:0} : q.type === 'score' ? {score:1,confidence:0.9} : {choice:Object.keys(q.criteria)[0],confidence:0.9}]))})
  });`);
  const run = (payload, extra = {}) => execFileSync(process.execPath, ['--require', preload, hook, '--surface=codex'], {
    env: { ...env, ...extra }, encoding: 'utf8', input: JSON.stringify(payload),
  });
  const payload = { prompt: 'Explain the synthetic report format', cwd: home };
  const skipped = run(payload);
  assert.match(skipped, /skipped: sampled_out/);
  assert.equal(run(payload), skipped);
  assert.equal(run(payload, { MYOS_JEV_ENABLED: '0' }).replace('[Jev] skipped: disabled', '[Jev] skipped: sampled_out'), skipped);
  const rows = fs.readFileSync(path.join(home, 'logs/myos-dispatch-hooks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const withoutObservation = ({ at, jev, ...row }) => row;
  assert.deepEqual(withoutObservation(rows[0]), withoutObservation(rows[2]));
  assert.equal(fs.existsSync(path.join(home, 'logs/jev-shadow.jsonl')), false);
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state/jev-shadow-state.json'), JSON.stringify({ authoritativeFields: ['blockedBy.auth_sensitive'] }));
  assert.match(run(payload), /engine=jev/);
  fs.writeFileSync(path.join(home, 'state/jev-shadow-state.json'), JSON.stringify({ authoritativeFields: ['safety.browser_control'] }));
  run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'printf hello' } });
  const ledger = fs.readFileSync(path.join(home, 'logs/jev-shadow.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(ledger.map(row => row.event), ['prompt', 'tool']);
});

test('Jev starts before each rules path and the prompt evidence is collected only once', t => {
  const env = { ...isolatedEnv(t), MYOS_JEV_STAGE: 'authoritative' };
  const home = env.MYOS_HOME_ROOT;
  const preload = path.join(home, 'order.cjs');
  const orderFile = path.join(home, 'order.json');
  fs.writeFileSync(preload, `
    const order = [];
    require(${JSON.stringify(require.resolve('../src/runtime/jev-client'))}).createJevClient = () => ({
      isConfigured: () => true, ask: async () => {
        order.push('ask');
        await new Promise(resolve => setTimeout(resolve, 100));
        return {ok:false,reason:'network_error'};
      }
    });
    const ws = require(${JSON.stringify(require.resolve('../src/workspace-context'))});
    for (const key of ['resolveDispatchPlan','resolveToolSafetyPlan']) {
      const original = ws[key];
      ws[key] = (...args) => {
        if (order[0] !== 'ask') throw new Error('Jev started late');
        order.push(key);
        return original(...args);
      };
    }
    ws.collectDispatchSignals = () => { throw new Error('duplicate signal collection'); };
    process.on('exit', () => require('node:fs').writeFileSync(${JSON.stringify(orderFile)}, JSON.stringify(order)));
  `);
  for (const [payload, resolver] of [[{prompt:'Explain the synthetic report'}, 'resolveDispatchPlan'],
    [{hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'printf hello'}}, 'resolveToolSafetyPlan']]) {
    execFileSync(process.execPath, ['--require', preload, hook, '--surface=codex'], {
      env, encoding: 'utf8', input: JSON.stringify(payload),
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(orderFile)), ['ask', resolver]);
  }
});

// Frozen legacy label order, captured from the original HEAD hook before accepting the safety-only change.
const legacyToolLabels = [
  ['rm -rf ./synthetic-cache', ['approval_sensitive_operation', 'destructive_or_approval_sensitive']],
  ['printf "rotate api key"', ['approval_sensitive_operation', 'auth_sensitive', 'destructive_or_approval_sensitive']],
  ['printf "send email to client"', ['user_visible_send']],
  ['printf "open browser page"', ['browser_control']],
  ['printf "login github account"', ['interactive_auth_action']],
  ['printf "update billing account"', ['approval_sensitive_operation', 'payment_or_account_mutation', 'destructive_or_approval_sensitive']],
  ['printf hello', []],
];

test('nontrivial tool context preserves the legacy fixture label bytes and order', t => {
  const env = { ...isolatedEnv(t), MYOS_JEV_ENABLED: '0' };
  for (const [command, labels] of legacyToolLabels) {
    const output = execFileSync(process.execPath, [hook, '--surface=codex'], {
      env, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {command} }),
    });
    const expected = labels.length ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
      additionalContext: `[MyOS Dispatch tool safety] ${labels.join(', ')}. Respect existing authorization and safety gates.` } }) + '\n' : '';
    assert.equal(output, expected, command);
  }
});

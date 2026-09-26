#!/usr/bin/env node
'use strict';
const { createJevClient } = require('../src/runtime/jev-client');
const { buildPromptPack, buildToolPack } = require('../src/decision/jev-packs');
async function main() {
  const client = createJevClient({ timeoutMs: Number(process.env.MYOS_JEV_TIMEOUT_MS) || 1500, maxRetries: 0 });
  if (!client.isConfigured()) {
    console.error('Jev smoke unavailable: not configured or disabled');
    process.exitCode = 2;
    return;
  }
  for (const [name, pack] of [['prompt', buildPromptPack('Explain how this synthetic report works')], ['tool', buildToolPack('ls -la', 'List directory entries')]]) {
    const result = await client.ask(pack.state, pack.questions);
    console.log(JSON.stringify({ pack: name, ok: result.ok, reason: result.reason, latencyMs: result.latencyMs,
      model: result.model || client.model, usage: result.usage || null, requestId: result.requestId || null, fields: result.answers || null }));
    if (!result.ok) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

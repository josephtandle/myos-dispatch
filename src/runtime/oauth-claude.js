"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function isClaudeTextRequest(options = {}) {
  if (options.audio || options.searchGrounding || options.images || options.attachments ||
      (options.tools && (!Array.isArray(options.tools) || options.tools.length))) return false;
  if (options.messages && !Array.isArray(options.messages)) return false;
  return (options.messages || []).every(message => typeof message.content === "string" ||
    (Array.isArray(message.content) && message.content.every(part => typeof part === "string" ||
      (part?.type === "text" && typeof part.text === "string"))));
}

async function executeClaudeText(options, dependencies = {}) {
  if (!isClaudeTextRequest(options)) throw new Error("Claude OAuth is text-only and does not support tools, grounding or media");
  if (!/^claude-[a-z0-9.-]+$/.test(options.model || "")) throw new Error("Claude OAuth requires an exact model ID");
  const maxOutputTokens=options.maxOutputTokens ?? 4000;
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 32000) throw new Error("Invalid Claude output token budget");
  const {runCommand} = require("../background/background-agent-runner");
  const run = dependencies.runCommand || runCommand;
  // Desktop IPC credentials are session-owned, not a portable CLI login.
  const env = Object.fromEntries(Object.entries(dependencies.env || process.env).filter(([key]) =>
    !/^CLAUDE|^ANTHROPIC|API_KEY|AUTH_TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL/i.test(key)));
  env.MYOS_BACKGROUND_AGENTS_ENABLED = "0";
  env.MYOS_BACKGROUND_IS_SIDECAR = "1";
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS=String(maxOutputTokens);
  env.CLAUDE_CODE_MAX_TURNS="1";
  env.CLAUDE_CODE_MAX_RETRIES="0";
  const deadline = Date.now() + (options.timeoutMs || 180000);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "myos-claude-text-"));
  try {
    const command = "claude";
    const auth = await run({command,args:["auth","status","--json"],cwd,env,timeoutMs:Math.min(8000,deadline-Date.now())});
    let status;
    try {status=JSON.parse(auth.stdout);} catch {throw new Error("Claude subscription authentication status unavailable");}
    if (auth.code !== 0 || auth.signal || auth.cleanupFailed || !status.loggedIn || status.authMethod !== "claude.ai") {
      throw new Error("Claude subscription login required");
    }
    if (Date.now() >= deadline) throw new Error("Claude OAuth execution deadline exceeded");
    const result = await run({command,cwd,env,input:options.prompt,timeoutMs:deadline-Date.now(),args:[
      "-p","--output-format","json","--model",options.model,"--effort",options.effort || "low",
      "--tools","","--permission-mode","dontAsk","--strict-mcp-config","--disable-slash-commands",
      "--no-session-persistence","--setting-sources","",
      "--settings",JSON.stringify({forceLoginMethod:"claudeai",disableAllHooks:true}),
    ]});
    let payload;
    try {payload=JSON.parse(result.stdout);} catch {throw new Error("Claude OAuth returned malformed output");}
    if (result.code !== 0 || result.signal || result.cleanupFailed || payload.is_error || !payload.result?.trim()) {
      const error=new Error(payload.result || "Claude OAuth execution failed");
      error.signal=result.signal; error.cleanupFailed=result.cleanupFailed;
      throw error;
    }
    const reported=Object.keys(payload.modelUsage || {});
    if (!reported.includes(options.model)) throw new Error("Claude OAuth reported model identity mismatch");
    const text=payload.result.trim();
    return {text,model:options.model,provider:"anthropic",estimatedCostUsd:0,
      json:options.responseMode === "json" ? JSON.parse(text) : null,
      usage:{inputTokens:Number(payload.usage?.input_tokens || 0)+Number(payload.usage?.cache_read_input_tokens || 0)+Number(payload.usage?.cache_creation_input_tokens || 0),outputTokens:Number(payload.usage?.output_tokens || 0)},
      raw:{provider:"claude-oauth",providerReportedModels:reported},
    };
  } finally {
    try {fs.rmdirSync(cwd);} catch { /* Retain unexpected artifacts. */ }
  }
}
module.exports={executeClaudeText,isClaudeTextRequest};

#!/usr/bin/env node
"use strict";

// Orchestrator-controlled background scout for MyOS Dispatch.
// Direct ad hoc launches are blocked so sidecars cannot miss orchestration
// metadata, health gates, and result collection.

const os = require("node:os");

const { runBackgroundTask, normalizeWorkerKind } = require("../src/background/background-agent-runner");

function parseArgs(argv) {
  const args = {
    prompt: "",
    scope: "",
    provider: "",
    timeoutMs: 180000,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scope") args.scope = String(argv[++i] || "");
    else if (arg === "--provider") args.provider = String(argv[++i] || "");
    else if (arg === "--timeout-ms") args.timeoutMs = Math.max(10000, Number(argv[++i] || args.timeoutMs));
    else if (arg === "--help" || arg === "-h") args.help = true;
    else positional.push(arg);
  }
  args.prompt = positional.join(" ").trim();
  return args;
}

function usage() {
  console.log([
    'Usage: node agents/shared/bin/myos-sidecar.js "<question>" [--scope <dir>] [--provider codex|claude|gemini] [--timeout-ms <ms>]',
    "",
    "Runs one orchestrator-approved read-only background scout and prints JSON: status, summary, findings, risks, checks, confidence.",
    "Direct worker or nested sidecar launches are refused; use MyOS Dispatch fan-out instead.",
  ].join("\n"));
}

function assertCliAllowed(env = process.env) {
  if (String(env.MYOS_BACKGROUND_IS_SIDECAR || "") === "1" || String(env.MYOS_SIDECAR_ORCHESTRATED || "") === "1") {
    throw new Error("Refusing nested sidecar launch: all sidecars must be issued by the parent MyOS Dispatch orchestrator.");
  }
  if (String(env.MYOS_SIDECAR_CLI_ALLOWED || "") !== "1") {
    throw new Error("Refusing direct sidecar launch: call MyOS Dispatch fan-out so the orchestrator can track, gate, and collect results.");
  }
  if (!env.MYOS_SIDECAR_RUN_ID || !env.MYOS_SIDECAR_ORCHESTRATOR_TOKEN) {
    throw new Error("Refusing sidecar launch: missing orchestrator run id or token.");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.prompt) {
    usage();
    process.exitCode = args.prompt ? 0 : 1;
    return;
  }

  assertCliAllowed(process.env);

  const command = args.provider
    || process.env.MYOS_BACKGROUND_PROVIDER
    || process.env.MYOS_LOCAL_WORKER
    || "codex";
  const scope = args.scope || process.cwd();
  const task = {
    id: `midtask-${Date.now()}`,
    kind: "midtask",
    role: "scout",
    prompt: args.prompt,
    scope,
    ownershipPaths: [scope],
    writeScope: [],
    required: false,
    mode: "read_only",
    modelProfile: "openai_cheap_extraction",
    timeoutMs: args.timeoutMs,
  };

  const result = await runBackgroundTask(task, {
    command,
    callerProvider: normalizeWorkerKind(command),
    cwd: scope || os.homedir(),
    env: process.env,
    orchestratorContext: {
      orchestrator: process.env.MYOS_BACKGROUND_ORCHESTRATOR || "myos-dispatch",
      runId: process.env.MYOS_SIDECAR_RUN_ID,
      token: process.env.MYOS_SIDECAR_ORCHESTRATOR_TOKEN,
      parentTaskId: process.env.MYOS_SIDECAR_PARENT_TASK_ID || "cli",
    },
  });

  console.log(JSON.stringify({
    status: result.status,
    summary: result.summary,
    findings: result.findings,
    risks: result.risks || [],
    checks: result.checks || [],
    confidence: result.confidence,
    runner: result.runner,
    model: result.model,
    durationMs: result.durationMs,
  }, null, 2));
  process.exitCode = result.status === "completed" ? 0 : 1;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});

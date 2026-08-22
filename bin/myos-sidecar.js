#!/usr/bin/env node
"use strict";

// Orchestrator-controlled background scout for MyOS Dispatch.
// Direct ad hoc launches are blocked so sidecars cannot miss orchestration
// metadata, health gates, and result collection.

const os = require("node:os");

const fs = require("node:fs");
const path = require("node:path");

const { runBackgroundTask, normalizeWorkerKind } = require("../src/background/background-agent-runner");


// Kept in step with BACKGROUND_PROVIDER_PREFERENCE in bin/myos-dispatch-hook.
// codex first because it is strongest at bounded read-only scouting; the rest are
// used when that is what the machine has.
const PROVIDER_PREFERENCE = ["codex", "claude", "antigravity", "gemini"];

function resolveAvailableProvider() {
  const { spawnSync } = require("node:child_process");
  for (const candidate of PROVIDER_PREFERENCE) {
    try {
      const res = spawnSync("which", [candidate], { encoding: "utf8", timeout: 1000 });
      if (res.status === 0 && res.stdout.trim()) return candidate;
    } catch {}
  }
  return null;
}

function parseArgs(argv) {
  const args = {
    prompt: "",
    scope: "",
    provider: "",
    timeoutMs: 180000,
    id: "",
    kind: "",
    role: "",
    out: "",
    envelope: "",
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scope") args.scope = String(argv[++i] || "");
    else if (arg === "--provider") args.provider = String(argv[++i] || "");
    else if (arg === "--timeout-ms") args.timeoutMs = Math.max(10000, Number(argv[++i] || args.timeoutMs));
    else if (arg === "--id" || arg === "--lane-id" || arg === "--task-id") args.id = String(argv[++i] || "");
    else if (arg === "--kind") args.kind = String(argv[++i] || "");
    else if (arg === "--role") args.role = String(argv[++i] || "");
    else if (arg === "--out" || arg === "--result-file" || arg === "--output") args.out = String(argv[++i] || "");
    else if (arg === "--envelope" || arg === "--execution-envelope") args.envelope = String(argv[++i] || "");
    else if (arg === "--help" || arg === "-h") args.help = true;
    else positional.push(arg);
  }
  args.prompt = positional.join(" ").trim();
  return args;
}

function usage() {
  console.log([
    'Usage: node agents/shared/bin/myos-sidecar.js "<question>" [--scope <dir>] [--provider codex|claude|gemini] [--timeout-ms <ms>] [--out <file>] [--envelope <json>]',
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

function writeResultFile(filePath, data) {
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch {}
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.prompt) {
    usage();
    process.exitCode = args.prompt ? 0 : 1;
    return;
  }

  assertCliAllowed(process.env);

  let envelopeObj = null;
  if (args.envelope) {
    try {
      envelopeObj = typeof args.envelope === "object" ? args.envelope : JSON.parse(args.envelope);
    } catch {}
  }

  // Falling back to a bare "codex" meant a machine without it failed at spawn time
  // with ENOENT, after the caller's gate had already said yes. Resolve to something
  // this machine actually has, and say so clearly when it has nothing.
  const command = args.provider
    || process.env.MYOS_BACKGROUND_PROVIDER
    || process.env.MYOS_LOCAL_WORKER
    || resolveAvailableProvider();
  if (!command) {
    console.error(JSON.stringify({
      status: "skipped",
      reason: "no_background_provider_available",
      summary: "No background worker CLI found on this machine. Looked for: " +
        PROVIDER_PREFERENCE.join(", ") +
        ". Install one, or set MYOS_BACKGROUND_PROVIDER to the command you use.",
    }));
    process.exit(0);
  }
  const scope = args.scope || process.cwd();
  const task = {
    id: args.id || `midtask-${Date.now()}`,
    kind: args.kind || "midtask",
    role: args.role || "scout",
    prompt: args.prompt,
    scope,
    ownershipPaths: [scope],
    writeScope: [],
    required: false,
    mode: "read_only",
    modelProfile: "openai_cheap_extraction",
    timeoutMs: args.timeoutMs,
    ...(envelopeObj ? { executionEnvelope: envelopeObj } : {}),
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

  const outputData = {
    status: result.status,
    summary: result.summary,
    findings: result.findings,
    risks: result.risks || [],
    checks: result.checks || [],
    confidence: result.confidence,
    runner: result.runner,
    model: result.model,
    durationMs: result.durationMs,
  };

  writeResultFile(args.out, outputData);

  console.log(JSON.stringify(outputData, null, 2));
  process.exitCode = result.status === "completed" ? 0 : 1;
}

main().catch((error) => {
  const args = parseArgs(process.argv.slice(2));
  writeResultFile(args.out, {
    status: "failed",
    summary: error?.message || String(error),
    findings: [],
    risks: [],
    checks: [],
    confidence: "failed",
  });
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});

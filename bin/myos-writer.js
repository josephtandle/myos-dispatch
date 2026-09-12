#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { runBackgroundTasks, validateOwnershipPaths } = require("../src/background/background-agent-runner");
const MAX_PROMPT_BYTES = 32768;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

const HELP = `Usage: myos-writer --scope /repo --paths src/a.js,test/a.test.js
  --provider codex --model gpt-6-astra --caller-provider claude
  (--prompt "bounded implementation task" | --prompt-file /path/task.txt)
  [--timeout-ms 900000] [--json]
One human-interactive delegation. Returns a retained patch for independent review.
Never applies, commits, or accepts writer self-review. Prompt limit: 32768 bytes.
Timeout: integer 1..1800000 ms; default 900000 ms (15 minutes).
`;

function validateTimeoutMs(value = DEFAULT_TIMEOUT_MS) {
  if (!/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) ||
      Number(value) < 1 || Number(value) > MAX_TIMEOUT_MS) {
    throw new Error("--timeout-ms must be an integer from 1 to 1800000");
  }
  return Number(value);
}

function parseArgs(argv) {
  const values = {};
  const names = new Set(["scope", "paths", "provider", "model", "caller-provider", "prompt", "prompt-file", "timeout-ms"]);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, "");
    if (argv[i] !== `--${key}` || Object.hasOwn(values, key)) throw new Error(`Invalid or duplicate argument: ${argv[i]}`);
    if (key === "json" || key === "help") { values[key] = true; continue; }
    if (!names.has(key) || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`Unknown or missing argument: ${argv[i]}`);
    values[key] = argv[++i];
  }
  if (values.help) return values;
  for (const key of ["scope", "paths", "provider", "model", "caller-provider"]) {
    if (!values[key]) throw new Error(`--${key} is required`);
  }
  if (values.provider !== "codex" || values["caller-provider"] !== "claude") throw new Error("Only explicit Claude to Codex delegation is supported");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(values.model)) throw new Error("Invalid exact model identifier");
  if (Boolean(values.prompt) === Boolean(values["prompt-file"])) throw new Error("Provide exactly one of --prompt or --prompt-file");
  let prompt = values.prompt;
  if (values["prompt-file"]) {
    const fd = fs.openSync(values["prompt-file"], fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_PROMPT_BYTES) throw new Error("Prompt file must be a regular file of at most 32768 bytes");
      const buffer = Buffer.alloc(MAX_PROMPT_BYTES + 1);
      const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      prompt = buffer.subarray(0, count).toString("utf8");
    } finally { fs.closeSync(fd); }
  }
  if (!prompt.trim() || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES || prompt.includes("\0")) throw new Error("Prompt must contain 1 to 32768 bytes of text");
  const ownershipPaths = values.paths.split(",").map((entry) => entry.trim());
  if (ownershipPaths.some((entry) => !entry || path.isAbsolute(entry))) throw new Error("--paths requires nonempty repository-relative ownership paths");
  return { ...values, prompt, ownershipPaths, timeoutMs: validateTimeoutMs(values["timeout-ms"]) };
}

async function runWriter(options, runtime = {}) {
  let result;
  let artifactRoot;
  try {
    const timeoutMs = validateTimeoutMs(options.timeoutMs);
    if (options.provider !== "codex" || options["caller-provider"] !== "claude" ||
        !options.model || !options.prompt || Buffer.byteLength(options.prompt) > MAX_PROMPT_BYTES) {
      throw new Error("Explicit bounded Claude to Codex writer arguments are required");
    }
    const scope = fs.realpathSync(options.scope);
    const repoRoot = fs.realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: scope, encoding: "utf8" }).trim());
    if (scope !== repoRoot) throw new Error("--scope must name the repository root");
    const ownershipPaths = validateOwnershipPaths(repoRoot, options.ownershipPaths);
    const id = `writer-${crypto.randomUUID()}`;
    // Runtime injection is for embedding/tests; the CLI exposes no command or env overrides.
    const task = { id, kind: "implement", role: "implement", taskClass: "heavy_synthesis", required: true,
      mode: "workspace_write", model: options.model, scope: repoRoot, timeoutMs,
      ownershipPaths, writeScope: ownershipPaths, prompt: options.prompt,
      executionEnvelope: { filesystemProfile: "isolated_git_worktree", networkPolicy: "disabled", goalMutationAllowed: false } };
    const results = await runBackgroundTasks({ mode: "workspace_write", budget: { maxAgents: 1 }, backgroundTasks: [task] }, {
      enabled: true, command: "codex", callerProvider: "claude",
      delegation: { callerProvider: "claude", workerProvider: "codex", purpose: "code-write", context: "human-interactive" },
      env: runtime.env || process.env, runCommand: runtime.runCommand,
      artifactRoot: runtime.artifactRoot, stateFile: runtime.stateFile,
    });
    result = results[0] || { status: "failed", summary: "Writer returned no result" };
    if (result.status !== "needs-review") result.status = "failed";
    result.reviewRequired = true;
    result.callerProvider = "claude";
    result.workerProvider = "codex";
    result.purpose = "code-write";
    result.context = "human-interactive";
    result.requestedModel = options.model;
    artifactRoot = result.patchArtifact ? path.dirname(result.patchArtifact) : null;
    if (result.worktreePath && !artifactRoot) artifactRoot = result.artifactRoot;
    if (artifactRoot) {
      fs.mkdirSync(artifactRoot, { recursive: true });
      result.manifestArtifact = path.join(artifactRoot, "handback.json");
      fs.writeFileSync(result.manifestArtifact, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    }
  } catch (error) {
    result = { ...result, status: "failed", reviewRequired: true, summary: error.message };
  }
  return result;
}

async function main(argv = process.argv.slice(2)) {
  let result;
  try {
    const options = parseArgs(argv);
    if (options.help) { process.stdout.write(HELP); return; }
    result = await runWriter(options);
  } catch (error) {
    result = { status: "failed", reviewRequired: true, summary: error.message };
  }
  process.stdout.write(`${JSON.stringify(result, null, argv.includes("--json") ? 0 : 2)}\n`);
  if (result.status === "failed") process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { HELP, parseArgs, runWriter };

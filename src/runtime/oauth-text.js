"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

async function executeCodexText(options, dependencies = {}) {
  // Lazy import avoids the runner's existing model-helper import cycle.
  const { runCommand, buildCodexOauthEnv, sanitizeSidecarEnv } = require("../background/background-agent-runner");
  const { parseCodexJsonl } = require("../background/codex-worker");
  const env = sanitizeSidecarEnv(buildCodexOauthEnv(dependencies.env || process.env), { kind: "codex", unattended: false });
  env.MYOS_BACKGROUND_AGENTS_ENABLED = "0";
  env.MYOS_BACKGROUND_IS_SIDECAR = "1";
  const effort = ["low", "medium", "high", "xhigh", "max", "ultra"].includes(options.effort) ? options.effort : "low";
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "myos-oauth-text-"));
  try {
    const result = await (dependencies.runCommand || runCommand)({
      command: options.command || "codex", cwd, env,
      args: ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-s", "read-only",
        "-c", 'approval_policy="never"', "-c", 'forced_login_method="chatgpt"', "-c", 'model_provider="openai"',
        "-c", `model_reasoning_effort="${effort}"`, "-m", options.model, "-"],
      input: options.prompt, timeoutMs: options.timeoutMs || 180000,
    });
    const parsed = parseCodexJsonl(result.stdout);
    if (result.code !== 0 || result.signal || result.cleanupFailed || parsed.errorMessage || !parsed.summary) {
      const error = new Error(parsed.errorMessage || result.stderr || "OAuth provider returned no validated assistant output");
      error.code = "OAUTH_EXECUTION_FAILED";
      error.signal = result.signal;
      error.cleanupFailed = result.cleanupFailed;
      throw error;
    }
    return { text: parsed.summary, raw: { provider: "codex-oauth", model: options.model, providerReportedModel: null }, usage: parsed.usage };
  } finally {
    // Only remove our empty temporary directory; never recursively clean provider output.
    try { fs.rmdirSync(cwd); } catch { /* Retain unexpected artifacts for inspection. */ }
  }
}
module.exports = { executeCodexText };

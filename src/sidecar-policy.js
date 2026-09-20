"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isUnattendedContext } = require("./env-context");

const PROVIDER_KEYS = {
  openai: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_API_KEY", "CLAUDE_CODE_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_AI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
};

function hasOAuthSeat(provider, env) {
  if (isUnattendedContext(env)) return false;
  const home = env.HOME || os.homedir();
  let authPath;
  if (provider === "openai") {
    authPath = env.MYOS_CODEX_AUTH_PATH || path.join(env.CODEX_HOME || path.join(home, ".codex"), "auth.json");
  } else if (provider === "anthropic") {
    authPath = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), ".credentials.json");
  } else if (provider === "google") {
    authPath = path.join(home, ".gemini", "oauth_creds.json");
  } else {
    return false;
  }
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const token = provider === "openai" ? auth.tokens?.access_token
      : provider === "anthropic" ? auth.claudeAiOauth?.accessToken : auth.access_token;
    return typeof token === "string" && token.trim().length > 0;
  } catch {
    return false;
  }
}

function sidecarOffReason(env = process.env, callerProvider) {
  const selected = String(callerProvider || env.MYOS_LLM_PROVIDER || "openai").trim().toLowerCase();
  const provider = { codex: "openai", claude: "anthropic", gemini: "google" }[selected] || selected;
  const hasKey = (PROVIDER_KEYS[provider] || []).some((key) => String(env[key] || "").trim());
  if (!hasKey && !hasOAuthSeat(provider, env)) return `sidecars off: no ${provider} credential`;

  const root = String(env.MYOS_HOME_ROOT || "");
  const customer = env.MYOS_CUSTOMER_INSTALL === "1" || /all[-_ ]?sorted/i.test(root)
    || (root && fs.existsSync(path.join(root, ".all-sorted")));
  const optIn = ["balanced", "deep"].includes(String(env.MYOS_PARALLELIZATION_AGGRESSION || "").trim().toLowerCase());
  return customer && !optIn ? "sidecars off: customer opt-in required" : "";
}

module.exports = { sidecarOffReason };

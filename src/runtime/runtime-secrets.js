"use strict";

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { workspaceEnvPath } = require("../myos-compat");

const WORKSPACE_ENV_PATH = workspaceEnvPath();
let envCache = null;
const SENSITIVE_ENV_KEYS = new Set([
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "UNI_BOT_TOKEN",
  "JUNO_BOT_TOKEN",
  "JACKSON_BOT_TOKEN",
  "LUNA_BOT_TOKEN",
  "MYOS_REPORTS_BOT_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_AI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "ANTHROPIC_API_KEY",
  "BRAVE_API_KEY",
]);

function loadWorkspaceEnvMap() {
  if (envCache) return envCache;
  envCache = new Map();
  try {
    const raw = fs.readFileSync(WORKSPACE_ENV_PATH, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key) envCache.set(key, value);
    }
  } catch {
    // Best-effort fallback only.
  }
  return envCache;
}

function requireOptionsObject(name, value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} options must be an object`);
  }
  return value;
}

function assertMaxArgs(name, actual, expected) {
  if (actual > expected) {
    throw new TypeError(`${name} accepts at most ${expected} argument${expected === 1 ? "" : "s"}`);
  }
}

function normalizeEnvFileValue(rawValue, { stripInlineComments = false } = {}) {
  let value = String(rawValue).replace(/^['"]|['"]$/g, "");
  if (stripInlineComments) {
    value = value.replace(/\s+#\s.*$/, "");
  }
  return value;
}

function loadEnvFile(options = {}) {
  assertMaxArgs("loadEnvFile", arguments.length, 1);
  const {
    envPath = workspaceEnvPath(),
    env = process.env,
    override = false,
    stripInlineComments = false,
  } = requireOptionsObject("loadEnvFile", options);

  if (!env || typeof env !== "object") {
    throw new TypeError("loadEnvFile env must be an object");
  }
  if (!fs.existsSync(envPath)) return env;

  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (override || !env[key]) {
      env[key] = normalizeEnvFileValue(rawValue, { stripInlineComments });
    }
  }
  return env;
}

function getEnvValue(key, options = {}) {
  assertMaxArgs("getEnvValue", arguments.length, 2);
  const {
    env = process.env,
    fallback = "",
    trim = false,
  } = requireOptionsObject("getEnvValue", options);

  if (!env || typeof env !== "object") {
    throw new TypeError("getEnvValue env must be an object");
  }

  const value = env[key];
  if (value === undefined || value === null) return fallback;
  const text = String(value);
  return trim ? text.trim() : text;
}

function requireEnvValue(key, options = {}) {
  assertMaxArgs("requireEnvValue", arguments.length, 2);
  const {
    env = process.env,
    trim = false,
    message = `${key} is required`,
  } = requireOptionsObject("requireEnvValue", options);

  const value = getEnvValue(key, { env, trim, fallback: "" });
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function readWorkspaceEnvValue(key) {
  return loadWorkspaceEnvMap().get(String(key || "").trim()) || "";
}

function isSensitiveEnvKey(key) {
  const normalized = String(key || "").trim();
  if (!normalized) return false;
  if (SENSITIVE_ENV_KEYS.has(normalized)) return true;
  return /(_TOKEN|_SECRET|_PASSWORD|_KEY)$/i.test(normalized);
}

function readKeychainPassword(service) {
  if (!service) return "";
  try {
    return execFileSync("security", ["find-generic-password", "-w", "-s", service], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function resolveSecretValue(options = {}) {
  const envKeys = Array.isArray(options.envKeys) ? options.envKeys : [];
  const workspaceEnvKeys = Array.isArray(options.workspaceEnvKeys) ? options.workspaceEnvKeys : [];
  const keychainServices = Array.isArray(options.keychainServices) ? options.keychainServices : [];

  for (const key of envKeys) {
    const value = process.env[key];
    if (value) return value;
  }
  for (const key of workspaceEnvKeys) {
    const value = readWorkspaceEnvValue(key);
    if (value) return value;
  }
  for (const service of keychainServices) {
    const value = readKeychainPassword(service);
    if (value) return value;
  }
  return "";
}

function scrubProcessEnvSecrets(keys = []) {
  for (const key of keys) {
    if (!key) continue;
    delete process.env[key];
  }
}

module.exports = {
  getEnvValue,
  isSensitiveEnvKey,
  loadEnvFile,
  normalizeEnvFileValue,
  readKeychainPassword,
  readWorkspaceEnvValue,
  requireEnvValue,
  resolveSecretValue,
  scrubProcessEnvSecrets,
};

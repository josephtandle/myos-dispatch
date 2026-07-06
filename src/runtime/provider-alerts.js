"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { resolveStateRoot } = require("../myos-compat");

const STATE_DIR = resolveStateRoot("provider-alerts");
const TTL_MS = 6 * 60 * 60 * 1000;

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function fingerprintFor(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 16);
}

function fingerprintPath(key) {
  return path.join(STATE_DIR, `${fingerprintFor(key)}.json`);
}

function withinTtl(key) {
  try {
    const target = fingerprintPath(key);
    if (!fs.existsSync(target)) return false;
    const payload = JSON.parse(fs.readFileSync(target, "utf8"));
    const lastSent = Date.parse(payload.lastSent || "");
    if (!Number.isFinite(lastSent)) return false;
    return Date.now() - lastSent < TTL_MS;
  } catch {
    return false;
  }
}

function recordSend(key, payload) {
  ensureStateDir();
  fs.writeFileSync(
    fingerprintPath(key),
    JSON.stringify(
      {
        key,
        lastSent: new Date().toISOString(),
        ...payload,
      },
      null,
      2
    )
  );
}

function notifierSpecs(env = process.env) {
  return String(env.MYOS_PROVIDER_ALERT_NOTIFIER_MODULES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function loadOptionalNotifier(specifier) {
  try {
    const mod = require(specifier);
    return typeof mod?.sendProviderAlert === "function" ? mod : null;
  } catch {
    return null;
  }
}

async function sendOptionalNotifiers(alert, env = process.env) {
  const results = {};
  for (const specifier of notifierSpecs(env)) {
    const notifier = loadOptionalNotifier(specifier);
    if (!notifier) {
      results[specifier] = false;
      continue;
    }
    try {
      results[specifier] = Boolean(await notifier.sendProviderAlert(alert));
    } catch {
      results[specifier] = false;
    }
  }
  return results;
}

function classifyProviderIssue(error) {
  const message = String(error?.message || "").toLowerCase();
  const status = Number(error?.responseStatus || error?.status || 0);
  const code = String(error?.code || "").toLowerCase();

  if (
    message.includes("insufficient_quota") ||
    message.includes("credit balance is too low") ||
    message.includes("billing hard limit") ||
    message.includes("purchase credits") ||
    message.includes("quota exceeded")
  ) {
    return "credits";
  }

  if (status === 429 || message.includes("rate limit") || message.includes("too many requests")) {
    return "rate_limit";
  }

  if (
    [500, 502, 503, 504].includes(status) ||
    message.includes("service unavailable") ||
    message.includes("bad gateway") ||
    message.includes("gateway timeout") ||
    message.includes("temporarily unavailable") ||
    message.includes("overloaded")
  ) {
    return "outage";
  }

  if (status === 408 || code === "etimedout" || message.includes("timed out") || message.includes("timeout")) {
    return "timeout";
  }

  return null;
}

async function maybeNotifyProviderIssue({
  provider,
  error,
  taskClass,
  fallbackProvider,
  fallbackIndex,
}) {
  if (process.env.MYOS_DISABLE_PROVIDER_ALERTS === "1") return false;

  const issueType = classifyProviderIssue(error);
  if (!issueType) return false;

  const key = `${provider}:${issueType}`;
  if (withinTtl(key)) return false;

  const reason = String(error?.message || "unknown provider failure").trim().slice(0, 280);
  const lines = [
    "MyOS provider alert",
    `Provider: ${provider}`,
    `Issue: ${issueType}`,
    `Task class: ${taskClass}`,
    fallbackProvider
      ? `Fallback: switched to ${fallbackProvider}${Number.isFinite(fallbackIndex) ? ` (candidate ${fallbackIndex + 1})` : ""}`
      : "Fallback: none available",
    `Reason: ${reason}`,
  ];
  const plainText = lines.join("\n");
  const markdownText = `*${lines[0]}*\n${lines.slice(1).join("\n")}`;
  const notifierResults = await sendOptionalNotifiers({
    plainText,
    markdownText,
    meta: {
      provider,
      issueType,
      taskClass,
      fallbackProvider: fallbackProvider || null,
      fallbackIndex: Number.isFinite(fallbackIndex) ? fallbackIndex : null,
    },
  });
  const notified = Object.values(notifierResults).some(Boolean);

  recordSend(key, {
    provider,
    issueType,
    taskClass,
    fallbackProvider: fallbackProvider || null,
    fallbackIndex: Number.isFinite(fallbackIndex) ? fallbackIndex : null,
    reason,
    notifierResults,
  });

  return notified;
}

module.exports = {
  loadOptionalNotifier,
  maybeNotifyProviderIssue,
  notifierSpecs,
  sendOptionalNotifiers,
};

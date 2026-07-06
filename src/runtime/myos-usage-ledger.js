"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { resolveWorkspacePath } = require("../myos-compat");
const { recordDispatcherHealthEvent } = require("../promotion/dispatcher-health-policy");

const DAY_MS = 24 * 60 * 60 * 1000;
const EXIT_SIGNALS = ["beforeExit", "exit", "SIGINT", "SIGTERM"];

let flushScheduled = false;
let exitHooksRegistered = false;
const pendingWritesByFile = new Map();

function resolveLedgerDir() {
  if (process.env.MYOS_USAGE_LEDGER_DIR) {
    return process.env.MYOS_USAGE_LEDGER_DIR;
  }

  return path.join(
    resolveWorkspacePath(),
    "agents",
    "shared",
    "data",
    "myos-usage"
  );
}

function resolveActivityLedgerDir() {
  if (process.env.MYOS_ACTIVITY_LEDGER_DIR) {
    return process.env.MYOS_ACTIVITY_LEDGER_DIR;
  }

  return path.join(
    resolveWorkspacePath(),
    "agents",
    "shared",
    "data",
    "myos-activity"
  );
}

function ensureLedgerDir() {
  fs.mkdirSync(resolveLedgerDir(), { recursive: true });
}

function ensureActivityLedgerDir() {
  fs.mkdirSync(resolveActivityLedgerDir(), { recursive: true });
}

function ledgerPathForDate(date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  return path.join(resolveLedgerDir(), `${day}.jsonl`);
}

function activityLedgerPathForDate(date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  return path.join(resolveActivityLedgerDir(), `${day}.jsonl`);
}

function safeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeString(value, fallback = "unknown") {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function safeNullableString(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function isBillableSpendEvent(event) {
  if (!event || typeof event !== "object") return false;
  if (event.billable === true) return true;
  if (event.billable === false) return false;

  // Backward compatibility for pre-Scrooge-rewrite ledger rows.
  const authMode = safeString(event.authMode, "");
  const targetType = safeString(event.resolvedTargetType, "");
  return authMode === "api" && targetType === "llm";
}

function registerExitHooks() {
  if (exitHooksRegistered) return;
  exitHooksRegistered = true;

  for (const eventName of EXIT_SIGNALS) {
    process.once(eventName, () => {
      try {
        flushUsageEventsSync();
      } catch {
        // Best effort only during shutdown.
      }
    });
  }
}

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;

  setImmediate(() => {
    flushScheduled = false;
    flushUsageEventsSync();
  });
}

function flushUsageEventsSync() {
  if (pendingWritesByFile.size === 0) return;

  for (const [filePath, lines] of pendingWritesByFile.entries()) {
    if (!Array.isArray(lines) || lines.length === 0) continue;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, lines.join(""), "utf8");
  }

  pendingWritesByFile.clear();
}

function buildUsageEvent(event) {
  const ts = safeString(event?.ts, new Date().toISOString());
  const caller = event?.caller && typeof event.caller === "object" ? event.caller : {};
  const billable = event?.billable === true;
  const rawEstimatedCostUsd = safeNumber(event?.estimatedCostUsd);
  const normalizedEstimatedCostUsd = billable ? rawEstimatedCostUsd : 0;

  return {
    ...event,
    eventId:
      safeNullableString(event?.eventId) ||
      (typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    ts,
    billable,
    estimatedCostUsd: normalizedEstimatedCostUsd,
    ...(billable || rawEstimatedCostUsd <= 0
      ? {}
      : { originalEstimatedCostUsd: rawEstimatedCostUsd }),
    authLabel: safeString(event?.authLabel, "unknown"),
    providerRequestId: safeNullableString(event?.providerRequestId),
    caller: {
      agentId: safeString(caller.agentId, "unknown"),
      surface: safeString(caller.surface, "unknown"),
      project: safeString(caller.project, "unknown"),
      jobId: safeNullableString(caller.jobId),
      runId: safeNullableString(caller.runId),
      traceId: safeNullableString(caller.traceId),
      callerVersion: safeNullableString(caller.callerVersion),
    },
  };
}

function appendUsageEvent(event) {
  registerExitHooks();
  const normalizedEvent = buildUsageEvent(event);
  const primaryPath = ledgerPathForDate(new Date(normalizedEvent.ts));
  const primaryQueued = pendingWritesByFile.get(primaryPath) || [];
  primaryQueued.push(`${JSON.stringify(normalizedEvent)}\n`);
  pendingWritesByFile.set(primaryPath, primaryQueued);

  if (normalizedEvent.billable !== true) {
    const activityPath = activityLedgerPathForDate(new Date(normalizedEvent.ts));
    const activityQueued = pendingWritesByFile.get(activityPath) || [];
    activityQueued.push(`${JSON.stringify(normalizedEvent)}\n`);
    pendingWritesByFile.set(activityPath, activityQueued);
  }
  scheduleFlush();
  try {
    recordDispatcherHealthEvent({
      source: "usage",
      ...normalizedEvent,
    });
  } catch {
    // Usage logging must not fail because health telemetry is unavailable.
  }
  return normalizedEvent;
}

function listLedgerFilesSince(cutoffMs, { activity = false } = {}) {
  flushUsageEventsSync();
  if (activity) ensureActivityLedgerDir();
  else ensureLedgerDir();
  const ledgerDir = activity ? resolveActivityLedgerDir() : resolveLedgerDir();
  const files = fs.readdirSync(ledgerDir).filter((entry) => entry.endsWith(".jsonl"));
  return files
    .map((entry) => ({
      entry,
      dayMs: Date.parse(`${entry.replace(/\.jsonl$/, "")}T00:00:00.000Z`),
    }))
    .filter(({ dayMs }) => Number.isFinite(dayMs) && dayMs >= cutoffMs - DAY_MS)
    .map(({ entry }) => path.join(ledgerDir, entry))
    .sort();
}

function readUsageEvents({ windowHours = 24, modelFilter = "all", billableOnly = false, activity = false } = {}) {
  const cutoffMs = Date.now() - windowHours * 60 * 60 * 1000;
  const events = [];

  for (const file of listLedgerFilesSince(cutoffMs, { activity })) {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      const ts = Date.parse(event.ts || "");
      if (!Number.isFinite(ts) || ts < cutoffMs) continue;
      if (modelFilter !== "all" && event.resolvedModelOrEngine !== modelFilter) continue;
      if (billableOnly && !isBillableSpendEvent(event)) continue;
      events.push(event);
    }
  }

  return events.sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
}

function bucketCost(map, key, event, extras = {}) {
  const normalizedKey = safeString(key, "unknown");
  const bucket = (map[normalizedKey] ||= {
    key: normalizedKey,
    runs: 0,
    successCount: 0,
    fallbackRuns: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    ...extras,
  });

  bucket.runs += 1;
  bucket.costUsd += safeNumber(event.estimatedCostUsd);
  bucket.inputTokens += safeNumber(event.inputTokens);
  bucket.outputTokens += safeNumber(event.outputTokens);
  if (event.outcome === "success") bucket.successCount += 1;
  if (safeNumber(event.fallbackIndex) > 0) bucket.fallbackRuns += 1;
  return bucket;
}

function summarizeUsage({ windowHours = 24, modelFilter = "all", billableOnly = true, activity = false } = {}) {
  const cutoffMs = Date.now() - windowHours * 60 * 60 * 1000;
  const events = readUsageEvents({ windowHours, modelFilter, billableOnly, activity });
  const summary = {
    windowHours,
    billableOnly,
    since: new Date(cutoffMs).toISOString(),
    totalRuns: 0,
    successCount: 0,
    failureCount: 0,
    fallbackRuns: 0,
    totalAttempts: 0,
    totalLatencyMs: 0,
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    retryableErrors: 0,
    issueCounts: {},
    byProvider: {},
    byTaskClass: {},
    byModel: {},
    byAgent: {},
    byProject: {},
    bySurface: {},
    byAuthLabel: {},
    dailyTrend: [],
    hourlyTrend: [],
    recentEvents: events.slice(-25).reverse(),
    recordCount: events.length,
    missingCallerCount: 0,
    unattributedSpendUsd: 0,
  };

  const dailyBuckets = new Map();
  const hourlyBuckets = new Map();

  for (const event of events) {
    summary.totalRuns += 1;
    if (event.outcome === "success") summary.successCount += 1;
    else summary.failureCount += 1;

    if (safeNumber(event.fallbackIndex) > 0) summary.fallbackRuns += 1;
    summary.totalAttempts += Array.isArray(event.attempts) ? event.attempts.length : 0;
    summary.totalLatencyMs += safeNumber(event.totalLatencyMs);
    summary.totalCostUsd += safeNumber(event.estimatedCostUsd);

    const finalAttempt =
      Array.isArray(event.attempts) && event.attempts.length > 0
        ? event.attempts[event.attempts.length - 1]
        : null;
    const inputTokens = safeNumber(
      event.inputTokens ?? finalAttempt?.inputTokens ?? event.usage?.inputTokens
    );
    const outputTokens = safeNumber(
      event.outputTokens ?? finalAttempt?.outputTokens ?? event.usage?.outputTokens
    );
    event.inputTokens = inputTokens;
    event.outputTokens = outputTokens;
    summary.totalInputTokens += inputTokens;
    summary.totalOutputTokens += outputTokens;

    bucketCost(summary.byTaskClass, event.taskClass || "unknown", event);
    bucketCost(summary.byProvider, event.resolvedProviderOrTool || "unknown", event);
    bucketCost(summary.byModel, event.resolvedModelOrEngine || "unknown", event);

    const caller = event.caller && typeof event.caller === "object" ? event.caller : {};
    const agentId = safeString(caller.agentId, "unknown");
    const surface = safeString(caller.surface, "unknown");
    const project = safeString(caller.project, "unknown");
    const authLabel = safeString(event.authLabel, "unknown");
    bucketCost(summary.byAgent, agentId, event);
    bucketCost(summary.byProject, project, event);
    bucketCost(summary.bySurface, surface, event);
    bucketCost(summary.byAuthLabel, authLabel, event);

    if (agentId === "unknown") {
      summary.missingCallerCount += 1;
      summary.unattributedSpendUsd += safeNumber(event.estimatedCostUsd);
    }

    const day = String(event.ts || "").slice(0, 10);
    const hour = String(event.ts || "").slice(0, 13) + ":00";

    if (day) {
      const bucket = dailyBuckets.get(day) || {
        date: day,
        costUsd: 0,
        requests: 0,
      };
      bucket.costUsd += safeNumber(event.estimatedCostUsd);
      bucket.requests += 1;
      dailyBuckets.set(day, bucket);
    }

    if (hour) {
      const bucket = hourlyBuckets.get(hour) || {
        hour,
        costUsd: 0,
        requests: 0,
      };
      bucket.costUsd += safeNumber(event.estimatedCostUsd);
      bucket.requests += 1;
      hourlyBuckets.set(hour, bucket);
    }

    for (const attempt of event.attempts || []) {
      if (attempt.status !== "error") continue;
      if (attempt.retryable) summary.retryableErrors += 1;
      if (attempt.issueType) {
        summary.issueCounts[attempt.issueType] = (summary.issueCounts[attempt.issueType] || 0) + 1;
      }
    }
  }

  summary.totalCostUsd = Number(summary.totalCostUsd.toFixed(6));
  summary.unattributedSpendUsd = Number(summary.unattributedSpendUsd.toFixed(6));
  summary.avgLatencyMs = summary.totalRuns
    ? Math.round(summary.totalLatencyMs / summary.totalRuns)
    : 0;
  summary.fallbackRate = summary.totalRuns
    ? Number((summary.fallbackRuns / summary.totalRuns).toFixed(4))
    : 0;
  summary.dailyTrend = Array.from(dailyBuckets.values()).sort((a, b) => a.date.localeCompare(b.date));
  summary.hourlyTrend = Array.from(hourlyBuckets.values()).sort((a, b) => a.hour.localeCompare(b.hour));
  summary.uniqueAgents = Object.keys(summary.byAgent).filter((key) => key !== "unknown").length;
  return summary;
}

function formatUsageSummary(summary) {
  if (!summary.totalRuns) {
    return "No MyOS usage recorded in the last 24h";
  }

  const providerLine = Object.values(summary.byProvider)
    .sort((a, b) => b.costUsd - a.costUsd || b.runs - a.runs)
    .slice(0, 3)
    .map((stats) => {
      const cost = stats.costUsd > 0 ? `$${stats.costUsd.toFixed(4)}` : "$0.0000";
      return `${stats.key} ${stats.runs} run(s), ${cost}`;
    })
    .join("; ");

  const agentLine = Object.values(summary.byAgent)
    .sort((a, b) => b.costUsd - a.costUsd || b.runs - a.runs)
    .slice(0, 3)
    .map((stats) => `${stats.key} ${stats.runs} run(s)`)
    .join("; ");

  const base = `Runs ${summary.totalRuns}, spend $${summary.totalCostUsd.toFixed(4)}, fallbacks ${summary.fallbackRuns} (${Math.round(summary.fallbackRate * 100)}%), avg latency ${summary.avgLatencyMs}ms`;
  const providers = providerLine ? `; providers: ${providerLine}` : "";
  const agents = agentLine ? `; agents: ${agentLine}` : "";
  return `${base}${providers}${agents}`;
}

module.exports = {
  activityLedgerPathForDate,
  appendUsageEvent,
  flushUsageEventsSync,
  formatUsageSummary,
  ledgerPathForDate,
  readUsageEvents,
  resolveActivityLedgerDir,
  resolveLedgerDir,
  summarizeUsage,
};

"use strict";

function mergeDiscovery(previous, evidence) {
  const models = new Map((previous?.models || []).map(entry => [`${entry.provider}:${entry.model}`, entry]));
  for (const entry of evidence) {
    if (!/^[a-z][a-z0-9_-]*$/.test(entry.provider) || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(entry.model)) throw new Error("Invalid model evidence");
    const key = `${entry.provider}:${entry.model}`;
    const prior = models.get(key);
    models.set(key, { invokedAt: null, qualityValidated: false, ...prior, ...entry,
      // Rediscovery is not successful inference and never clears quarantine.
      invokedAt: prior?.invokedAt || null, qualityValidated: prior?.qualityValidated === true,
      quarantineUntil: prior?.quarantineUntil || null,
    });
  }
  return { ...previous, version: 1, revision: (previous?.revision || 0) + 1, models: [...models.values()] };
}

const CODEX_CLASS_POLICY = Object.freeze({
  cheap_routing: { models: ["gpt-5.6-luna", "gpt-5.6-terra"], effort: "low" },
  default_automation: { models: ["gpt-5.6-terra", "gpt-5.6-sol"], effort: "medium" },
  heavy_synthesis: { models: ["gpt-5.6-sol", "gpt-6-astra"], effort: "high" },
  task_class_is_elite: { models: ["gpt-6-astra", "gpt-5.6-sol"], effort: "high" },
  planning: { models: ["gpt-5.6-sol", "gpt-6-astra"], effort: "medium" },
});

function selectModels(state, { provider, taskClass, now = Date.now() }) {
  const policy = provider === "codex" ? CODEX_CLASS_POLICY[taskClass] :
    provider === "claude" && ["cheap_routing", "default_automation", "planning"].includes(taskClass)
      ? { models: ["claude-sonnet-5"], effort: taskClass === "cheap_routing" ? "low" : "medium" } : null;
  if (!policy) return [];
  return policy.models.flatMap(model => {
    const record = state?.models?.find(entry => entry.provider === provider && entry.model === model);
    if (!record || (provider === "claude" && !record.invokedAt) || record.visible !== true || record.auth !== "subscription" ||
        !Number.isFinite(Date.parse(record.observedAt)) || now - Date.parse(record.observedAt) > 7 * 86400000 ||
        Date.parse(record.quarantineUntil) > now) return [];
    return [{ ...record, effort: policy.effort }];
  });
}
function recordFailure(state, { provider, model, stderr = "", now = Date.now(), signal, cleanupFailed }) {
  const text = String(stderr).slice(0, 16000);
  let kind = "unknown";
  if (cleanupFailed || signal) kind = "interrupted";
  else if (/401|403|not authenticated|not logged in|login required|authentication failed/i.test(text)) kind = "auth";
  else if (/429|quota|rate.?limit|usage limit|credits|billing/i.test(text)) kind = "quota";
  else if (/(model.{0,160}(?:not supported|unsupported|not found|unavailable)|unsupported.{0,60}model|model_not_found)/i.test(text)) kind = "unsupported_model";
  const retryAllowed = kind === "unsupported_model";
  return {
    ...state, revision: state.revision + 1,
    models: state.models.map(entry => entry.provider === provider && entry.model === model
      ? { ...entry, failureKind: kind, failedAt: new Date(now).toISOString(),
        quarantineUntil: retryAllowed ? new Date(now + 3600000).toISOString() : entry.quarantineUntil }
      : entry),
    // Persist classifications only, never stderr, credentials, prompts or command arguments.
    lastFailure: { provider, model, kind, retryAllowed, at: new Date(now).toISOString() },
  };
}
module.exports = { mergeDiscovery, selectModels, recordFailure };

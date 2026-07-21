"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadCatalog, normalizeProvider, resolveProfileModel } = require("./model-catalog");
const { readLaneState } = require("./myos-lane");
const { resolveModelCatalogLocalPath, resolveWorkspacePath } = require("./myos-compat");

const CANONICAL_TASK_CLASSES = Object.freeze([
  "cheap_routing",
  "default_automation",
  "heavy_synthesis",
  "task_class_is_elite",
  "planning",
  "audio_transcription",
  "audio_diarization",
  "realtime_audio",
]);

const COMPLIANCE_LANES = Object.freeze([
  "interactive_oauth",
  "unattended_api",
  "unattended_local",
]);

const ROUTING_POLICY_CANDIDATES = Object.freeze([
  path.join(__dirname, "..", "config", "myos-routing-policy.json"),
  resolveWorkspacePath("agents", "shared", "myos-routing-policy.json"),
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

function loadRoutingPolicy() {
  for (const candidate of ROUTING_POLICY_CANDIDATES) {
    if (!candidate) continue;
    if (!fs.existsSync(candidate)) continue;
    const raw = JSON.parse(fs.readFileSync(candidate, "utf8"));
    return deepFreeze(raw);
  }
  throw new Error(
    `Missing MyOS routing policy. Tried: ${ROUTING_POLICY_CANDIDATES.join(", ")}`
  );
}

const ROUTING_POLICY = loadRoutingPolicy();

let localAssignmentsCache = null;
let localAssignmentsCachePath = null;

const DETERMINISTIC_TOOLS = Object.freeze({
  mlx_whisper_local: {
    id: "mlx_whisper_local",
    type: "deterministic",
    supportedTaskClasses: ["audio_transcription"],
    supportedComplianceLanes: ["unattended_local"],
    requiredCapabilities: ["audio_input", "speech_to_text"],
    preferred: true,
  },
});

function normalizeTaskClass(taskClass) {
  const normalized = String(taskClass || "default_automation").trim().toLowerCase();
  return CANONICAL_TASK_CLASSES.includes(normalized) ? normalized : "default_automation";
}

function isCanonicalTaskClass(taskClass) {
  const normalized = String(taskClass || "").trim().toLowerCase();
  return CANONICAL_TASK_CLASSES.includes(normalized);
}

function normalizeComplianceLane(lane) {
  const normalized = String(lane || "").trim().toLowerCase();
  if (!normalized) return "unattended_api";
  if (!COMPLIANCE_LANES.includes(normalized)) {
    throw new Error(`Unsupported MyOS compliance lane: ${lane}`);
  }
  return normalized;
}

function deriveComplianceLane({ complianceLane, executionPolicy, authMode, taskClass, audio } = {}) {
  if (complianceLane) return normalizeComplianceLane(complianceLane);
  if (executionPolicy === "interactive_session" || authMode === "oauth") {
    return "interactive_oauth";
  }
  if (normalizeTaskClass(taskClass) === "audio_transcription" && audio) {
    return "unattended_local";
  }
  return "unattended_api";
}

function cloneRoute(route = {}) {
  return {
    deterministicOptions: Array.isArray(route.deterministicOptions)
      ? route.deterministicOptions.map((entry) => ({ ...entry }))
      : [],
    llmTargets: Array.isArray(route.llmTargets)
      ? route.llmTargets.map((entry) => ({ ...entry }))
      : [],
    acceptanceThreshold: route.acceptanceThreshold || null,
  };
}

function clearLocalAssignmentsCache() {
  localAssignmentsCache = null;
  localAssignmentsCachePath = null;
}

function getLocalAssignmentsPath() {
  return process.env.MYOS_MODEL_CATALOG_LOCAL || resolveModelCatalogLocalPath();
}

function readLocalAssignmentsFile() {
  const target = getLocalAssignmentsPath();
  if (localAssignmentsCachePath === target) {
    return localAssignmentsCache;
  }

  localAssignmentsCachePath = target;
  try {
    if (!fs.existsSync(target)) {
      localAssignmentsCache = null;
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    localAssignmentsCache = parsed && typeof parsed === "object" ? parsed : null;
    return localAssignmentsCache;
  } catch {
    localAssignmentsCache = null;
    return null;
  }
}

function candidateKey(candidate = {}) {
  return [
    candidate.type || "",
    candidate.tool || "",
    candidate.provider || "",
    candidate.profile || "",
    candidate.model || "",
    candidate.authMode || "",
  ].join("|");
}

function dedupeCandidates(candidates = []) {
  const seen = new Set();
  const output = [];
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(candidate);
  }
  return output;
}

function expectedAuthModeForLane(lane) {
  return lane === "interactive_oauth" ? "oauth" : "api";
}

function resolveProfileOrModelTarget(provider, profile, model) {
  const normalizedProvider = normalizeProvider(provider);
  const catalog = loadCatalog(normalizedProvider);
  const profileId = profile ? String(profile).trim() : "";

  if (model) {
    const resolvedModel = catalog.models.find(
      (entry) => entry.id === model || entry.model === model
    );
    if (!resolvedModel) return null;
    if (profileId) {
      const resolvedProfile = catalog.routing_profiles.find((entry) => entry.id === profileId);
      if (!resolvedProfile) return null;
    }
    return {
      provider: normalizedProvider,
      profile: profileId || null,
      model: resolvedModel.id,
    };
  }

  if (!profileId) return null;
  try {
    const resolved = resolveProfileModel(catalog, profileId);
    return {
      provider: normalizedProvider,
      profile: resolved.profile.id,
      model: resolved.model.id,
    };
  } catch {
    return null;
  }
}

function normalizeRouteTarget(target, { allowMissingAuthMode = false, expectedAuthMode = null } = {}) {
  try {
    if (!target || typeof target !== "object") return null;
    if (target.type && target.type !== "llm" && target.type !== "deterministic") return null;
    if (target.type === "deterministic") {
      const tool = DETERMINISTIC_TOOLS[target.tool];
      return tool ? { type: "deterministic", tool: target.tool } : null;
    }

    const provider = String(target.provider || "").trim().toLowerCase();
    if (!provider) return null;
    const resolved = resolveProfileOrModelTarget(provider, target.profile, target.model);
    if (!resolved) return null;
    const authMode = String(target.authMode || "").trim().toLowerCase();
    if (!authMode && !allowMissingAuthMode) return null;
    if (authMode && authMode !== "oauth" && authMode !== "api") return null;
    if (expectedAuthMode && authMode && authMode !== expectedAuthMode) return null;

    return {
      type: "llm",
      provider: resolved.provider,
      profile: resolved.profile,
      model: resolved.model,
      authMode: authMode || null,
    };
  } catch {
    return null;
  }
}

function buildRouteFromEntry(entry, { allowMissingAuthMode = false, expectedAuthMode = null } = {}) {
  if (!entry || typeof entry !== "object") return null;
  const route = {
    deterministicOptions: [],
    llmTargets: [],
  };

  if (Array.isArray(entry.deterministicOptions)) {
    for (const option of entry.deterministicOptions) {
      const normalized = normalizeRouteTarget(option, { allowMissingAuthMode, expectedAuthMode });
      if (!normalized) continue;
      route.deterministicOptions.push(normalized);
    }
  }

  if (Array.isArray(entry.llmTargets)) {
    for (const target of entry.llmTargets) {
      const normalized = normalizeRouteTarget(target, { allowMissingAuthMode, expectedAuthMode });
      if (!normalized) continue;
      route.llmTargets.push(normalized);
    }
  } else if (entry.provider && (entry.profile || entry.model)) {
    const normalized = normalizeRouteTarget(entry, { allowMissingAuthMode, expectedAuthMode });
    if (normalized) route.llmTargets.push(normalized);
  }

  if (!route.deterministicOptions.length && !route.llmTargets.length) return null;
  return route;
}

function resolveLocalRoutePreference(taskClass, lane) {
  const localState = readLocalAssignmentsFile();
  if (!localState) return null;
  const expectedAuthMode = expectedAuthModeForLane(lane);

  const overrides = localState.overrides && typeof localState.overrides === "object"
    ? localState.overrides[taskClass]
    : null;
  const overrideRoute = buildRouteFromEntry(overrides, {
    allowMissingAuthMode: true,
    expectedAuthMode,
  });
  if (overrideRoute) {
    return { route: overrideRoute, source: "local_override" };
  }

  const assignment = localState.assignments && typeof localState.assignments === "object"
    ? localState.assignments[taskClass]
    : null;
  if (!assignment || assignment.unassigned || assignment.source !== "auto") {
    return null;
  }
  if (assignment.lane !== lane) {
    return null;
  }

  const normalized = normalizeRouteTarget({
    type: "llm",
    provider: assignment.provider,
    profile: assignment.profile,
    model: assignment.model,
    authMode: assignment.authMode,
  }, {
    allowMissingAuthMode: false,
    expectedAuthMode,
  });
  if (!normalized) return null;

  return {
    route: {
      deterministicOptions: [],
      llmTargets: [normalized],
    },
    source: "local_assignment",
  };
}

function mergeRouteOverrides(baseRoute, overrideRoute) {
  if (!overrideRoute || typeof overrideRoute !== "object") return baseRoute;
  const merged = cloneRoute(baseRoute);
  if (Array.isArray(overrideRoute.deterministicOptions)) {
    merged.deterministicOptions = overrideRoute.deterministicOptions.map((entry) => ({ ...entry }));
  }
  if (Array.isArray(overrideRoute.llmTargets)) {
    merged.llmTargets = overrideRoute.llmTargets.map((entry) => ({ ...entry }));
  }
  if (Object.prototype.hasOwnProperty.call(overrideRoute, "acceptanceThreshold")) {
    merged.acceptanceThreshold = overrideRoute.acceptanceThreshold;
  }
  return merged;
}

function resolveRouteEntry({ taskClass, intent, complianceLane }) {
  const lane = normalizeComplianceLane(complianceLane);
  const normalizedTaskClass = normalizeTaskClass(taskClass);
  const localPreference = resolveLocalRoutePreference(normalizedTaskClass, lane);
  const routeOverrides = readLaneState().routeOverrides || {};
  const normalizedIntent = intent ? String(intent).trim() : "";

  if (localPreference?.source === "local_override") {
    return {
      routeKey: normalizedIntent || normalizedTaskClass,
      routingSource: "local_override",
      route: localPreference.route,
    };
  }

  if (normalizedIntent && ROUTING_POLICY.intents[normalizedIntent]?.[lane]) {
    const baseRoute = ROUTING_POLICY.intents[normalizedIntent][lane];
    const merged = mergeRouteOverrides(baseRoute, routeOverrides?.[normalizedIntent]?.[lane]);
    return {
      routeKey: normalizedIntent,
      routingSource: "intent",
      route: localPreference?.source === "local_assignment"
        ? {
            ...merged,
            llmTargets: dedupeCandidates([...localPreference.route.llmTargets, ...merged.llmTargets]),
          }
        : merged,
    };
  }

  const baseRoute = ROUTING_POLICY.taskClasses[normalizedTaskClass]?.[lane];
  if (!baseRoute) {
    throw new Error(`No MyOS route configured for ${normalizedTaskClass}:${lane}`);
  }

  return {
    routeKey: normalizedTaskClass,
    routingSource: normalizedIntent ? "taskClass_fallback" : "taskClass",
    route: (() => {
      const merged = mergeRouteOverrides(baseRoute, routeOverrides?.[normalizedTaskClass]?.[lane]);
      if (localPreference?.source !== "local_assignment") return merged;
      return {
        ...merged,
        llmTargets: dedupeCandidates([...localPreference.route.llmTargets, ...merged.llmTargets]),
      };
    })(),
  };
}

function candidateSupportsAudioInput(candidate) {
  if (candidate.type === "deterministic") {
    const tool = DETERMINISTIC_TOOLS[candidate.tool];
    return Boolean(tool?.requiredCapabilities?.includes("audio_input"));
  }
  if (candidate.type === "llm") {
    return candidate.profile === "audio_transcription" || candidate.profile === "audio_diarization";
  }
  return false;
}

function isFableCandidate(candidate = {}) {
  const profile = String(candidate.profile || "").trim().toLowerCase();
  const model = String(candidate.model || "").trim().toLowerCase();
  return (
    profile === "anthropic_advisor" ||
    profile === "anthropic_elite" ||
    model === "claude-fable-5" ||
    model === "anthropic.claude-fable-5" ||
    model.startsWith("claude-fable-")
  );
}

function prioritizeJsonCheapRoutingCandidates(candidates = []) {
  const openAiCandidates = [];
  const otherCandidates = [];

  for (const candidate of candidates) {
    if (candidate?.type === "llm" && candidate.provider === "openai") {
      openAiCandidates.push(candidate);
      continue;
    }
    otherCandidates.push(candidate);
  }

  return [...openAiCandidates, ...otherCandidates];
}

function resolveExecutionPlan({ taskClass, intent, complianceLane, executionPolicy, authMode, audio, pinnedProvider, providerPreference, model, profile, responseMode } = {}) {
  const normalizedTaskClass = normalizeTaskClass(taskClass);
  const lane = normalizeComplianceLane(complianceLane);

  if (model || pinnedProvider || providerPreference) {
    const explicitProvider = normalizeProvider(pinnedProvider || providerPreference || "openai");
    return {
      taskClass: normalizedTaskClass,
      intent: intent || null,
      complianceLane: lane,
      routeKey: intent || normalizedTaskClass,
      routingSource: "explicit_override",
      deterministicBypassReason: null,
      candidates: [
        {
          type: "llm",
          provider: explicitProvider,
          profile: profile || normalizedTaskClass,
          model: model || null,
          authMode: lane === "interactive_oauth" ? "oauth" : "api",
        },
      ],
      executionPolicy,
      authMode,
    };
  }

  const { routeKey, routingSource, route } = resolveRouteEntry({
    taskClass: normalizedTaskClass,
    intent,
    complianceLane: lane,
  });

  let deterministicBypassReason = null;
  const deterministicCandidates = [];
  for (const candidate of route.deterministicOptions) {
    if ((normalizedTaskClass === "audio_transcription" || candidateSupportsAudioInput(candidate)) && !audio?.buffer && !audio?.filePath) {
      deterministicBypassReason = "audio_input_missing";
      continue;
    }
    deterministicCandidates.push({ ...candidate });
  }

  let llmCandidates = route.llmTargets.map((entry) => ({ ...entry }));
  if (
    lane === "unattended_api" &&
    normalizedTaskClass === "cheap_routing" &&
    responseMode === "json"
  ) {
    llmCandidates = prioritizeJsonCheapRoutingCandidates(llmCandidates);
  }

  return {
    taskClass: normalizedTaskClass,
    intent: intent || null,
    complianceLane: lane,
    routeKey,
    routingSource,
    deterministicBypassReason,
    candidates: [
      ...deterministicCandidates,
      ...llmCandidates,
    ],
    executionPolicy,
    authMode,
  };
}

function validateExecutionCandidate(plan, candidate, { authMode, audio } = {}) {
  if (!candidate) {
    throw new Error(`No MyOS candidates available for ${plan.routeKey}:${plan.complianceLane}`);
  }

  if (plan.complianceLane === "interactive_oauth" && authMode !== "oauth") {
    throw new Error("MyOS interactive_oauth routes require oauth auth mode");
  }
  if (plan.complianceLane !== "interactive_oauth" && authMode === "oauth") {
    throw new Error("MyOS unattended work cannot run with oauth auth mode");
  }

  if (candidate.type === "deterministic") {
    const tool = DETERMINISTIC_TOOLS[candidate.tool];
    if (!tool) throw new Error(`Unknown MyOS deterministic tool: ${candidate.tool}`);
    if (!tool.supportedTaskClasses.includes(plan.taskClass)) {
      throw new Error(`Deterministic tool ${candidate.tool} is not approved for ${plan.taskClass}`);
    }
    if (!tool.supportedComplianceLanes.includes(plan.complianceLane)) {
      throw new Error(`Deterministic tool ${candidate.tool} is not approved for ${plan.complianceLane}`);
    }
    if (tool.requiredCapabilities.includes("audio_input") && !audio?.buffer && !audio?.filePath) {
      throw new Error(`Deterministic tool ${candidate.tool} requires audio input`);
    }
    return;
  }

  if (candidate.type !== "llm") {
    throw new Error(`Unsupported MyOS candidate type: ${candidate.type}`);
  }

  const rawProvider = String(candidate.provider || "").trim().toLowerCase();
  if (rawProvider === "claude" || rawProvider === "local-claude") {
    throw new Error("Legacy Claude providers are not allowed in active MyOS routing");
  }

  if (candidate.authMode && candidate.authMode !== authMode) {
    throw new Error(
      `MyOS route ${plan.routeKey}:${plan.complianceLane} requires auth_mode=${candidate.authMode}, got ${authMode}`
    );
  }

  if (isFableCandidate(candidate) && authMode !== "oauth") {
    throw new Error(
      "Claude Fable advisory routing is OAuth-only in MyOS; API auth is blocked for Fable cost control."
    );
  }

  if (rawProvider === "anthropic" && authMode === "oauth") {
    throw new Error(
      "Anthropic OAuth execution is not implemented in MyOS yet; Fable advisory routing is policy-only until an OAuth adapter is verified."
    );
  }
}

function audioExtensionFromInput(audio = {}) {
  const filename = String(audio.filename || "").trim();
  if (filename.includes(".")) return filename.split(".").pop();
  const mimeType = String(audio.mimeType || "").toLowerCase();
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  return "ogg";
}

async function executeDeterministicCandidate(candidate, options = {}) {
  if (candidate.tool !== "mlx_whisper_local") {
    throw new Error(`Unsupported deterministic tool: ${candidate.tool}`);
  }

  if (process.env.MYOS_TEST_AUDIO_TRANSCRIPTION_TEXT) {
    return {
      text: String(process.env.MYOS_TEST_AUDIO_TRANSCRIPTION_TEXT),
      raw: { tool: candidate.tool, stubbed: true },
      usage: { inputTokens: 0, outputTokens: 0 },
      meta: { id: candidate.tool, type: "deterministic" },
    };
  }

  const { transcribe } = require("./background/mlx-whisper");
  const audio = options.audio || {};
  let filePath = audio.filePath || null;
  let tempPath = null;

  if (!filePath) {
    if (!audio.buffer) {
      throw new Error(`Deterministic tool ${candidate.tool} requires audio.buffer or audio.filePath`);
    }
    const ext = audioExtensionFromInput(audio);
    tempPath = path.join(
      os.tmpdir(),
      `myos-audio-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
    );
    fs.writeFileSync(tempPath, audio.buffer);
    filePath = tempPath;
  }

  try {
    const result = await transcribe(filePath, {
      language: audio.language,
    });
    return {
      text: String(result?.text || "").trim(),
      raw: result,
      usage: { inputTokens: 0, outputTokens: 0 },
      meta: { id: candidate.tool, type: "deterministic" },
    };
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

module.exports = {
  CANONICAL_TASK_CLASSES,
  COMPLIANCE_LANES,
  DETERMINISTIC_TOOLS,
  ROUTING_POLICY,
  clearLocalAssignmentsCache,
  deriveComplianceLane,
  executeDeterministicCandidate,
  isCanonicalTaskClass,
  isFableCandidate,
  normalizeComplianceLane,
  normalizeTaskClass,
  resolveExecutionPlan,
  validateExecutionCandidate,
};

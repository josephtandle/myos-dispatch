const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");

const { normalizeRecipeResult } = require("./recipe-utils");
const { runCodexWorker } = require("./background/codex-worker");
const { appendDispatcherEvent } = require("./dispatcher-memory");
const { matchProjects } = require("./workspace-context");
const { inferGoalScale } = require("./goal-scale");
const { resolveWorkspaceRoot } = require("./myos-compat");
const { runDataLookup } = require("./data-lookup");
const {
  startBackgroundTasks,
  buildBackgroundDigest,
  persistSidecarResults,
  resolveOptionalSidecarGraceMs,
} = require("./background/background-agent-runner");
const { compactParallelizationPlan } = require("./parallelization-planner");

const HOME = process.env.HOME || os.homedir();

// The recipe registry root is configurable via the MYOS_WORKSPACE env var (or a
// `roots` option on refreshRecipeRegistry). A fresh clone with no workspace
// simply yields an empty registry instead of failing.
function resolveRegistryWorkspaceRoot() {
  return process.env.MYOS_WORKSPACE || resolveWorkspaceRoot();
}

const WORKSPACE_ROOT = resolveRegistryWorkspaceRoot();
const SHARED_RECIPES_ROOT = path.join(WORKSPACE_ROOT, "agents/shared/recipes");
const AGENTS_ROOT = path.join(WORKSPACE_ROOT, "agents");
const PROJECTS_ROOT = path.join(WORKSPACE_ROOT, "projects");
const PROJECT_INDEX_PATH = path.join(PROJECTS_ROOT, "_index.json");
const REGISTRY_TTL_MS = 10_000;

let registryCache = {
  loadedAt: 0,
  recipes: [],
  byId: new Map(),
};

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function tokenize(value) {
  return normalizeText(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function listRecipeFiles(rootDir) {
  const files = [];
  if (!fs.existsSync(rootDir)) return files;

  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".recipe.json")) {
        files.push(fullPath);
      }
    }
  }
  return files.sort();
}

function buildRecipeRoots() {
  const roots = new Set([SHARED_RECIPES_ROOT]);

  if (fs.existsSync(AGENTS_ROOT)) {
    for (const entry of fs.readdirSync(AGENTS_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      roots.add(path.join(AGENTS_ROOT, entry.name, "recipes"));
    }
  }

  if (fs.existsSync(PROJECTS_ROOT)) {
    for (const entry of fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      roots.add(path.join(PROJECTS_ROOT, entry.name, "recipes"));
    }
  }

  return [...roots];
}

function loadRecipeManifest(filePath) {
  const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const dir = path.dirname(filePath);
  const handler = typeof manifest.handler === "string"
    ? path.resolve(dir, manifest.handler)
    : null;

  if (!manifest.id || typeof manifest.id !== "string") {
    throw new Error("Manifest is missing string id");
  }
  if (!["core", "agent", "project"].includes(manifest.layer)) {
    throw new Error(`Manifest has invalid layer for ${manifest.id}`);
  }
  if (!manifest.owner || typeof manifest.owner !== "string") {
    throw new Error(`Manifest is missing owner for ${manifest.id}`);
  }
  if (!manifest.title || typeof manifest.title !== "string") {
    throw new Error(`Manifest is missing title for ${manifest.id}`);
  }
  if (!handler || !fs.existsSync(handler)) {
    throw new Error(`Manifest handler does not exist for ${manifest.id}`);
  }
  if (manifest.tags && !Array.isArray(manifest.tags)) {
    throw new Error(`Manifest tags must be an array for ${manifest.id}`);
  }
  if (manifest.phrases && !Array.isArray(manifest.phrases)) {
    throw new Error(`Manifest phrases must be an array for ${manifest.id}`);
  }
  if (!manifest.inputMode || typeof manifest.inputMode !== "string") {
    throw new Error(`Manifest is missing inputMode for ${manifest.id}`);
  }
  if (!manifest.outputMode || typeof manifest.outputMode !== "string") {
    throw new Error(`Manifest is missing outputMode for ${manifest.id}`);
  }
  if (
    manifest.layer === "project" &&
    manifest.inputMode === "structured" &&
    (!Array.isArray(manifest.actions) || manifest.actions.length === 0)
  ) {
    throw new Error(`Structured project manifest must declare at least one action for ${manifest.id}`);
  }
  if (
    manifest.layer === "project" &&
    manifest.inputMode === "structured" &&
    (!Array.isArray(manifest.phrases) || manifest.phrases.length === 0) &&
    (!Array.isArray(manifest.tags) || manifest.tags.length === 0)
  ) {
    throw new Error(`Structured project manifest must declare phrases or tags for ${manifest.id}`);
  }

  return {
    ...manifest,
    filePath,
    dir,
    handler,
    phrases: Array.isArray(manifest.phrases) ? manifest.phrases : [],
    tags: Array.isArray(manifest.tags) ? manifest.tags : [],
    actions: Array.isArray(manifest.actions) ? manifest.actions : [],
    objects: Array.isArray(manifest.objects) ? manifest.objects : [],
    requiredArgs: Array.isArray(manifest.requiredArgs) ? manifest.requiredArgs : [],
    requiredTextPatterns: Array.isArray(manifest.requiredTextPatterns) ? manifest.requiredTextPatterns : [],
    requiredContext: Array.isArray(manifest.requiredContext) ? manifest.requiredContext : [],
    ambiguityPolicy: manifest.ambiguityPolicy || "fallback_to_worker",
    fallbackPolicy: manifest.fallbackPolicy || "worker_optional",
  };
}

function refreshRecipeRegistry(options = {}) {
  const useCustomRoots = Array.isArray(options.roots) && options.roots.length > 0;
  const roots = useCustomRoots ? options.roots : buildRecipeRoots();
  const files = roots.flatMap((root) => listRecipeFiles(root));
  const recipes = [];
  const byId = new Map();

  for (const filePath of files) {
    try {
      const manifest = loadRecipeManifest(filePath);
      if (!manifest.id || !manifest.layer || !manifest.handler) continue;
      recipes.push(manifest);
      byId.set(manifest.id, manifest);
    } catch (error) {
      console.error(`[dispatcher] Failed to load recipe manifest ${filePath}: ${error.message}`);
    }
  }

  const nextCache = {
    loadedAt: Date.now(),
    recipes,
    byId,
  };

  if (!useCustomRoots) {
    registryCache = nextCache;
  }

  return nextCache;
}

function getRecipeRegistry() {
  if (Date.now() - registryCache.loadedAt > REGISTRY_TTL_MS || registryCache.recipes.length === 0) {
    return refreshRecipeRegistry();
  }
  return registryCache;
}

function inferProjectSlug(request) {
  if (request.knownProject) return String(request.knownProject);

  let projectEntries = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(PROJECT_INDEX_PATH, "utf8"));
    projectEntries = Object.entries(parsed.projects || {}).map(([slug, value]) => ({
      slug,
      ...value,
    }));
  } catch {
    const registry = getRecipeRegistry();
    projectEntries = registry.recipes
      .filter((recipe) => recipe.layer === "project" && recipe.owner)
      .map((recipe) => ({
        slug: recipe.owner,
        name: recipe.owner,
        path: recipe.owner,
        aliases: [],
      }));
  }

  const matched = matchProjects(request.text || "", projectEntries, 1);
  return matched[0]?.slug || null;
}

function scoreRecipe(recipe, request, inferredProject) {
  return scoreRecipeMatch(recipe, request, inferredProject).score;
}

function scoreRecipeMatch(recipe, request, inferredProject) {
  const haystack = normalizeText(request.text || "");
  const tokens = new Set(tokenize(request.text || ""));
  let score = 0;
  let evidenceScore = 0;
  let directEvidenceScore = 0;

  if (request.knownRecipe && request.knownRecipe === recipe.id) {
    return {
      score: 1000,
      evidenceScore: 1000,
    };
  }

  if (recipe.layer === "project") {
    if (request.knownProject && request.knownProject === recipe.owner) score += 90;
    else if (inferredProject && inferredProject === recipe.owner) score += 55;
    else {
      return {
        score: 0,
        evidenceScore: 0,
      };
    }
  }

  for (const phrase of recipe.phrases) {
    const needle = normalizeText(phrase);
    if (!needle) continue;
    if (haystack.includes(needle)) {
      const points = Math.max(18, Math.min(48, needle.length));
      score += points;
      evidenceScore += points;
      directEvidenceScore += points;
    }
  }

  for (const tag of recipe.tags) {
    const needle = normalizeText(tag);
    if (!needle) continue;
    if (tokens.has(needle)) {
      score += 5;
      evidenceScore += 5;
      directEvidenceScore += 5;
    } else if (haystack.includes(needle)) {
      score += 3;
      evidenceScore += 3;
      directEvidenceScore += 3;
    }
  }

  for (const object of recipe.objects || []) {
    const needle = normalizeText(object);
    if (!needle) continue;
    if (tokens.has(needle)) {
      score += 8;
      evidenceScore += 8;
      directEvidenceScore += 8;
    } else if (haystack.includes(needle)) {
      score += 5;
      evidenceScore += 5;
      directEvidenceScore += 5;
    }
  }

  if (recipe.layer === "agent" && haystack.includes(recipe.owner || "")) {
    score += 14;
    evidenceScore += 14;
  }

  if (recipe.layer === "core") {
    score += 1;
  }

  return {
    score,
    evidenceScore,
    directEvidenceScore,
  };
}

function inferRequestIntent(request = {}) {
  const text = normalizeText(request.text || "");

  const hasCreate = /\b(make|create|generate|build|draft|render|produce|write)\b/.test(text);
  const hasRetrieve = /\b(get|find|retrieve|look up|locate|open|extract|pull)\b/.test(text);
  const hasSearch = /\b(search|look for|scan|check|inspect|review)\b/.test(text);
  const hasUrl = /\b(url|link|website|download link|download url)\b/.test(text);
  const hasExisting = /\b(existing|already made|already created|previous|earlier|yesterday)\b/.test(text);
  const hasPastCreate = /\bi created\b/.test(text);
  const hasArtifact = /\b(pdf|document|file|image|photo|link|url)\b/.test(text);

  let primaryAction = "unknown";
  let confidence = "low";

  if (hasCreate && !(hasRetrieve || hasSearch || hasUrl || hasExisting || hasPastCreate)) {
    primaryAction = "create";
    confidence = "high";
  } else if ((hasRetrieve || hasSearch || hasUrl) && !hasCreate) {
    primaryAction = hasSearch ? "search" : "retrieve";
    confidence = "high";
  } else if ((hasRetrieve || hasSearch || hasUrl) && hasCreate) {
    primaryAction = hasUrl || hasExisting || hasPastCreate ? "retrieve" : "unknown";
    confidence = "medium";
  } else if (hasPastCreate || hasExisting) {
    primaryAction = "retrieve";
    confidence = "medium";
  } else if (hasArtifact && hasCreate) {
    primaryAction = "create";
    confidence = "medium";
  }

  return {
    primaryAction,
    confidence,
    signals: {
      hasCreate,
      hasRetrieve,
      hasSearch,
      hasUrl,
      hasExisting,
      hasPastCreate,
      hasArtifact,
    },
  };
}

function scoreBand(score) {
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
  return "low";
}

function listCandidateRecipes(request) {
  const { recipes, byId } = getRecipeRegistry();
  const inferredProject = inferProjectSlug(request);

  if (request.knownRecipe) {
    return {
      inferredProject,
      candidates: [{
        recipe: byId.get(String(request.knownRecipe)) || null,
        inferredProject,
        score: byId.has(String(request.knownRecipe)) ? 1000 : 0,
      }].filter((entry) => entry.recipe),
    };
  }

  const candidates = [];
  for (const recipe of recipes) {
    const { score, evidenceScore, directEvidenceScore } = scoreRecipeMatch(recipe, request, inferredProject);
    if (score < 18) continue;
    candidates.push({ recipe, inferredProject, score, evidenceScore, directEvidenceScore });
  }

  candidates.sort((a, b) => b.score - a.score);
  return { inferredProject, candidates };
}

function validateRecipeCandidate(candidate, request = {}) {
  const recipe = candidate?.recipe || null;
  if (!recipe) {
    return { ok: false, reason: "missing_recipe", routeDecision: "fallback" };
  }

  const intent = inferRequestIntent(request);
  const band = scoreBand(candidate.score || 0);

  if (recipe.requiredContext.includes(`project:${recipe.owner}`) && candidate.inferredProject !== recipe.owner) {
    return { ok: false, reason: "missing_required_project_context", routeDecision: "fallback", intent, band };
  }

  if (recipe.layer === "project" && recipe.inputMode === "structured" && (candidate.evidenceScore || 0) < 18) {
    return { ok: false, reason: "weak_project_match", routeDecision: "fallback", intent, band };
  }

  if (recipe.layer === "project" && recipe.inputMode === "structured" && (candidate.directEvidenceScore || 0) < 8) {
    return { ok: false, reason: "missing_direct_recipe_evidence", routeDecision: "fallback", intent, band };
  }

  if (recipe.inputMode === "structured" && !hasStructuredInputEvidence(recipe, request)) {
    return { ok: false, reason: "missing_structured_inputs", routeDecision: "fallback", intent, band };
  }

  if (recipe.actions.length > 0 && intent.primaryAction !== "unknown" && !recipe.actions.includes(intent.primaryAction)) {
    return { ok: false, reason: "action_mismatch", routeDecision: "fallback", intent, band };
  }

  if (
    recipe.outputMode === "artifact" &&
    recipe.actions.includes("create") &&
    intent.primaryAction !== "create"
  ) {
    return { ok: false, reason: "artifact_request_not_create", routeDecision: "fallback", intent, band };
  }

  if (band === "low") {
    return { ok: false, reason: "low_confidence", routeDecision: "fallback", intent, band };
  }

  if (band === "medium" && intent.confidence === "medium" && recipe.ambiguityPolicy !== "allow") {
    return { ok: false, reason: "ambiguous_request", routeDecision: "fallback", intent, band };
  }

  return { ok: true, reason: "validated", routeDecision: "recipe", intent, band };
}

function hasStructuredInputEvidence(recipe, request = {}) {
  if (!recipe || recipe.inputMode !== "structured") return true;
  const requiredArgs = Array.isArray(recipe.requiredArgs) ? recipe.requiredArgs : [];
  const requiredTextPatterns = Array.isArray(recipe.requiredTextPatterns) ? recipe.requiredTextPatterns : [];

  if (requiredArgs.length === 0 && requiredTextPatterns.length === 0) return true;

  const hasArgValue = requiredArgs.every((key) => {
    const direct = request?.[key];
    if (direct !== undefined && direct !== null && String(direct).trim() !== "") return true;
    const nested = request?.args?.[key];
    return nested !== undefined && nested !== null && String(nested).trim() !== "";
  });

  if (hasArgValue) return true;
  if (requiredTextPatterns.length === 0) return false;

  const text = String(request.text || "");
  return requiredTextPatterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(text);
    } catch {
      return false;
    }
  });
}

function pickRecipe(request) {
  const { inferredProject, candidates } = listCandidateRecipes(request);
  const best = candidates[0] || null;
  return best || { recipe: null, inferredProject, score: 0 };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = options.timeoutMs > 0
      ? setTimeout(() => {
          if (finished) return;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 3000).unref();
        }, options.timeoutMs)
      : null;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finished = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      finished = true;
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function createArtifactDir(baseOutboxDir, chatId) {
  const root = path.resolve(baseOutboxDir || path.join(os.tmpdir(), "myos-artifacts"));
  const artifactDir = path.join(root, String(chatId || "unknown"), `${Date.now()}-${randomUUID().slice(0, 8)}`);
  ensureDirectory(artifactDir);
  return artifactDir;
}

async function runRecipe(recipeId, input = {}, options = {}) {
  const { byId } = getRecipeRegistry();
  const recipe = byId.get(String(recipeId));
  if (!recipe) {
    throw new Error(`Unknown recipe: ${recipeId}`);
  }

  delete require.cache[recipe.handler];
  const handlerModule = require(recipe.handler);
  const handler = typeof handlerModule === "function"
    ? handlerModule
    : handlerModule.runRecipe;

  if (typeof handler !== "function") {
    throw new Error(`Recipe handler is invalid for ${recipeId}`);
  }

  const artifactDir = createArtifactDir(input.outboxDir || options.outboxDir, input.chatId);
  const result = await handler(input, {
    recipe,
    artifactDir,
    inferredProject: options.inferredProject || inferProjectSlug(input),
    runProcess,
  });

  return normalizeRecipeResult(recipe, result, {
    route: {
      inferredProject: options.inferredProject || inferProjectSlug(input),
      fallbackPolicy: recipe.fallbackPolicy,
    },
  });
}

function shouldContinueOnRecipeError(request, error) {
  if (!error?.code) return false;
  return error.code === "RECIPE_FALLBACK" || error.code === "RECIPE_INPUT_ERROR";
}

function summarizeGoalRoute(goalMetadata = {}) {
  return {
    goalScale: goalMetadata.goalScale,
    goalMode: goalMetadata.goalMode,
    goalConfidence: goalMetadata.goalConfidence,
    goalReasons: goalMetadata.goalReasons,
    stopRules: goalMetadata.stopRules,
    requiresPlan: goalMetadata.requiresPlan,
    requiresApproval: goalMetadata.requiresApproval,
    blockedBy: goalMetadata.blockedBy,
  };
}

function summarizeAdoptionRoute(dispatchPlan = {}) {
  return {
    branch: dispatchPlan.branch || null,
    route: {
      lane: dispatchPlan.route?.lane || null,
      capabilityId: dispatchPlan.capabilityId || dispatchPlan.route?.capabilityId || null,
    },
  };
}

async function dispatchTask(request = {}) {
  const startedAt = Date.now();
  const eventId = `dispatch-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const { inferredProject, candidates } = listCandidateRecipes(request);
  const candidateSummaries = candidates.map((candidate) => ({
    recipeId: candidate.recipe.id,
    layer: candidate.recipe.layer,
    owner: candidate.recipe.owner,
    score: candidate.score,
    validation: validateRecipeCandidate(candidate, request),
  }));
  const goalMetadata = request.dispatchPlan?.goalScale
    ? inferGoalScale(request.dispatchPlan)
    : inferGoalScale(request, {
        inferredProject,
        candidates: candidateSummaries,
        route: {
          lane: candidates[0]?.recipe?.layer || "fallback",
          candidates: candidateSummaries,
        },
      });
  const dispatchPlan = {
    ...(request.dispatchPlan || {}),
    ...goalMetadata,
  };
  const routeLane = dispatchPlan.route?.lane || null;
  const adoptionRoute = summarizeAdoptionRoute(dispatchPlan);

  if (dispatchPlan.branch === "data" && routeLane !== "data_lookup") {
    appendDispatcherEvent({
      id: eventId,
      ts: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      bot: request.sourceLabel || request.caller || "unknown",
      caller: request.caller || null,
      channel: request.channel || null,
      chatId: request.chatId || null,
      text: String(request.text || ""),
      inferredProject,
      candidates: candidateSummaries,
      goal: goalMetadata,
      outcome: {
        type: "data_lookup_skipped",
        dispatchPlan: adoptionRoute,
        routeLane,
        fallbackReason: dispatchPlan.dataLookupCanary?.reason || "lane_not_data_lookup",
        dataSources: Array.isArray(dispatchPlan.dataSources) ? dispatchPlan.dataSources : [],
        canary: dispatchPlan.dataLookupCanary || null,
      },
    });
  }

  if (routeLane === "data_lookup") {
    const result = await runDataLookup({
      ...request,
      dispatchPlan,
    });
    result.metadata = {
      ...(result.metadata || {}),
      route: {
        ...(result.metadata?.route || {}),
        inferredProject,
        ...summarizeGoalRoute(goalMetadata),
      },
      goal: goalMetadata,
    };
    appendDispatcherEvent({
      id: eventId,
      ts: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      bot: request.sourceLabel || request.caller || "unknown",
      caller: request.caller || null,
      channel: request.channel || null,
      chatId: request.chatId || null,
      text: String(request.text || ""),
      inferredProject,
      candidates: candidateSummaries,
      goal: goalMetadata,
      outcome: {
        type: "data_lookup",
        dispatchPlan: adoptionRoute,
        recipeId: "data/lookup",
        dataSources: result.metadata?.dataLookup?.dataSources || [],
        searchScope: result.metadata?.dataLookup?.searchScope || null,
        dataSectionCount: result.metadata?.dataLookup?.dataSectionCount || 0,
        empty: result.metadata?.dataLookup?.empty ?? null,
        emptyReason: result.metadata?.dataLookup?.emptyReason || null,
        fallbackReason: result.metadata?.dataLookup?.fallbackReason || null,
        latencyMs: result.metadata?.dataLookup?.latencyMs || null,
        canary: result.metadata?.dataLookup?.canary || null,
      },
    });
    return result;
  }

  for (const candidate of candidates) {
    const validation = validateRecipeCandidate(candidate, request);
    if (!validation.ok) continue;

    try {
      const result = await runRecipe(candidate.recipe.id, request, { inferredProject: candidate.inferredProject });
      result.metadata = {
        ...(result.metadata || {}),
        route: {
          ...(result.metadata?.route || {}),
          score: candidate.score,
          scoreBand: validation.band,
          intent: validation.intent,
          ...summarizeGoalRoute(goalMetadata),
        },
        goal: goalMetadata,
      };
      appendDispatcherEvent({
        id: eventId,
        ts: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        bot: request.sourceLabel || request.caller || "unknown",
        caller: request.caller || null,
        channel: request.channel || null,
        chatId: request.chatId || null,
        text: String(request.text || ""),
        inferredProject,
        candidates: candidateSummaries,
        goal: goalMetadata,
        outcome: {
          type: "recipe",
          dispatchPlan: adoptionRoute,
          recipeId: candidate.recipe.id,
          layer: candidate.recipe.layer,
          owner: candidate.recipe.owner,
          artifactCount: Array.isArray(result.artifacts) ? result.artifacts.length : 0,
        },
      });
      return result;
    } catch (error) {
      if (!shouldContinueOnRecipeError(request, error)) {
        appendDispatcherEvent({
          id: eventId,
          ts: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          bot: request.sourceLabel || request.caller || "unknown",
          caller: request.caller || null,
          channel: request.channel || null,
          chatId: request.chatId || null,
          text: String(request.text || ""),
          inferredProject,
          candidates: candidateSummaries,
          goal: goalMetadata,
          outcome: {
            type: "error",
            dispatchPlan: adoptionRoute,
            recipeId: candidate.recipe.id,
            errorCode: error?.code || "DISPATCH_ERROR",
            errorMessage: error?.message || "Unknown dispatch error",
          },
        });
        throw error;
      }
    }
  }

  if (request.fallback?.type === "worker") {
    const result = await runCodexWorker({
      chatId: request.chatId,
      command: request.fallback.command,
      cwd: request.fallback.cwd,
      model: request.fallback.model,
      sessionId: request.fallback.sessionId || null,
      systemPrompt: request.systemPrompt || "",
      userText: request.text || "",
      outboxDir: request.outboxDir,
      displayName: request.displayName || "User",
      sourceLabel: request.sourceLabel,
      dispatchPlan,
      timeoutMs: request.fallback.timeoutMs || 600000,
    });

    const workerResult = {
      status: "ok",
      reply: result.reply,
      artifacts: result.artifacts,
      recipeId: "fallback/worker",
      metadata: {
        route: {
          recipeId: "fallback/worker",
          layer: "fallback",
          owner: "worker",
          inferredProject,
          fallbackFromRecipeId: candidates[0]?.recipe?.id || null,
          ...summarizeGoalRoute(goalMetadata),
        },
        goal: goalMetadata,
      },
      usage: result.usage,
      sessionId: result.sessionId || null,
    };
    appendDispatcherEvent({
      id: eventId,
      ts: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      bot: request.sourceLabel || request.caller || "unknown",
      caller: request.caller || null,
      channel: request.channel || null,
      chatId: request.chatId || null,
      text: String(request.text || ""),
      inferredProject,
      candidates: candidateSummaries,
      goal: goalMetadata,
      outcome: {
        type: "worker",
        dispatchPlan: adoptionRoute,
        recipeId: "fallback/worker",
        fallbackFromRecipeId: candidates[0]?.recipe?.id || null,
        artifactCount: Array.isArray(result.artifacts) ? result.artifacts.length : 0,
        usage: result.usage || null,
      },
    });
    return workerResult;
  }

  appendDispatcherEvent({
    id: eventId,
    ts: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    bot: request.sourceLabel || request.caller || "unknown",
    caller: request.caller || null,
    channel: request.channel || null,
    chatId: request.chatId || null,
    text: String(request.text || ""),
    inferredProject,
    candidates: candidateSummaries,
    goal: goalMetadata,
    outcome: {
      type: "error",
      dispatchPlan: adoptionRoute,
      errorCode: "NO_ROUTE",
      errorMessage: "No matching recipe and no fallback configured",
    },
  });
  throw new Error("No matching recipe and no fallback configured");
}

async function dispatchTaskWithBackground(request = {}, options = {}) {
  const parallelizationPlan = request.dispatchPlan?.parallelizationPlan || null;
  const sidecarArtifactPath = parallelizationPlan?.backgroundTasks?.length
    ? path.join(WORKSPACE_ROOT, "agents", "shared", "data", "sidecar-results", `${Date.now()}-${String(request.chatId || "dispatch")}.json`)
    : null;
  const backgroundController = startBackgroundTasks(parallelizationPlan, {
    enabled: options.backgroundAgentsEnabled !== false,
    command: options.backgroundWorkerCommand || options.workerCommand || "codex",
    callerProvider: options.callerProvider
      || (options.backgroundWorkerCommand ? undefined : (options.workerCommand || "codex")),
    cwd: options.cwd || HOME,
    provider: options.provider,
    runCommand: options.backgroundRunCommand,
    timeoutMs: options.backgroundTimeoutMs,
    parallelizationStateFile: options.parallelizationStateFile,
    env: options.env,
  });
  const requiredBackgroundResults = await backgroundController.requiredPromise;
  if (parallelizationPlan) {
    parallelizationPlan.requiredResults = requiredBackgroundResults;
    parallelizationPlan.requiredDigest = buildBackgroundDigest(requiredBackgroundResults, {
      artifactPath: sidecarArtifactPath || undefined,
    });
    if (sidecarArtifactPath && requiredBackgroundResults.length > 0) {
      persistSidecarResults(requiredBackgroundResults, { file: sidecarArtifactPath });
    }
  }

  const result = await dispatchTask(request);
  const optionalGraceMs = resolveOptionalSidecarGraceMs(options.env || process.env);
  const settledAllResults = await Promise.race([
    backgroundController.allPromise.catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), optionalGraceMs)),
  ]);
  const backgroundResults = settledAllResults || requiredBackgroundResults;
  if (sidecarArtifactPath && backgroundResults.length > 0) {
    persistSidecarResults(backgroundResults, { file: sidecarArtifactPath });
  }
  if (!settledAllResults && parallelizationPlan?.backgroundTasks?.length) {
    backgroundController.allPromise.then((allResults) => {
      if (sidecarArtifactPath) persistSidecarResults(allResults, { file: sidecarArtifactPath });
    }).catch(() => {});
  }

  if (parallelizationPlan) {
    result.metadata = {
      ...(result.metadata || {}),
      parallelization: {
        plan: compactParallelizationPlan(parallelizationPlan),
        results: backgroundResults,
        lateResultsPending: Math.max(0, (parallelizationPlan.backgroundTasks?.length || 0) - backgroundResults.length),
        optionalGraceMs,
        optionalGraceUsed: !settledAllResults && Boolean(parallelizationPlan?.backgroundTasks?.length),
      },
    };
  }

  return result;
}

module.exports = {
  dispatchTask,
  dispatchTaskWithBackground,
  getRecipeRegistry,
  inferRequestIntent,
  inferProjectSlug,
  listCandidateRecipes,
  loadRecipeManifest,
  pickRecipe,
  refreshRecipeRegistry,
  runRecipe,
  scoreRecipe,
  scoreBand,
  validateRecipeCandidate,
};

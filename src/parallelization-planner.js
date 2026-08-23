"use strict";

const path = require("node:path");

const { getParallelizationStage } = require("./promotion/parallelization-version-policy");
const { backgroundAgentsDisabled, isUnattendedContext } = require("./env-context");
const { inferGoalScale } = require("./goal-scale");
const {
  buildExecutionEnvelope,
  buildTaskExecutionEnvelope,
  compactExecutionEnvelope,
  roleProfileForTask,
} = require("./orchestration/execution-envelope");
const {
  compactRepositoryRouting,
  resolveRepositoryTarget,
} = require("./repository-targets");

const PLAN_VERSION = "myos-parallelization-writable-v1";
const DEFAULT_MAX_SIDECARS = 12;
const MAX_SIDECAR_CAP = 20;
const DEFAULT_WRITABLE_LANE_CAP = 4;
const READ_ONLY_TIMEOUT_MS = 180 * 1000;
const WRITABLE_TIMEOUT_MS = 300 * 1000;
const DEFAULT_TIMEOUT_MS = READ_ONLY_TIMEOUT_MS;
const MAX_SCOUT_LANES = 6;
const DEFAULT_AGGRESSION_NON_TRIVIAL = "deep";
const DEFAULT_AGGRESSION_IMPLEMENTATION = "deep";
const DEFAULT_DEPTH = Object.freeze({
  off: 0,
  balanced: 1,
  deep: 2,
});

const BLOCKERS = Object.freeze([
  {
    id: "browser_control",
    pattern: /\b(open|refresh|screenshot|click|type|control|bring up)\b.{0,40}\b(browser|chrome|page|tab|localhost|website)\b|\b(browser|chrome)\b.{0,40}\b(open|refresh|screenshot|click|type|control)\b/i,
  },
  {
    id: "user_visible_send",
    pattern: /\b(send|message|text|email|whatsapp|telegram|gmail|dm)\b.{0,64}\b(to|client|customer|team|group|everyone)\b/i,
  },
  {
    id: "payment_or_account_mutation",
    pattern: /\b(stripe|checkout|payment|billing|bank|wise|paypal|invoice|charge|refund|account)\b.{0,64}\b(create|update|change|fix|send|link|mutate|write|delete|remove)\b|\b(create|update|change|fix|send|delete|remove)\b.{0,64}\b(stripe|checkout|payment|billing|bank|wise|paypal|invoice|charge|refund|account)\b/i,
  },
  {
    id: "auth_sensitive",
    pattern: /\b(password|passkey|token|secret|api key|credential|session cookie|private key)\b/i,
  },
  {
    id: "interactive_auth_action",
    pattern: /\b(log in|login|sign in|signin|authenticate|reauth|authorize)\b.{0,64}\b(account|oauth|google|gmail|stripe|github|openai|anthropic|browser|console)\b|\b(account|oauth|google|gmail|stripe|github|openai|anthropic|browser|console)\b.{0,64}\b(log in|login|sign in|signin|authenticate|reauth|authorize)\b/i,
  },
  {
    id: "destructive_or_approval_sensitive",
    pattern: /\b(delete|destroy|drop database|rm -rf|wipe|revoke|production data|prod data|firewall|dns|billing|charge)\b|rotate\b.{0,32}\bkey\b/i,
  },
]);

const MULTI_PART_RE = /\b(and then|then|after that|also|plus|while|across|end-to-end|through verification|deploy and commit|verify and|test and|review and)\b|[,;].*[,;]/i;
const IMPLEMENTATION_RE = /\b(implement|fix|build|create|update|add|wire|ship|deploy|debug|repair|refactor|migrate)\b/i;
const VERIFICATION_RE = /\b(verify|test|audit|review|evaluate|check|qa|confirm|make sure)\b/i;
const RESEARCH_RE = /\b(investigate|analyze|look into|research|understand|explain|what's going on|why|how does|architecture|plan|strategy)\b/i;
const DIRECT_RE = /\b(are you awake|status|what is|what's|where is|who is|which|give me|show|list)\b/i;
const COMMAND_HANDLING_RE = /\b(command|commands|slash command|handler|entrypoint|entry point|cli|subcommand|dispatcher command)\b/i;

function normalizeText(value) {
  if (Array.isArray(value)) return value.map(normalizeText).join(" ");
  if (value && typeof value === "object") {
    if (Array.isArray(value.messages)) {
      return value.messages.map((message) => normalizeText(message?.content || "")).join(" ");
    }
    return normalizeText(value.text || value.prompt || value.command || value.query || "");
  }
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function detectBlockedReasons(text, plan = {}) {
  const reasons = [];
  for (const blocker of BLOCKERS) {
    if (blocker.pattern.test(text)) reasons.push(blocker.id);
  }

  const protectedSurface = plan.projectSlug && ["allsorted", "goldenclaw"].includes(String(plan.projectSlug).toLowerCase());
  if (protectedSurface && plan.actionType === "write") {
    reasons.push("protected_surface_write");
  }

  return [...new Set(reasons)];
}

function getCriticalPath(plan = {}) {
  const lane = plan.route?.lane || plan.executionLane || "worker_skill";
  if (plan.branch === "data" && lane === "data_lookup") return "deterministic_data_lookup";
  if (plan.stopAfterMatch && lane === "recipe_dispatcher") return "recipe_dispatcher";
  if (plan.stopAfterMatch && lane === "workflow") return "workflow";
  if (plan.branch === "project") return "project_context_then_worker";
  return lane;
}

function modelProfileForKind(kind) {
  if (kind === "implement") return "default_automation";
  if (kind === "verify") return "default_automation";
  if (kind === "safety") return "default_automation";
  return "openai_cheap_extraction";
}

function resolveTaskTimeoutMs(mode, env = process.env) {
  const fallback = mode === "workspace_write" ? WRITABLE_TIMEOUT_MS : READ_ONLY_TIMEOUT_MS;
  return clampInt(env?.MYOS_BACKGROUND_TIMEOUT_MS, fallback, 30 * 1000, 15 * 60 * 1000);
}

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function resolveMaxSidecars(env = process.env) {
  const raw = env?.MYOS_PARALLELIZATION_MAX_SIDECARS ?? env?.MYOS_PARALLELIZATION_MAX_AGENTS;
  return clampInt(raw, DEFAULT_MAX_SIDECARS, 0, MAX_SIDECAR_CAP);
}

function resolveWritableLaneCap(env = process.env, maxSidecars = DEFAULT_MAX_SIDECARS) {
  return clampInt(env?.MYOS_PARALLELIZATION_MAX_WRITABLE_SIDECARS, Math.min(DEFAULT_WRITABLE_LANE_CAP, maxSidecars), 0, Math.min(DEFAULT_WRITABLE_LANE_CAP, maxSidecars));
}

function inferAggression(text, plan = {}, env = process.env) {
  const override = String(env?.MYOS_PARALLELIZATION_AGGRESSION || "").trim().toLowerCase();
  if (["off", "balanced", "deep"].includes(override)) return override;

  const hasImplementation = IMPLEMENTATION_RE.test(text) || plan.actionType === "write";
  const hasMultiPart = MULTI_PART_RE.test(text);
  const hasVerification = VERIFICATION_RE.test(text);
  const hasResearch = RESEARCH_RE.test(text);
  const hasExploratoryIntent = String(plan.intentType || "").toLowerCase() === "exploratory";
  const isShortDirectPrompt = DIRECT_RE.test(text) && text.split(/\s+/).length <= 6;
  if (isShortDirectPrompt && !hasImplementation && !hasVerification && !hasResearch && !hasMultiPart) return "off";
  if (hasImplementation || hasMultiPart || hasVerification || hasResearch || hasExploratoryIntent) return DEFAULT_AGGRESSION_IMPLEMENTATION;
  return DEFAULT_AGGRESSION_NON_TRIVIAL;
}

function resolveDepth(aggression, env = process.env) {
  const fallback = DEFAULT_DEPTH[aggression] ?? 0;
  return clampInt(env?.MYOS_PARALLELIZATION_DEPTH, fallback, 0, 3);
}

function sidecarBudgetForAggression(aggression, maxSidecars) {
  if (aggression === "off") return 0;
  if (aggression === "balanced") return Math.min(6, maxSidecars);
  return maxSidecars;
}

function isTaskKindQuarantined(stage = {}, taskKind = "") {
  const quarantines = stage.state?.health?.activeQuarantines || stage.health?.activeQuarantines || [];
  return quarantines.some((quarantine) => (
    quarantine.type === "taskKind" &&
    String(quarantine.value || "").toLowerCase() === String(taskKind || "").toLowerCase()
  ));
}

function normalizeOwnershipRoot(scope = "", cwd = process.cwd()) {
  const base = String(scope || "").trim() || cwd;
  return path.resolve(base);
}

function repoEligibleForWritable(plan = {}, blockedReasons = [], env = process.env, repositoryRouting = {}) {
  if (blockedReasons.length > 0) return false;
  if (isUnattendedContext(env)) return false;
  if (String(env?.MYOS_ORCHESTRATION_GOLD_ENABLED ?? "1") === "0") return false;
  if (String(env?.MYOS_WRITABLE_SIDECARS_ENABLED ?? "1") === "0") return false;
  if (String(plan.actionType || "").toLowerCase() !== "write") return false;
  if (repositoryRouting.writableSafe === false) return false;
  const lane = plan.route?.lane || plan.executionLane || "";
  if (lane === "data_lookup" || lane === "workflow") return false;
  return true;
}

function buildTask({
  id,
  kind,
  role,
  prompt,
  scope,
  ownershipPaths,
  writeScope,
  required = false,
  mode = "read_only",
  joinPolicy,
  risk = "low",
  generation = 1,
  providerAffinity = "caller_provider",
  timeoutMs,
  executionEnvelope,
}) {
  const taskShape = { id, kind, role, mode };
  const agentProfile = roleProfileForTask(taskShape);
  return {
    id,
    kind,
    role,
    agentProfile: agentProfile.id,
    fallbackAgentProfile: agentProfile.fallback,
    roleContract: agentProfile.contract,
    prompt,
    scope: scope || "",
    ownershipPaths: Array.isArray(ownershipPaths) ? ownershipPaths : [],
    writeScope: Array.isArray(writeScope) ? writeScope : [],
    required,
    mode,
    generation,
    providerAffinity,
    modelProfile: modelProfileForKind(kind),
    model: null,
    timeoutMs: timeoutMs || resolveTaskTimeoutMs(mode),
    joinPolicy: joinPolicy || (required ? "require_before_final" : "optional_before_final"),
    risk,
    capabilityEvidence: mode === "workspace_write" ? "writablePatchWorktree" : "readOnlySidecars",
    executionEnvelope: buildTaskExecutionEnvelope(executionEnvelope, taskShape),
  };
}

function buildWritablePrompt(role, text, scope) {
  const scopeLabel = scope || "resolved scoped repository area";
  if (role === "implement") {
    return [
      "Implement the requested change in your isolated git worktree.",
      `Writable scope: ${scopeLabel}.`,
      `Request: ${text}`,
      "Keep edits bounded to the assigned ownership paths. Return a concise summary, changed files, verification result, and blockers.",
    ].join("\n");
  }
  if (role === "verify") {
    return [
      "Review the request in your isolated git worktree and make only the smallest corrective edits needed.",
      `Writable scope: ${scopeLabel}.`,
      `Request: ${text}`,
      "Prefer verification and minimal fixes. Return changed files, verification result, and blockers.",
    ].join("\n");
  }
  return [
    "Perform a safety pass in your isolated git worktree and apply only bounded hardening edits if clearly needed.",
    `Writable scope: ${scopeLabel}.`,
    `Request: ${text}`,
    "Focus on rollback, invariants, and obvious risk controls. Return changed files, verification result, and blockers.",
  ].join("\n");
}

function buildReadOnlyPrompt(role, text, scope) {
  const scopeLabel = scope || "resolved scoped repository area";
  if (role === "verify") {
    return [
      "Review the likely verification surface for this request.",
      `Scope: ${scopeLabel}.`,
      `Request: ${text}`,
      "Return exact checks, likely breakpoints, and blockers. Do not edit anything.",
    ].join("\n");
  }
  if (role === "safety") {
    return [
      "Review the safety and rollback surface for this request.",
      `Scope: ${scopeLabel}.`,
      `Request: ${text}`,
      "Return hard blockers, rollback levers, and confidence. Do not edit anything.",
    ].join("\n");
  }
  return [
    "Review the request and identify the smallest implementation path.",
    `Scope: ${scopeLabel}.`,
    `Request: ${text}`,
    "Return likely files, contracts, and blockers. Do not edit anything.",
  ].join("\n");
}

function splitClauses(text) {
  return String(text || "")
    .split(/[,;]|\band then\b|\bthen\b|\bafter that\b|\band\b|\bplus\b|\balso\b/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.split(/\s+/).filter(Boolean).length >= 2)
    .slice(0, MAX_SCOUT_LANES);
}

function buildLaneSpecs(text, plan = {}, options = {}) {
  const scope = options.taskScope || plan.searchScope || "";
  const ownershipRoot = normalizeOwnershipRoot(scope);
  const env = options.env;
  const scopeLabel = scope || "resolved scoped repository area";
  const specs = [];
  const seenPrompts = new Set();
  const push = (task) => {
    const key = normalizeText(task.prompt);
    if (!key || seenPrompts.has(key)) return;
    seenPrompts.add(key);
    specs.push(task);
  };
  const readOnlyLane = (overrides) => buildTask({
    scope,
    ownershipPaths: [ownershipRoot],
    writeScope: [],
    required: false,
    mode: "read_only",
    risk: "low",
    timeoutMs: resolveTaskTimeoutMs("read_only", env),
    executionEnvelope: options.executionEnvelope,
    ...overrides,
  });

  if (options.writableEligible) {
    push(buildTask({
      id: "implement-1",
      kind: "implement",
      role: "implement",
      prompt: buildWritablePrompt("implement", text, scope),
      scope,
      ownershipPaths: [ownershipRoot],
      writeScope: [ownershipRoot],
      required: true,
      mode: "workspace_write",
      risk: "medium",
      timeoutMs: resolveTaskTimeoutMs("workspace_write", env),
      executionEnvelope: options.executionEnvelope,
    }));
  }

  push(readOnlyLane({
    id: "context-1",
    kind: "context",
    role: "context",
    prompt: [
      "Map the execution surface for this request.",
      scope
        ? `Scope: ${scopeLabel}.`
        : plan.projectSlug
          ? `Project: ${plan.projectSlug}.`
          : "Scope: infer the likely workspace/project surface from Dispatch evidence and the request.",
      `Request: ${text}`,
      "Return the specific files, configs, entry points, data sources, or handlers that matter, each with a one-line note. Do not edit anything.",
    ].join("\n"),
  }));

  push(readOnlyLane({
    id: "decompose-1",
    kind: "context",
    role: "decompose",
    prompt: [
      "Decompose this request into independent work lanes that can safely run in parallel.",
      `Scope: ${scopeLabel}.`,
      `Request: ${text}`,
      "Return the maximum useful fan-out, lane names, dependencies, and which lane must stay on the critical path. Do not edit anything.",
    ].join("\n"),
  }));

  const capabilityCandidates = (plan.route?.candidates || [])
    .filter((candidate) => candidate?.id)
    .slice(0, 2);
  capabilityCandidates.forEach((candidate, index) => {
    push(readOnlyLane({
      id: `capability-${index + 1}`,
      kind: "capability",
      role: "capability",
      prompt: [
        `Evaluate whether the existing capability "${candidate.id}" already handles this request.`,
        `Scope: ${scopeLabel}.`,
        `Request: ${text}`,
        "Name its handler, what it covers, what it misses, and any blockers. Do not edit anything.",
      ].join("\n"),
    }));
  });

  splitClauses(text).forEach((clause, index) => {
    push(readOnlyLane({
      id: `scout-${index + 1}`,
      kind: "implement",
      role: "scout",
      risk: "medium",
      prompt: [
        "Investigate one bounded part of a larger request and identify the smallest implementation path for it.",
        `Part: ${clause}`,
        `Scope: ${scopeLabel}.`,
        `Full request for context: ${text}`,
        "Return likely files, contracts, and blockers for this part only. Do not edit anything.",
      ].join("\n"),
    }));
  });

  // Verification remains an independent read-only lane. A second parallel
  // writer with the same ownership path cannot verify the implementer's
  // isolated patch and can create a conflicting patch of its own.
  push(readOnlyLane({
    id: "verify-1",
    kind: "verify",
    role: "verify",
    risk: "medium",
    prompt: buildReadOnlyPrompt("verify", text, scope),
  }));

  push(readOnlyLane({
    id: "acceptance-1",
    kind: "verify",
    role: "acceptance",
    risk: "medium",
    prompt: [
      "Define the acceptance checks for this request.",
      `Scope: ${scopeLabel}.`,
      `Request: ${text}`,
      "Return concrete verification commands, manual checks, expected artifacts, and failure signals. Do not edit anything.",
    ].join("\n"),
  }));

  if (plan.actionType === "write") {
    push(readOnlyLane({
      id: "safety-1",
      kind: "safety",
      role: "safety",
      risk: "medium",
      prompt: buildReadOnlyPrompt("safety", text, scope),
    }));
  }

  return specs;
}

function buildParallelizationPlan(input, basePlan = {}, signals = {}) {
  const text = normalizeText(input);
  const stage = signals.parallelizationStage || getParallelizationStage({
    stateFile: signals.parallelizationStateFile,
    env: signals.env,
  });
  const env = signals.env || process.env;
  const backgroundDisabled = backgroundAgentsDisabled(env);
  const blockedReasons = detectBlockedReasons(text, basePlan);
  if (backgroundDisabled) blockedReasons.push("background_agents_disabled");
  const criticalPath = getCriticalPath(basePlan);
  const aggression = inferAggression(text, basePlan, env);
  const maxSidecars = resolveMaxSidecars(env);
  const depth = resolveDepth(aggression, env);
  const writableLaneCap = resolveWritableLaneCap(env, maxSidecars);
  const repositoryRouting = resolveRepositoryTarget(text, basePlan, {
    workspaceRoot: signals.workspaceRoot,
    projectIndexPath: signals.projectIndexPath,
    cwd: signals.cwd,
  });
  // finalizeDispatchPlan computes the authoritative goal metadata after this
  // planner returns. The execution envelope still needs the same preliminary
  // scale now so scale-gated contracts are present during hook rendering.
  const envelopePlan = basePlan.goalScale
    ? basePlan
    : { ...basePlan, ...inferGoalScale(text, basePlan) };
  const taskClass = basePlan.taskClass
    || signals.taskClass
    || (basePlan.actionType === "write"
      ? "default_automation"
      : basePlan.actionType === "read"
        ? "cheap_routing"
        : null);
  const executionEnvelope = buildExecutionEnvelope(text, envelopePlan, {
    env,
    blockedReasons,
    taskClass,
  });
  const writableEligible = Boolean(stage.capabilities?.writableGitWorktrees) &&
    repoEligibleForWritable(basePlan, blockedReasons, env, repositoryRouting);
  const deterministicRoute = ["recipe_dispatcher", "workflow", "deterministic_data_lookup", "data_lookup"].includes(criticalPath);
  const deterministicRouteBlocksFanout = deterministicRoute && !(
    criticalPath === "recipe_dispatcher" &&
    COMMAND_HANDLING_RE.test(text)
  );
  const candidateTasks = backgroundDisabled || blockedReasons.length > 0 || aggression === "off" || deterministicRouteBlocksFanout
    ? []
    : buildLaneSpecs(text, basePlan, {
        writableEligible,
        writableLaneCap,
        taskScope: repositoryRouting.taskScope,
        executionEnvelope,
        env,
      });
  const backgroundTasks = candidateTasks
    .filter((task) => !isTaskKindQuarantined(stage, task.kind))
    .slice(0, sidecarBudgetForAggression(aggression, maxSidecars));
  const requiredTasks = backgroundTasks.filter((task) => task.required);
  const mode = backgroundTasks.length === 0
    ? "none"
    : backgroundTasks.some((task) => task.mode === "workspace_write")
      ? "provider_affine_git_worktrees"
      : "read_only";

  return {
    version: stage.planVersion || PLAN_VERSION,
    mode,
    reason: backgroundDisabled
      ? "background_agents_disabled_by_env"
      : blockedReasons.length > 0
      ? "blocked_by_hard_or_user_visible_gate"
      : deterministicRouteBlocksFanout
        ? "deterministic_route_no_consumer"
        : backgroundTasks.length > 0
          ? writableEligible
            ? "provider_affine_writable_background_work_identified"
            : "provider_affine_read_only_background_work_identified"
          : "no_safe_parallel_work_needed",
    criticalPath,
    aggression,
    depth,
    backgroundTasks,
    blockedReasons,
    repositoryRouting: compactRepositoryRouting(repositoryRouting),
    executionEnvelope,
    budget: {
      maxAgents: backgroundTasks.length,
      maxSidecars,
      writableLaneCap,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      tokenStrategy: "provider_affine_lowest_cost_reliable_model",
    },
    joinPolicy: requiredTasks.length > 0 ? "require_before_final" : "none",
    providerPolicy: {
      affinity: "caller_provider",
      writableFallback: "read_only_same_provider_then_single_worker",
      crossProviderMixing: false,
    },
    modelPolicy: {
      defaultProfile: "openai_cheap_extraction",
      escalationProfile: "openai_heavy_reasoning",
      rule: "keep sidecars provider-affine and use the lowest-cost model/profile that can reliably complete each bounded lane",
    },
    authPolicy: {
      humanDrivenMode: "oauth",
      backgroundAuthMode: isUnattendedContext(env) ? "api_key" : "provider_human_oauth_only",
      allowedRunner: "caller_provider",
      secretMaterial: "blocked",
      writableRollout: isUnattendedContext(env) ? "read_only_only" : "human_repo_work_only",
      rule: "background sidecars must not authenticate, refresh tokens, or read secret material",
    },
    promotion: {
      policyVersion: stage.policyVersion || "",
      activeStage: stage.id || "writable_sidecars_v1",
      activeVersion: stage.planVersion || PLAN_VERSION,
      nextStage: stage.nextStage || null,
      source: stage.source || "state",
      autoPromote: Boolean(stage.autoPromote && stage.nextStage),
      criteria: stage.promotionCriteria || null,
    },
    capabilities: stage.capabilities || {
      readOnlySidecars: true,
      safeVerificationExecution: false,
      boundedImplementationSlices: false,
      writableGitWorktrees: true,
    },
    health: stage.state?.health || {
      status: "healthy",
      activeQuarantines: [],
      openRepairActions: [],
    },
    execution: {
      enabledByDefault: !backgroundDisabled,
      disableEnv: "MYOS_BACKGROUND_AGENTS_ENABLED=0",
      defaultRunner: "caller_provider_sidecars",
      autoPromotionDisableEnv: "MYOS_PARALLELIZATION_AUTO_PROMOTE=0",
      versionOverrideEnv: "MYOS_PARALLELIZATION_VERSION=writable_sidecars_v1|v2|v3|v4",
      orchestrationKillSwitch: "MYOS_ORCHESTRATION_GOLD_ENABLED=0",
    },
    requiredTaskCount: requiredTasks.length,
  };
}

function compactParallelizationPlan(plan = {}) {
  if (!plan || typeof plan !== "object") return null;
  return {
    version: plan.version || PLAN_VERSION,
    mode: plan.mode || "none",
    reason: plan.reason || "",
    criticalPath: plan.criticalPath || "",
    aggression: plan.aggression || "off",
    depth: Number(plan.depth || 0),
    blockedReasons: Array.isArray(plan.blockedReasons) ? plan.blockedReasons : [],
    backgroundTaskCount: Array.isArray(plan.backgroundTasks) ? plan.backgroundTasks.length : 0,
    requiredTaskCount: Number(plan.requiredTaskCount || 0),
    backgroundTasks: Array.isArray(plan.backgroundTasks)
      ? plan.backgroundTasks.map((task) => ({
          id: task.id,
          kind: task.kind,
          role: task.role || task.kind,
          agentProfile: task.agentProfile || null,
          fallbackAgentProfile: task.fallbackAgentProfile || null,
          mode: task.mode || "read_only",
          required: Boolean(task.required),
          scope: task.scope || "",
          modelProfile: task.modelProfile || "cheap_routing",
          joinPolicy: task.joinPolicy || "optional_before_final",
          risk: task.risk || "low",
          executionEnvelope: task.executionEnvelope
            ? {
                trustClass: task.executionEnvelope.trustClass,
                filesystemProfile: task.executionEnvelope.filesystemProfile,
                sideEffectClass: task.executionEnvelope.sideEffectClass,
                agentProfile: task.executionEnvelope.agentProfile,
              }
            : null,
        }))
      : [],
    repositoryRouting: plan.repositoryRouting || {
      authoritative: false,
      confidence: "low",
      reason: "",
      writableSafe: false,
      taskScope: "",
      primaryTarget: null,
      candidateCount: 0,
      nestedRepositoryCount: 0,
    },
    executionEnvelope: compactExecutionEnvelope(plan.executionEnvelope),
    budget: {
      maxAgents: Number(plan.budget?.maxAgents || 0),
      maxSidecars: Number(plan.budget?.maxSidecars || 0),
      writableLaneCap: Number(plan.budget?.writableLaneCap || 0),
      defaultTimeoutMs: Number(plan.budget?.defaultTimeoutMs || DEFAULT_TIMEOUT_MS),
      tokenStrategy: plan.budget?.tokenStrategy || "provider_affine_lowest_cost_reliable_model",
    },
    joinPolicy: plan.joinPolicy || "none",
    providerPolicy: plan.providerPolicy || {
      affinity: "caller_provider",
      writableFallback: "read_only_same_provider_then_single_worker",
      crossProviderMixing: false,
    },
    modelPolicy: {
      defaultProfile: plan.modelPolicy?.defaultProfile || "openai_cheap_extraction",
      escalationProfile: plan.modelPolicy?.escalationProfile || "openai_heavy_reasoning",
      rule: plan.modelPolicy?.rule || "keep sidecars provider-affine and use the lowest-cost model/profile that can reliably complete each bounded lane",
    },
    authPolicy: {
      humanDrivenMode: plan.authPolicy?.humanDrivenMode || "oauth",
      backgroundAuthMode: plan.authPolicy?.backgroundAuthMode || "provider_human_oauth_only",
      allowedRunner: plan.authPolicy?.allowedRunner || "caller_provider",
      writableRollout: plan.authPolicy?.writableRollout || "human_repo_work_only",
      secretMaterial: plan.authPolicy?.secretMaterial || "blocked",
      rule: plan.authPolicy?.rule || "background sidecars must not authenticate, refresh tokens, or read secret material",
    },
    promotion: {
      policyVersion: plan.promotion?.policyVersion || "",
      activeStage: plan.promotion?.activeStage || "writable_sidecars_v1",
      activeVersion: plan.promotion?.activeVersion || plan.version || PLAN_VERSION,
      nextStage: plan.promotion?.nextStage || null,
      source: plan.promotion?.source || "state",
      autoPromote: Boolean(plan.promotion?.autoPromote),
      criteria: plan.promotion?.criteria || null,
    },
    capabilities: plan.capabilities || {
      readOnlySidecars: true,
      safeVerificationExecution: false,
      boundedImplementationSlices: false,
      writableGitWorktrees: true,
    },
    health: plan.health || {
      status: "healthy",
      activeQuarantines: [],
      openRepairActions: [],
    },
    execution: {
      enabledByDefault: plan.execution?.enabledByDefault != null
        ? Boolean(plan.execution.enabledByDefault)
        : true,
      disableEnv: plan.execution?.disableEnv || "MYOS_BACKGROUND_AGENTS_ENABLED=0",
      defaultRunner: plan.execution?.defaultRunner || "caller_provider_sidecars",
      autoPromotionDisableEnv: plan.execution?.autoPromotionDisableEnv || "MYOS_PARALLELIZATION_AUTO_PROMOTE=0",
      versionOverrideEnv: plan.execution?.versionOverrideEnv || "MYOS_PARALLELIZATION_VERSION=writable_sidecars_v1|v2|v3|v4",
      orchestrationKillSwitch: plan.execution?.orchestrationKillSwitch || "MYOS_ORCHESTRATION_GOLD_ENABLED=0",
    },
  };
}

module.exports = {
  PLAN_VERSION,
  backgroundAgentsDisabled,
  buildLaneSpecs,
  buildParallelizationPlan,
  compactParallelizationPlan,
  detectBlockedReasons,
  isTaskKindQuarantined,
  resolveMaxAgents: resolveMaxSidecars,
  resolveMaxSidecars,
  resolveTaskTimeoutMs,
  splitClauses,
};

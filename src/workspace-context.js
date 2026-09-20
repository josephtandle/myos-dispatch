const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { readJsonCached } = require("./json-cache");
const { shortlistCapabilities, selectExecutionLane } = require("./capability-router");
const { inferGoalScale } = require("./goal-scale");
const { buildParallelizationPlan } = require("./parallelization-planner");
const { homeDir, resolveWorkspacePath, resolveWorkspaceRoot } = require("./myos-compat");
const {
  getDataSearchScope: getConfiguredDataSearchScope,
  getDataSource,
  getDataSourceCatalog,
  getDataLookupAllowlist,
  getPreferOverProjectSources,
  matchesWorkerFollowup,
  readConfiguredTextSource,
  selectDataSourceIds,
} = require("./data-source-registry");
const {
  decideTypedEvidenceShadowAuthority,
  getTypedEvidenceShadowStage,
} = require("./promotion/typed-evidence-shadow-policy");

const HOME = homeDir();
const WORKSPACE = resolveWorkspaceRoot();
const PROJECTS_INDEX = resolveWorkspacePath("projects/_index.json");
const FASTPATHS_FILE = resolveWorkspacePath("DISPATCH-FASTPATHS.json");

const DIRECTIVE_VERBS = /\b(make|create|generate|build|draft|render|produce|write|get|find|retrieve|look up|locate|open|extract|pull|send|forward|message|dm|notify|share|check|inspect|review|show|give me|list|tell me|give|download|add|update|save|mark|count)\b/;
const DIRECT_LOOKUP_HINTS = /\b(url|link|website|web page|page|download link|download url|homepage|payment link|promo code|dns|records|giveaway(?:s)?|office|address|location|size|sizes|dimensions|specs|email|rsvp|signed up|signups?|ein|tax id|entity info|business entity|company info)\b/;
const EXPLORATORY_HINTS = /\b(help me understand|explain|what's going on|what is going on|how does|why does|brainstorm|strategy|architect|investigate|improve|refactor|context|overview)\b/;
const FOLLOW_UP_HINTS = /\b(also|this|that|it|they|them|these|those|here|there|same|again|too|correct|yes|no|for this|for that|subdomain|rsvp)\b/;
const READ_HINTS = /\b(what|what is|what's|what are|where is|where's|which|who is|who's|how many|show|find|get|look up|count|list|tell me|give me|retrieve|check)\b/;
const WRITE_HINTS = /\b(add|update|save|mark|put|attach|send|forward|message|dm|notify|share|create|record|store|log|set|change|fix|repair|replace|redirect|deploy|commit|push|publish|implement|edit|upload|remove|delete|move|rename|prove|improve)\b/;
const PROJECT_OPERATION_HINTS = /\b(giveaway(?:s)? page|mentorship page|promo code|promo link|payment link|onboarding|calendar|invite|rsvp|signups?|cohort|participant|participants?)\b/;
const STATUS_HINTS = /\b(are you awake|are you there|your status|what's your status|what is your status)\b/;
const WHATSAPP_OPERATION_HINTS = /\b(whatsapp link|whatsapp group|social media team on whatsapp|team destination|telegram workflows?|whatsapp\/telegram workflows?)\b/;
const GENERIC_RESEARCH_HINTS = /\b(research a product|research a competitor|research a tool|research .* if it(?:'s| is) useful|tell me if it(?:'s| is) useful)\b/;
const ROUTING_COMPLAINT_RE = /\b(bad routing error|routing is messed up|routing.*wrong|wrong route|not reading the whole context|not asking for a link|fix (?:this )?in the routing|fix your routing|log your mistake)\b/;
const GENERIC_PROJECT_TERMS = new Set([
  "alumni",
  "book",
  "household",
  "logistics",
  "made",
  "networking",
  "podcasts",
  "speaking",
  "workshops",
]);

function readOptional(filePath, maxChars = 8000) {
  try {
    return fs.readFileSync(filePath, "utf8").slice(0, maxChars).trim();
  } catch {
    return "";
  }
}

function normalizeProjectEntries(projectsValue) {
  return Object.entries(projectsValue || {}).map(([slug, value]) => ({ slug, ...value }));
}

function normalizeLooseText(value) {
  return normalizeText(value)
    .replace(/'/g, "")
    .replace(/\b([a-z]{4,})s\b/g, "$1");
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasBoundedPhrase(text, phrase) {
  const normalizedPhrase = normalizeText(phrase).trim();
  if (!normalizedPhrase) return false;
  const escaped = escapeRegex(normalizedPhrase).replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${escaped}\\b`, "i").test(normalizeText(text));
}

function hasLooseBoundedPhrase(text, phrase) {
  const normalizedPhrase = normalizeLooseText(phrase).trim();
  if (!normalizedPhrase) return false;
  const escaped = escapeRegex(normalizedPhrase).replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${escaped}\\b`, "i").test(normalizeLooseText(text));
}

function hasMultipleWords(value) {
  return normalizeText(value).trim().split(/\s+/).filter(Boolean).length > 1;
}

function isGenericProjectTerm(value) {
  const normalized = normalizeLooseText(value).trim();
  return Boolean(normalized) && !/\s/.test(normalized) && GENERIC_PROJECT_TERMS.has(normalized);
}

function scoreMatchedProjectField({ needle, kind, project }) {
  if (isGenericProjectTerm(needle)) return 0;
  if (kind === "slug") return needle === normalizeText(project.slug) ? 8 : 6;
  if (kind === "name") return hasMultipleWords(needle) ? 12 : 6;
  if (kind === "alias") return hasMultipleWords(needle) ? 12 : 6;
  if (kind === "path") return hasMultipleWords(needle.replace(/[/-]+/g, " ")) ? 8 : 6;
  return 6;
}

function scoreProject(query, project) {
  const haystack = normalizeText(query);
  let score = 0;
  const fields = [
    { value: project.slug, kind: "slug" },
    { value: project.name, kind: "name" },
    { value: project.path, kind: "path" },
    ...(project.aliases || []).map((value) => ({ value, kind: "alias" })),
  ].filter(Boolean);

  for (const { value, kind } of fields) {
    const needle = normalizeText(value).trim();
    if (!needle) continue;
    if (needle.length < 4 && !/\s/.test(needle)) continue;
    if (hasBoundedPhrase(haystack, needle) || hasLooseBoundedPhrase(haystack, needle)) {
      score += scoreMatchedProjectField({ needle, kind, project });
    }
  }

  return score;
}

function matchProjects(query, projects, maxMatches = 3) {
  return [...(projects || [])]
    .map((project) => ({ project, score: scoreProject(query, project) }))
    .filter((entry) => entry.score >= 6)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxMatches)
    .map((entry) => entry.project);
}

function extractSearchTerms(query, maxTerms = 4) {
  const stopWords = new Set([
    "the", "and", "for", "with", "that", "this", "from", "into", "under", "over",
    "your", "you", "them", "they", "what", "where", "when", "then", "than", "have",
    "will", "would", "should", "could", "there", "their", "about", "inside", "create",
    "build", "make", "page", "file", "folder", "give", "return", "browser", "design",
    "super", "simple", "web", "upload", "call", "live", "url", "path", "see",
  ]);

  return [...new Set(
    String(query || "")
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9-]{2,}/g) || []
  )]
    .filter((term) => !stopWords.has(term))
    .slice(0, maxTerms);
}

function searchProjectFiles(query, maxHits = 6) {
  const terms = extractSearchTerms(query);
  if (terms.length === 0) return [];

  const pattern = terms
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

  try {
    const output = execFileSync(
      "rg",
      [
        "-i",
        "-n",
        "-m",
        "1",
        "--glob",
        "**/CONTEXT.md",
        "--glob",
        "**/README.md",
        "--glob",
        "**/PLAN.md",
        "--glob",
        "**/package.json",
        "--glob",
        "**/vercel.json",
        pattern,
        path.join(WORKSPACE, "projects"),
      ],
      { encoding: "utf8" }
    ).trim();

    return output
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^(.+?):(\d+):(.*)$/);
        if (!match) return null;
        const haystack = `${match[1]} ${match[3]}`.toLowerCase();
        return {
          filePath: match[1],
          lineNumber: match[2],
          snippet: match[3].trim(),
          score: terms.reduce((sum, term) => sum + (haystack.includes(term) ? term.length : 0), 0),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
      .slice(0, maxHits);
  } catch {
    return [];
  }
}

function loadFastpaths(filePath = FASTPATHS_FILE) {
  try {
    const parsed = readJsonCached(filePath);
    return Array.isArray(parsed.fastpaths) ? parsed.fastpaths : [];
  } catch {
    return [];
  }
}

function hasFastpathTerm(text, term) {
  const normalizedText = normalizeText(text);
  const normalizedTerm = normalizeText(term).trim();
  if (!normalizedTerm) return false;

  const escaped = normalizedTerm
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");

  return new RegExp(`\\b${escaped}\\b`, "i").test(normalizedText);
}

function scoreFastpath(query, fastpath) {
  const haystack = normalizeText(query);
  let score = 0;

  for (const term of fastpath.match_terms || []) {
    const needle = normalizeText(term).trim();
    if (!needle) continue;
    if (hasFastpathTerm(haystack, needle)) {
      score += Math.max(10, Math.min(needle.length, 24));
    }
  }

  return score;
}

function matchFastpaths(query, maxMatches = 3, filePath = FASTPATHS_FILE) {
  return loadFastpaths(filePath)
    .map((fastpath) => ({ fastpath, score: scoreFastpath(query, fastpath) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxMatches);
}

function firstFastpathPath(fastpath = {}) {
  return fastpath.project_path
    || fastpath.reference_path
    || fastpath.recipe_path
    || fastpath.handler_path
    || fastpath.data_path
    || fastpath.route_hint
    || "";
}

function inferFastpathTargetType(fastpath = {}) {
  if (typeof fastpath.target_type === "string" && fastpath.target_type.trim()) {
    return fastpath.target_type.trim();
  }
  if (fastpath.recipe_path) return "recipe";
  if (fastpath.project_path) return "project";
  if (fastpath.data_path) return "data";
  if (fastpath.capability_id || fastpath.capability_hint) return "capability";
  if (fastpath.tool_hint || fastpath.handler_path) return "tool";
  if (fastpath.reference_path) return "reference";
  if (fastpath.route_hint) return "route";
  return "unknown";
}

function inferFastpathTargetId(fastpath = {}) {
  return fastpath.target_id
    || fastpath.capability_id
    || fastpath.recipe_path
    || fastpath.project_path
    || fastpath.data_path
    || fastpath.tool_hint
    || fastpath.handler_path
    || fastpath.reference_path
    || fastpath.route_hint
    || fastpath.intent
    || "";
}

function normalizeFastpathEvidence(match) {
  const fastpath = match?.fastpath || {};
  const score = Number(match?.score || 0);
  return {
    intent: fastpath.intent || "matched route",
    score,
    confidence: score >= 24 ? "high" : score >= 12 ? "medium" : "low",
    targetType: inferFastpathTargetType(fastpath),
    targetId: inferFastpathTargetId(fastpath),
    path: firstFastpathPath(fastpath),
    stopRule: fastpath.stop_rule || "",
  };
}

function loadProjectIndex() {
  try {
    const parsed = readJsonCached(PROJECTS_INDEX);
    return normalizeProjectEntries(parsed.projects);
  } catch {
    return [];
  }
}

function toWorkspacePath(relativePath, scanDir) {
  if (!relativePath || typeof relativePath !== "string") return "";
  if (path.isAbsolute(relativePath)) return relativePath;
  if (relativePath.startsWith("~")) return relativePath.replace(/^~(?=\/)/, HOME);
  return scanDir ? path.resolve(scanDir, relativePath) : path.join(WORKSPACE, relativePath);
}

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function inferIntentType(query) {
  const text = normalizeText(query);
  const isDirective =
    DIRECTIVE_VERBS.test(text) ||
    DIRECT_LOOKUP_HINTS.test(text) ||
    /\b(what is|what's|what are|where is|where's|where are|which is|which one's|who is|who's|how many)\b/.test(text);
  const isExploratory = EXPLORATORY_HINTS.test(text);

  if (isDirective && !isExploratory) return "directive";
  if (isExploratory && !isDirective) return "exploratory";
  if (isDirective) return "directive";
  return "exploratory";
}

function inferActionType(query) {
  const text = normalizeText(query);
  const hasWrite = WRITE_HINTS.test(text);
  const hasRead = READ_HINTS.test(text) || DIRECT_LOOKUP_HINTS.test(text);

  if (hasWrite && !hasRead) return "write";
  if (hasRead && !hasWrite) return "read";
  if (hasWrite) return "write";
  if (hasRead) return "read";
  return "unknown";
}

function getProjectRoot(project) {
  if (!project || !project.path) return "";
  return project.path.startsWith("~")
    ? project.path.replace(/^~(?=\/)/, HOME)
    : path.join(WORKSPACE, "projects", project.path);
}

function getProjectScopedPath(project) {
  return getProjectRoot(project);
}

function listProjectRecipes(project) {
  const projectRoot = getProjectRoot(project);
  if (!projectRoot) return [];
  const recipesRoot = path.join(projectRoot, "recipes");
  if (!fs.existsSync(recipesRoot)) return [];

  const stack = [recipesRoot];
  const recipes = [];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".recipe.json")) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        recipes.push({
          id: manifest.id || "",
          title: manifest.title || manifest.id || entry.name,
          actions: Array.isArray(manifest.actions) ? manifest.actions : [],
          path: fullPath,
        });
      } catch {
        // Ignore malformed project recipe manifests in context rendering.
      }
    }
  }

  return recipes.sort((a, b) => a.title.localeCompare(b.title));
}

function isShortFollowUp(query) {
  const text = normalizeText(query).trim();
  if (!text) return false;
  const words = text.split(/\s+/).filter(Boolean);
  return words.length <= 16 && FOLLOW_UP_HINTS.test(text);
}

function buildFollowUpProjectMatch(lastDispatchHint, projects) {
  if (!lastDispatchHint?.projectSlug) return [];
  const matched = (projects || []).find((project) => project.slug === lastDispatchHint.projectSlug);
  return matched ? [matched] : [];
}

function hasStrongProjectEvidence(query, project) {
  return scoreProject(query, project) >= 8;
}

function isDataDirective(intentType, dataSources) {
  return intentType === "directive" && Array.isArray(dataSources) && dataSources.length > 0;
}

function evaluateDataLookupCanary({ actionType, dataSources = [], dataSourceOptions = {} }) {
  if (!Array.isArray(dataSources) || dataSources.length === 0) {
    return {
      eligible: false,
      enabled: false,
      reason: "no_data_sources",
      mode: "read_only_allowlist_v1",
      allowedSources: [],
      blockedSources: [],
    };
  }

  const allowlist = getDataLookupAllowlist(dataSourceOptions);
  const allowedSources = dataSources.filter((source) => allowlist.has(source));
  const blockedSources = dataSources.filter((source) => !allowlist.has(source));

  if (actionType !== "read") {
    return {
      eligible: false,
      enabled: false,
      reason: "non_read_action",
      mode: "read_only_allowlist_v1",
      allowedSources,
      blockedSources,
    };
  }

  if (blockedSources.length > 0) {
    return {
      eligible: false,
      enabled: false,
      reason: "source_not_allowlisted",
      mode: "read_only_allowlist_v1",
      allowedSources,
      blockedSources,
    };
  }

  return {
    eligible: true,
    enabled: true,
    reason: "allowlisted_read_only",
    mode: "read_only_allowlist_v1",
    allowedSources,
    blockedSources: [],
  };
}

function shouldUseWorkerForDataDirective(query, dataSources = [], dataSourceOptions = {}) {
  if (!Array.isArray(dataSources) || dataSources.length === 0) return false;
  return matchesWorkerFollowup(query, dataSources, dataSourceOptions);
}

function buildDataLookupRouting({ query, actionType, dataSources = [], dataSourceOptions = {} }) {
  const dataLookupCanary = evaluateDataLookupCanary({ actionType, dataSources, dataSourceOptions });
  if (dataLookupCanary.enabled && shouldUseWorkerForDataDirective(query, dataSources, dataSourceOptions)) {
    return {
      lane: "worker_skill",
      reason: "data_lookup_canary_participant_issue_requires_worker",
      dataLookupCanary: {
        ...dataLookupCanary,
        eligible: false,
        enabled: false,
        reason: "participant_issue_requires_worker",
      },
    };
  }

  return {
    lane: dataLookupCanary.enabled ? "data_lookup" : "worker_skill",
    reason: dataLookupCanary.enabled
      ? "deterministic_data_lookup"
      : `data_lookup_canary_${dataLookupCanary.reason}`,
    dataLookupCanary,
  };
}

function getDataSearchScope(dataSources = [], dataSourceOptions = {}) {
  return getConfiguredDataSearchScope(dataSources, dataSourceOptions);
}

/**
 * Config-driven data-source selection. The taxonomy (which query patterns map
 * to which source ids) now lives entirely in the data-sources config via
 * per-source `matchTerms`/`excludeTerms`. With an empty config nothing is
 * selected and routing is unaffected.
 */
function selectDataSources(query, dataSourceOptions = {}) {
  return selectDataSourceIds(query, dataSourceOptions);
}

function chooseSourceOwner({ query, actionType, projectMatches, dataSources, route, intentType, dataSourceOptions = {} }) {
  const text = normalizeText(query);
  const primaryProject = projectMatches[0] || null;
  const hasProject = Boolean(primaryProject);
  const hasData = dataSources.length > 0;
  const primaryCapability = route?.candidates?.[0] || null;
  const preferOverProject = getPreferOverProjectSources(dataSourceOptions);
  const hasPreferredDataSource = dataSources.some((source) => preferOverProject.has(source));

  if (STATUS_HINTS.test(text)) {
    return "fallback";
  }

  // A data source can declare `preferOverProject` in config so directive
  // lookups route to the data lane before any project alias match.
  if (hasPreferredDataSource && intentType === "directive") {
    return "data";
  }

  if (hasProject) {
    if (WHATSAPP_OPERATION_HINTS.test(text) && primaryProject.slug === "whatsapp") return "project";
    if (actionType === "write" && dataSources.includes("websites")) return "project";
    if (PROJECT_OPERATION_HINTS.test(text)) return "project";
    if (dataSources.includes("websites")) return "project";
  }

  if (!hasProject && hasData && isDataDirective(intentType, dataSources)) {
    return "data";
  }

  const dataOwnedSources = dataSources.filter((source) =>
    !["websites"].includes(source) && !preferOverProject.has(source)
  );
  if (dataOwnedSources.length > 0 && dataOwnedSources.every((source) => source === "entities") && intentType !== "exploratory") {
    return "data";
  }
  if (dataOwnedSources.length > 0 && intentType === "directive") {
    return "data";
  }

  if (hasProject) {
    return "project";
  }

  if (hasData && intentType === "directive") return "data";
  if (primaryCapability?.score >= 18 && primaryCapability.evidenceScore >= 10) return "capability";
  return "fallback";
}

function collectDispatchSignals(query, options = {}) {
  const startedAt = Date.now();
  const dataSourceOptions = options.dataSourceOptions || {};
  const fastpathMatches = matchFastpaths(query, 3);
  const projects = loadProjectIndex();
  let projectMatches = matchProjects(query, projects);
  const route = selectExecutionLane(query, options);
  const intentType = inferIntentType(query);
  const actionType = inferActionType(query);
  const isFollowUp = isShortFollowUp(query);
  const dataSources = selectDataSources(query, dataSourceOptions);
  const isRoutingComplaint = ROUTING_COMPLAINT_RE.test(normalizeText(query));

  if (isRoutingComplaint) {
    projectMatches = [];
  } else if (projectMatches.length === 0 && isFollowUp) {
    projectMatches = buildFollowUpProjectMatch(options.lastDispatchHint, projects);
  }

  if (!isRoutingComplaint && projectMatches.length > 0 && GENERIC_RESEARCH_HINTS.test(normalizeText(query))) {
    projectMatches = projectMatches.filter((project) => hasStrongProjectEvidence(query, project));
  }

  return {
    query,
    parallelizationStateFile: options.parallelizationStateFile || "",
    env: options.env || process.env,
    dataSourceOptions,
    intentType,
    actionType,
    isFollowUp,
    isRoutingComplaint,
    fastpathMatches,
    fastpathEvidence: fastpathMatches.map(normalizeFastpathEvidence),
    projects,
    projectMatches,
    dataSources,
    route,
    timingMs: {
      total: Date.now() - startedAt,
    },
  };
}

function inferShadowExecutionLane(signals, owner) {
  const primaryFastpath = signals.fastpathEvidence[0] || null;
  if (owner === "data") {
    return buildDataLookupRouting({
      query: signals.query,
      actionType: signals.actionType,
      dataSources: signals.dataSources,
      dataSourceOptions: signals.dataSourceOptions,
    }).lane;
  }
  if (primaryFastpath?.targetType === "recipe") return "recipe_dispatcher";
  if (primaryFastpath?.targetType === "tool") return "tool";
  if (primaryFastpath?.targetType === "data") return "data_lookup";
  if (primaryFastpath?.targetType === "reference") return "reference_lookup";
  return signals.route?.lane || "worker_skill";
}

function buildTypedEvidenceDispatchPlan(signals) {
  const primaryProject = signals.projectMatches[0] || null;
  const owner = chooseSourceOwner({
    query: signals.query,
    actionType: signals.actionType,
    projectMatches: signals.projectMatches,
    dataSources: signals.dataSources,
    route: signals.route,
    intentType: signals.intentType,
    dataSourceOptions: signals.dataSourceOptions,
  });
  const topCandidate = signals.route?.candidates?.[0] || null;
  const topCapability = topCandidate?.capability || null;
  const candidateScanDir = topCandidate?.scan_dir || topCapability?.scan_dir || null;
  const dataRouting = owner === "data"
    ? buildDataLookupRouting({
        query: signals.query,
        actionType: signals.actionType,
        dataSources: signals.dataSources,
        dataSourceOptions: signals.dataSourceOptions,
      })
    : null;
  const executionLane = dataRouting?.lane || inferShadowExecutionLane(signals, owner);
  const dataLookupCanary = dataRouting?.dataLookupCanary || null;
  const projectSlug = owner === "project" && primaryProject
    ? primaryProject.slug
    : primaryProject?.slug || null;
  const searchScope = owner === "project" && primaryProject
    ? getProjectScopedPath(primaryProject)
    : owner === "data"
      ? getDataSearchScope(signals.dataSources, signals.dataSourceOptions)
      : topCapability?.source_path
        ? toWorkspacePath(topCapability.source_path, candidateScanDir)
        : signals.fastpathEvidence[0]?.path
          ? toWorkspacePath(signals.fastpathEvidence[0].path)
          : "";

  const plan = {
    authoritative: false,
    branch: owner === "data" ? "data" : owner === "project" ? "project" : owner === "capability" ? "capability" : "fallback",
    ownerContext: {
      type: owner,
      projectSlug,
      dataSources: signals.dataSources,
      contextNeeded: owner === "project" && signals.intentType !== "directive",
    },
    executionLane,
    intentType: signals.intentType,
    actionType: signals.actionType,
    projectSlug,
    projectRecipeFirst: owner === "project" && signals.intentType === "directive",
    stopAfterMatch: executionLane === "recipe_dispatcher" || executionLane === "workflow" || executionLane === "data_lookup",
    allowBroadSearch: false,
    serviceAgents: owner === "project" && primaryProject && Array.isArray(primaryProject.agents)
      ? primaryProject.agents
      : [],
    searchScope,
    fastpathMatches: signals.fastpathMatches,
    projectMatches: signals.projectMatches,
    dataSources: signals.dataSources,
    dataLookupCanary,
    route: {
      lane: executionLane,
      reason: dataRouting?.reason || signals.route?.reason || (dataLookupCanary?.enabled ? "typed_evidence_data_lookup" : "typed_evidence_shadow"),
      candidates: (signals.route?.candidates || []).slice(0, 3).map((candidate) => ({
        id: candidate.capability?.id,
        lane: candidate.capability?.execution_lane,
        score: candidate.score,
        evidenceScore: candidate.evidenceScore,
      })),
    },
    evidence: {
      fastpaths: signals.fastpathEvidence,
      projects: signals.projectMatches.map((project) => ({
        slug: project.slug,
        name: project.name,
      })),
      capabilities: (signals.route?.candidates || []).slice(0, 3).map((candidate) => ({
        id: candidate.capability?.id,
        lane: candidate.capability?.execution_lane,
        score: candidate.score,
        evidenceScore: candidate.evidenceScore,
      })),
      dataSources: signals.dataSources,
    },
    timingMs: signals.timingMs,
  };

  return finalizeDispatchPlan(signals.query, plan, signals);
}

function finalizeDispatchPlan(query, plan, signals) {
  const parallelizationPlan = buildParallelizationPlan(query, plan, signals);
  const planWithParallelization = {
    ...plan,
    parallelizationPlan,
  };

  const finalPlan = {
    ...planWithParallelization,
    ...inferGoalScale(query, planWithParallelization),
  };

  const env = signals?.env || process.env;
  const envOverride = String(env?.MYOS_PARALLELIZATION_AGGRESSION || "").trim().toLowerCase();
  const hasExplicitOverride = envOverride === "balanced" || envOverride === "deep";

  if (
    (finalPlan.goalScale === 1 || finalPlan.goalScale === 2) &&
    !hasExplicitOverride &&
    finalPlan.parallelizationPlan
  ) {
    finalPlan.parallelizationPlan = {
      ...finalPlan.parallelizationPlan,
      mode: "none",
      reason: "no_safe_parallel_work_needed",
      aggression: "off",
      depth: 0,
      backgroundTasks: [],
      requiredTaskCount: 0,
      joinPolicy: "none",
      budget: {
        ...finalPlan.parallelizationPlan.budget,
        maxAgents: 0,
      },
      clampReason: "trivial_goal_scale",
    };
  }

  return finalPlan;
}

function compareDispatchPlans(legacyPlan, shadowPlan) {
  const differences = [];
  const legacyLane = legacyPlan?.route?.lane || null;
  const shadowLane = shadowPlan?.executionLane || shadowPlan?.route?.lane || null;
  const checks = [
    ["branch", legacyPlan?.branch, shadowPlan?.branch],
    ["projectSlug", legacyPlan?.projectSlug || null, shadowPlan?.projectSlug || null],
    ["executionLane", legacyLane, shadowLane],
    ["goalScale", legacyPlan?.goalScale || null, shadowPlan?.goalScale || null],
  ];

  for (const [field, legacyValue, shadowValue] of checks) {
    if (legacyValue !== shadowValue) {
      differences.push({ field, legacy: legacyValue, shadow: shadowValue });
    }
  }

  return {
    same: differences.length === 0,
    differences,
    legacy: {
      branch: legacyPlan?.branch || null,
      projectSlug: legacyPlan?.projectSlug || null,
      executionLane: legacyLane,
      goalScale: legacyPlan?.goalScale || null,
      goalMode: legacyPlan?.goalMode || null,
    },
    shadow: {
      branch: shadowPlan?.branch || null,
      projectSlug: shadowPlan?.projectSlug || null,
      executionLane: shadowLane,
      goalScale: shadowPlan?.goalScale || null,
      goalMode: shadowPlan?.goalMode || null,
    },
  };
}

function attachShadowDispatch(query, legacyPlan, signals, options = {}) {
  const shadowPlan = buildTypedEvidenceDispatchPlan(signals);
  const comparison = compareDispatchPlans(legacyPlan, shadowPlan);
  const stage = getTypedEvidenceShadowStage({
    ...(options.typedEvidenceShadowPolicy || {}),
    env: options.env || process.env,
  });
  const authorityDecision = decideTypedEvidenceShadowAuthority({
    query,
    legacyPlan,
    shadowPlan,
    comparison,
    stage,
    options: options.typedEvidenceShadowPolicy || {},
  });
  const selectedPlan = authorityDecision.useShadow
    ? {
        ...shadowPlan,
        authoritative: true,
        selectedBy: "typed_evidence_shadow",
        route: {
          ...(shadowPlan.route || {}),
          reason: shadowPlan.route?.reason || "typed_evidence_shadow_authoritative",
        },
      }
    : legacyPlan;

  return {
    ...selectedPlan,
    shadowDispatch: {
      version: stage.planVersion || "typed-evidence-shadow-v1",
      policyVersion: stage.policyVersion,
      activeStage: stage.id,
      authoritative: authorityDecision.useShadow,
      authorityDecision,
      plan: shadowPlan,
      comparison,
      promotion: stage.state || null,
      timingMs: {
        legacyIncluded: true,
        evidenceCollection: signals.timingMs.total,
      },
    },
  };
}

function resolveDispatchPlan(query, options = {}) {
  const signals = collectDispatchSignals(query, options);
  const {
    fastpathMatches,
    projectMatches,
    route,
    intentType,
    actionType,
    dataSources,
    isFollowUp,
    dataSourceOptions,
  } = signals;
  const finalizePlan = (plan) => finalizeDispatchPlan(query, plan, signals);

  const primaryFastpath = fastpathMatches[0]?.fastpath || null;
  if (primaryFastpath) {
    return attachShadowDispatch(query, finalizePlan({
      branch: "fastpath",
      intentType,
      actionType,
      stopAfterMatch: true,
      allowBroadSearch: false,
      projectSlug: null,
      projectRecipeFirst: intentType === "directive",
      serviceAgents: [],
      searchScope:
        toWorkspacePath(primaryFastpath.project_path)
        || toWorkspacePath(primaryFastpath.reference_path)
        || toWorkspacePath(primaryFastpath.recipe_path)
        || toWorkspacePath(primaryFastpath.handler_path),
      fastpathMatches,
      projectMatches,
      route,
    }), signals, options);
  }

  const primaryProject = projectMatches[0] || null;
  const owner = chooseSourceOwner({
    query,
    actionType,
    projectMatches,
    dataSources,
    route,
    intentType,
    dataSourceOptions,
  });

  if (owner === "project" && primaryProject) {
    return attachShadowDispatch(query, finalizePlan({
      branch: "project",
      intentType,
      actionType,
      stopAfterMatch: true,
      allowBroadSearch: false,
      projectSlug: primaryProject.slug,
      projectRecipeFirst: intentType === "directive",
      serviceAgents: Array.isArray(primaryProject.agents) ? primaryProject.agents : [],
      searchScope: getProjectScopedPath(primaryProject),
      fastpathMatches,
      projectMatches,
      route,
      dataSources,
      usedLastDispatchHint: isFollowUp && projectMatches.length > 0 && scoreProject(query, primaryProject) < 6,
    }), signals, options);
  }

  if (owner === "data" && isDataDirective(intentType, dataSources)) {
    const dataRouting = buildDataLookupRouting({ query, actionType, dataSources, dataSourceOptions });
    return attachShadowDispatch(query, finalizePlan({
      branch: "data",
      intentType,
      actionType,
      stopAfterMatch: true,
      allowBroadSearch: false,
      projectSlug: null,
      projectRecipeFirst: false,
      serviceAgents: [],
      searchScope: getDataSearchScope(dataSources, dataSourceOptions),
      fastpathMatches,
      projectMatches: [],
      route: {
        lane: dataRouting.lane,
        reason: dataRouting.reason,
        candidates: [],
      },
      dataSources,
      dataLookupCanary: dataRouting.dataLookupCanary,
      usedLastDispatchHint: false,
    }), signals, options);
  }

  const topCandidate = route?.candidates?.[0] || null;
  const topCapability = topCandidate?.capability || null;
  const candidateScanDir = topCandidate?.scan_dir || topCapability?.scan_dir || null;
  const hasScopedCapability = topCapability && typeof topCapability.source_path === "string";
  return attachShadowDispatch(query, finalizePlan({
    branch: hasScopedCapability ? "capability" : "fallback",
    intentType,
    actionType,
    stopAfterMatch: route?.lane === "recipe_dispatcher" || route?.lane === "workflow",
    allowBroadSearch: false,
    projectSlug: primaryProject?.slug || null,
    projectRecipeFirst: false,
    serviceAgents: [],
    searchScope: hasScopedCapability ? toWorkspacePath(topCapability.source_path, candidateScanDir) : "",
    // The matched capability id, carried so the route can be OBSERVED. The evolver
    // counts repeated routes to propose fast paths, but the hook log recorded only
    // the lane ("worker_skill"), which is not something a fast path can be proposed
    // for, and an input hash, which only matches byte-identical prompts. The id was
    // known here and thrown away, so the learning loop had no usable signal at all.
    capabilityId: hasScopedCapability ? (topCapability.id || null) : null,
    fastpathMatches,
    projectMatches,
    route,
    dataSources,
    usedLastDispatchHint: false,
  }), signals, options);
}

function buildDispatchPlanSection(plan) {
  if (!plan) return "";
  const shadow = plan.shadowDispatch?.comparison || null;
  return [
    "### Dispatch Plan",
    `Branch: ${plan.branch}`,
    `Intent type: ${plan.intentType}`,
    `Action type: ${plan.actionType}`,
    `Goal scale: ${plan.goalScale} (${plan.goalMode})`,
    `Goal confidence: ${plan.goalConfidence}`,
    plan.goalReasons?.length ? `Goal reasons: ${plan.goalReasons.join(", ")}` : "",
    plan.parallelizationPlan
      ? `Parallelization: ${plan.parallelizationPlan.version || "unknown"} ${plan.parallelizationPlan.mode} (${plan.parallelizationPlan.backgroundTasks?.length || 0} background tasks; critical path: ${plan.parallelizationPlan.criticalPath || "unknown"}; next: ${plan.parallelizationPlan.promotion?.nextStage || "none"})`
      : "",
    plan.parallelizationPlan?.blockedReasons?.length
      ? `Parallelization blocked by: ${plan.parallelizationPlan.blockedReasons.join(", ")}`
      : "",
    `Requires plan: ${plan.requiresPlan ? "yes" : "no"}`,
    `Requires approval: ${plan.requiresApproval ? "yes" : "no"}`,
    plan.blockedBy?.length ? `Blocked by: ${plan.blockedBy.join(", ")}` : "",
    plan.stopRules?.length ? `Stop rules: ${plan.stopRules.join(", ")}` : "",
    `Stop after match: ${plan.stopAfterMatch ? "yes" : "no"}`,
    `Allow broad search: ${plan.allowBroadSearch ? "yes" : "no"}`,
    plan.projectSlug ? `Project slug: ${plan.projectSlug}` : "",
    `Project recipe first: ${plan.projectRecipeFirst ? "yes" : "no"}`,
    plan.serviceAgents?.length ? `Project service agents: ${plan.serviceAgents.join(", ")}` : "",
    plan.dataSources?.length ? `Data sources: ${plan.dataSources.map((source) => `\`${source}\``).join(", ")}` : "",
    plan.searchScope ? `Scoped search root: ${plan.searchScope}` : "",
    plan.usedLastDispatchHint ? "Follow-up branch hint: yes" : "",
    process.env.MYOS_DISPATCH_SHOW_SHADOW === "1" && shadow
      ? `Shadow typed-evidence: ${shadow.same ? "same" : "different"} (${shadow.shadow.branch}/${shadow.shadow.executionLane})`
      : "",
    plan.shadowDispatch?.authoritative
      ? `Typed-evidence authority: ${plan.shadowDispatch.activeStage} (${plan.shadowDispatch.authorityDecision?.reason || "selected"})`
      : "",
  ].filter(Boolean).join("\n");
}

function formatDispatchShadowComparison(query, options = {}) {
  const plan = resolveDispatchPlan(query, options);
  const comparison = plan.shadowDispatch?.comparison;
  if (!comparison) return "";

  const differences = comparison.differences.length > 0
    ? comparison.differences.map((diff) =>
        `- ${diff.field}: legacy=${JSON.stringify(diff.legacy)} shadow=${JSON.stringify(diff.shadow)}`
      )
    : ["- none"];

  return [
    `Prompt: ${query}`,
    `Same: ${comparison.same ? "yes" : "no"}`,
    `Legacy: branch=${comparison.legacy.branch} project=${comparison.legacy.projectSlug || "none"} lane=${comparison.legacy.executionLane || "none"} goal=${comparison.legacy.goalScale}`,
    `Shadow: branch=${comparison.shadow.branch} project=${comparison.shadow.projectSlug || "none"} lane=${comparison.shadow.executionLane || "none"} goal=${comparison.shadow.goalScale}`,
    "Differences:",
    ...differences,
  ].join("\n");
}

function buildFastpathSections(query, fastpathMatches = matchFastpaths(query)) {
  return fastpathMatches.map(({ fastpath, score }) =>
    [
      `### Dispatch Fast Path: ${fastpath.intent || "matched route"}`,
      `Score: ${score}`,
      fastpath.stop_rule ? `Stop rule: ${fastpath.stop_rule}` : "",
      Array.isArray(fastpath.lookup_order) && fastpath.lookup_order.length > 0
        ? `Lookup order: ${fastpath.lookup_order.join(" -> ")}`
        : "",
      fastpath.project_path ? `Project path: ${fastpath.project_path}` : "",
      fastpath.reference_path ? `Reference path: ${fastpath.reference_path}` : "",
      fastpath.recipe_path ? `Recipe path: ${fastpath.recipe_path}` : "",
      fastpath.handler_path ? `Handler path: ${fastpath.handler_path}` : "",
      fastpath.capability_id ? `Capability id: ${fastpath.capability_id}` : "",
      fastpath.capability_hint ? `Capability hint: ${fastpath.capability_hint}` : "",
      fastpath.tool_hint ? `Tool hint: ${fastpath.tool_hint}` : "",
      fastpath.agent_hint ? `Agent hint: ${fastpath.agent_hint}` : "",
      fastpath.authoritative_section ? `Authoritative section: ${fastpath.authoritative_section}` : "",
    ].filter(Boolean).join("\n")
  );
}

function buildProjectSections(query, options = {}) {
  const matched = options.projectMatches || matchProjects(query, loadProjectIndex());
  const sections = matched.map((project) => {
    const projectPath = getProjectRoot(project);
    const contextPath = path.join(projectPath, "CONTEXT.md");
    const context = options.includeContext === false ? "" : readOptional(contextPath, 6000);
    return [
      `### Project Match: ${project.name} (${project.slug})`,
      `Path: ${projectPath}`,
      project.description ? `Description: ${project.description}` : "",
      context ? `CONTEXT.md:\n${context}` : "",
    ].filter(Boolean).join("\n");
  });

  const shouldSearchFallback = options.allowBroadSearch !== false && matched.length === 0;
  const searchHits = shouldSearchFallback ? searchProjectFiles(query) : [];
  const seenFiles = new Set();
  for (const hit of searchHits) {
    if (!hit || seenFiles.has(hit.filePath)) continue;
    seenFiles.add(hit.filePath);
    sections.push([
      "### Project Search Hit",
      `Path: ${hit.filePath}`,
      `Matched line ${hit.lineNumber}: ${hit.snippet}`,
    ].join("\n"));
  }

  return sections;
}

function buildProjectRecipeSections(projectMatches = []) {
  const sections = [];
  for (const project of projectMatches) {
    const recipes = listProjectRecipes(project);
    if (recipes.length === 0) continue;
    sections.push([
      `### Project Recipes: ${project.name} (${project.slug})`,
      ...recipes.slice(0, 8).map((recipe) =>
        `- ${recipe.id || recipe.title}${recipe.actions.length > 0 ? ` [${recipe.actions.join(", ")}]` : ""}`
      ),
    ].join("\n"));
  }
  return sections;
}

function buildProjectServiceAgentSections(projectMatches = []) {
  const sections = [];
  for (const project of projectMatches) {
    const agents = Array.isArray(project.agents) ? project.agents : [];
    if (agents.length === 0) continue;
    sections.push([
      `### Project Service Agents: ${project.name} (${project.slug})`,
      ...agents.map((agentId) => `- ${agentId}`),
    ].join("\n"));
  }
  return sections;
}

function querySqliteJson(dbPath, sql) {
  const output = execFileSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return output ? JSON.parse(output) : [];
}

/**
 * Generic sqlite renderer. Any sqlite-mode data source may declare its own
 * read-only `sqlite.query` in config; the result rows are rendered as a plain
 * text table. No schema or query is hardcoded per source.
 */
function buildSqliteSections(source) {
  const dbPath = source?.path || "";
  const sql = source?.sqlite?.query;
  if (!dbPath || !sql) return [];
  try {
    const rows = querySqliteJson(dbPath, sql);
    if (rows.length === 0) {
      return [`### Data Match: ${source.label}\nNo matching rows yet.`];
    }
    const columns = Object.keys(rows[0]);
    const table = [
      columns.join(" | "),
      ...rows.map((row) => columns.map((column) => String(row[column] ?? "")).join(" | ")),
    ].join("\n");
    return [`### Data Match: ${source.label}\n\`\`\`text\n${table}\n\`\`\``];
  } catch (error) {
    return [`### Data Match: ${source.label}\nQuery failed: ${error.message}`];
  }
}

function loadWebsiteRows(source) {
  const dbPath = source?.path || "";
  if (!dbPath) return [];
  try {
    const output = execFileSync(
      "sqlite3",
      ["-json", dbPath, "select domain, name, hosting, base_url, entity, notes from websites;"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    return output ? JSON.parse(output) : [];
  } catch {
    return [];
  }
}

function scoreWebsiteRow(query, row, projectMatches = []) {
  const text = normalizeText(query);
  let score = 0;
  const fields = [row.domain, row.name, row.base_url, row.hosting, row.entity, row.notes].filter(Boolean);

  for (const field of fields) {
    const needle = normalizeText(field).trim();
    if (!needle) continue;
    if (hasBoundedPhrase(text, needle) || hasLooseBoundedPhrase(text, needle)) {
      score += 8;
    } else {
      for (const term of extractSearchTerms(query, 8)) {
        if (needle.includes(term)) score += Math.min(5, term.length);
      }
    }
  }

  for (const project of projectMatches) {
    for (const field of [project.slug, project.name, ...(project.aliases || [])]) {
      const needle = normalizeText(field).trim();
      if (!needle) continue;
      const websiteHaystack = normalizeText([
        row.domain, row.name, row.base_url, row.hosting, row.entity, row.notes,
      ].filter(Boolean).join(" "));
      if (hasBoundedPhrase(text, needle) && websiteHaystack.includes(normalizeLooseText(needle))) {
        score += 12;
      }
    }
  }

  return score;
}

function buildWebsiteSections(query, projectMatches = [], source = getDataSource("websites")) {
  const rows = loadWebsiteRows(source)
    .map((row) => ({ row, score: scoreWebsiteRow(query, row, projectMatches) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.row.domain.localeCompare(b.row.domain))
    .slice(0, 3);

  return rows.map(({ row, score }) =>
    [
      `### Data Match: ${source.label}`,
      `Score: ${score}`,
      `Domain: ${row.domain}`,
      row.name ? `Name: ${row.name}` : "",
      row.base_url ? `Base URL: ${row.base_url}` : "",
      row.hosting ? `Hosting: ${row.hosting}` : "",
      row.entity ? `Entity: ${row.entity}` : "",
      row.notes ? `Notes: ${row.notes}` : "",
    ].filter(Boolean).join("\n")
  );
}

function buildDataSections(query, options = {}) {
  const dataSourceOptions = options.dataSourceOptions || {};
  const sources = options.dataSources || selectDataSources(query, dataSourceOptions);
  const catalog = getDataSourceCatalog(dataSourceOptions);
  const sections = [];

  for (const sourceId of sources) {
    const source = catalog[sourceId];
    if (!source) continue;

    // "websites" keeps a dedicated relevance-scored renderer (generic schema).
    if (sourceId === "websites") {
      sections.push(...buildWebsiteSections(query, options.projectMatches || [], source));
      continue;
    }

    if (source.mode === "sqlite") {
      sections.push(...buildSqliteSections(source));
      continue;
    }

    const text = readConfiguredTextSource(
      sourceId,
      source.maxChars || (source.mode === "pointer" ? 2500 : 3000),
      dataSourceOptions,
    );
    if (text) {
      const heading = source.mode === "pointer" ? "Data Pointer" : "Data Match";
      sections.push(`### ${heading}: ${source.label}\n${text}`);
    }
  }

  return sections;
}

function buildCapabilitySections(query) {
  try {
    const route = selectExecutionLane(query);
    const laneSummary = [
      "### Capability Route",
      `Selected lane: ${route.lane}`,
      `Reason: ${route.reason}`,
    ];

    const candidates = route.candidates.slice(0, 3).map((candidate) => {
      const capability = candidate.capability;
      return `- ${capability.id} (${capability.type}) — score ${candidate.score}`;
    });

    const workerCandidates = route.lane === "worker_skill"
      ? []
      : shortlistCapabilities(query, "worker_skill", 2).map((candidate) =>
          `- ${candidate.capability.id} (${candidate.capability.type}) — score ${candidate.score}`
        );

    const sections = [laneSummary.join("\n")];
    if (candidates.length > 0) {
      sections.push(["### Capability Shortlist", ...candidates].join("\n"));
    }
    if (workerCandidates.length > 0) {
      sections.push(["### Worker / Skill Alternates", ...workerCandidates].join("\n"));
    }
    return sections;
  } catch {
    return [];
  }
}

function buildCapabilitySectionsFromRoute(route, query) {
  try {
    const laneSummary = [
      "### Capability Route",
      `Selected lane: ${route.lane}`,
      `Reason: ${route.reason}`,
    ];

    const candidates = route.candidates.slice(0, 3).map((candidate) => {
      const capability = candidate.capability;
      return `- ${capability.id} (${capability.type}) — score ${candidate.score}`;
    });

    const workerCandidates = route.lane === "worker_skill"
      ? []
      : shortlistCapabilities(query, "worker_skill", 2).map((candidate) =>
          `- ${candidate.capability.id} (${candidate.capability.type}) — score ${candidate.score}`
        );

    const sections = [laneSummary.join("\n")];
    if (candidates.length > 0) {
      sections.push(["### Capability Shortlist", ...candidates].join("\n"));
    }
    if (workerCandidates.length > 0) {
      sections.push(["### Worker / Skill Alternates", ...workerCandidates].join("\n"));
    }
    return sections;
  } catch {
    return [];
  }
}

function buildWorkspaceContextBundle(query) {
  const plan = resolveDispatchPlan(query);
  const fastpathSections = buildFastpathSections(query, plan.fastpathMatches);
  const projectRecipeSections = plan.projectRecipeFirst
    ? buildProjectRecipeSections(plan.projectMatches)
    : [];
  const projectServiceSections = plan.projectRecipeFirst
    ? buildProjectServiceAgentSections(plan.projectMatches)
    : [];
  const sections = [
    buildDispatchPlanSection(plan),
    ...fastpathSections,
    ...projectRecipeSections,
    ...projectServiceSections,
    ...(plan.branch === "project" || plan.branch === "data" ? [] : buildCapabilitySectionsFromRoute(plan.route, query)),
    ...buildProjectSections(query, {
      allowBroadSearch: plan.allowBroadSearch,
      projectMatches: plan.projectMatches,
      includeContext: !plan.projectRecipeFirst,
    }),
    ...buildDataSections(query, { projectMatches: plan.projectMatches, dataSources: plan.dataSources }),
  ].filter(Boolean);

  if (sections.length === 0) return "";

  return [
    "## Live Workspace Lookup",
    "The following workspace/project/data context was fetched locally for this specific request. Use it as current ground truth.",
    sections.join("\n\n"),
  ].join("\n\n");
}

module.exports = {
  buildCapabilitySectionsFromRoute,
  buildDispatchPlanSection,
  finalizeDispatchPlan,
  buildProjectRecipeSections,
  buildProjectServiceAgentSections,
  buildTypedEvidenceDispatchPlan,
  collectDispatchSignals,
  compareDispatchPlans,
  formatDispatchShadowComparison,
  resolveDispatchPlan,
  buildWorkspaceContextBundle,
  buildFastpathSections,
  inferFastpathTargetType,
  inferIntentType,
  inferActionType,
  inferGoalScale,
  listProjectRecipes,
  loadFastpaths,
  matchFastpaths,
  matchProjects,
  normalizeProjectEntries,
  scoreFastpath,
  getDataSearchScope,
  buildDataSections,
  evaluateDataLookupCanary,
  selectDataSources,
};

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { invalidateJsonCache } = require("./json-cache");
const { resolveWorkspacePath, resolveWorkspaceRoot } = require("./myos-compat");

const WORKSPACE_ROOT = resolveWorkspaceRoot();
const DEFAULT_FASTPATHS_FILE = resolveWorkspacePath("DISPATCH-FASTPATHS.json");
const DEFAULT_SNAPSHOT_DIR = resolveWorkspacePath("agents", "shared", "data", "fastpath-snapshots");

const PATH_FIELDS = Object.freeze([
  "recipe_path",
  "handler_path",
  "project_path",
  "reference_path",
  "data_path",
  "route_hint",
]);
const AUTHORITATIVE_ROUTE_FIELDS = Object.freeze(["capability_id", ...PATH_FIELDS]);
const TARGET_TYPES = new Set([
  "recipe",
  "project",
  "data",
  "capability",
  "tool",
  "reference",
  "route",
  "policy",
]);
const WRITE_DISABLE_ENV_KEYS = Object.freeze([
  "MYOS_DISPATCH_FASTPATH_WRITES_ENABLED",
  "MYOS_FASTPATH_WRITES_ENABLED",
  "MYOS_FASTPATH_AUTO_LEARNING_ENABLED",
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(value = "") {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function slug(value) {
  return String(value || "fastpath")
    .replace(/[^a-z0-9_.-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "fastpath";
}

function workspacePath(relPath, workspaceRoot = WORKSPACE_ROOT) {
  if (!relPath || typeof relPath !== "string") return "";
  return path.isAbsolute(relPath) ? relPath : path.join(workspaceRoot, relPath);
}

function existsInWorkspace(relPath, workspaceRoot = WORKSPACE_ROOT) {
  if (!relPath || typeof relPath !== "string") return false;
  if (/^[a-z]+:/i.test(relPath)) return true;
  return fs.existsSync(workspacePath(relPath, workspaceRoot));
}

function isRequireResolvable(filePath) {
  try {
    require.resolve(filePath);
    return true;
  } catch {
    return false;
  }
}

function collectCapabilityIds(index = {}) {
  const ids = new Set();
  const capabilities = Array.isArray(index.capabilities) ? index.capabilities : [];
  for (const capability of capabilities) {
    if (capability && typeof capability.id === "string") ids.add(capability.id);
  }
  return ids;
}

function resolveSnapshotDir(file, options = {}) {
  if (options.snapshotDir) return options.snapshotDir;
  return path.resolve(file) === path.resolve(DEFAULT_FASTPATHS_FILE)
    ? DEFAULT_SNAPSHOT_DIR
    : path.join(path.dirname(file), ".fastpath-snapshots");
}

function listFromEnv(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getFastpathWriteBlockers(options = {}) {
  const env = options.env || process.env;
  const candidate = options.candidate || {};
  const source = options.source || "unknown";
  const blockers = [];

  for (const key of WRITE_DISABLE_ENV_KEYS) {
    if (env[key] === "0") blockers.push(`${key.toLowerCase()}_disabled`);
  }

  const disabledSources = listFromEnv(env.MYOS_DISPATCH_FASTPATH_DISABLED_SOURCES);
  if (disabledSources.includes(source)) blockers.push(`source_disabled:${source}`);

  const candidateKeys = [
    candidate.capability_id,
    candidate.target_id,
    candidate.recipe_path,
    candidate.data_path,
    candidate.intent,
  ].filter(Boolean).map(String);
  const disabledRecipes = listFromEnv(env.MYOS_DISPATCH_FASTPATH_DISABLED_RECIPES);
  for (const key of candidateKeys) {
    if (disabledRecipes.includes(key)) blockers.push(`recipe_disabled:${key}`);
  }

  return [...new Set(blockers)];
}

function validateRecipeRoute(entry, label, options = {}) {
  const errors = [];
  const warnings = [];
  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
  if (!entry.recipe_path) return { errors, warnings };

  const recipePath = workspacePath(entry.recipe_path, workspaceRoot);
  let manifest = null;
  try {
    manifest = readJson(recipePath);
  } catch {
    errors.push(`${label}: recipe manifest is not readable JSON (${entry.recipe_path})`);
    return { errors, warnings };
  }

  if (!manifest.id || typeof manifest.id !== "string") {
    errors.push(`${label}: recipe manifest is missing string id (${entry.recipe_path})`);
  }
  if (!["core", "agent", "project"].includes(manifest.layer)) {
    errors.push(`${label}: recipe manifest has invalid layer (${entry.recipe_path})`);
  }
  if (!manifest.owner || typeof manifest.owner !== "string") {
    errors.push(`${label}: recipe manifest is missing owner (${entry.recipe_path})`);
  }
  if (!manifest.inputMode || typeof manifest.inputMode !== "string") {
    errors.push(`${label}: recipe manifest is missing inputMode (${entry.recipe_path})`);
  }
  if (!manifest.outputMode || typeof manifest.outputMode !== "string") {
    errors.push(`${label}: recipe manifest is missing outputMode (${entry.recipe_path})`);
  }

  const manifestHandler = typeof manifest.handler === "string"
    ? path.resolve(path.dirname(recipePath), manifest.handler)
    : "";
  const declaredHandler = entry.handler_path ? workspacePath(entry.handler_path, workspaceRoot) : "";
  const handlerPath = declaredHandler || manifestHandler;
  if (handlerPath) {
    if (!fs.existsSync(handlerPath)) {
      errors.push(`${label}: recipe handler does not exist (${path.relative(workspaceRoot, handlerPath)})`);
    } else if (!isRequireResolvable(handlerPath)) {
      errors.push(`${label}: recipe handler is not loadable (${path.relative(workspaceRoot, handlerPath)})`);
    }
  } else if (typeof manifest.command === "string" && manifest.command.trim()) {
    warnings.push(`${label}: recipe manifest uses command instead of handler; dispatcher registry does not load command recipes yet`);
  } else {
    errors.push(`${label}: recipe manifest must declare handler or command (${entry.recipe_path})`);
  }

  return { errors, warnings };
}

function validateDataRoute(entry, label, options = {}) {
  const errors = [];
  const warnings = [];
  if (!entry.data_path) return { errors, warnings };

  const lookupOrder = Array.isArray(entry.lookup_order) ? entry.lookup_order : [];
  if (options.requireDeterministicDataLookup) {
    if (entry.target_type !== "data") errors.push(`${label}: data fastpath candidate must set target_type=data`);
    if (lookupOrder.length === 0) errors.push(`${label}: data fastpath candidate must declare lookup_order`);
    if (lookupOrder[0] && lookupOrder[0] !== entry.data_path) {
      errors.push(`${label}: lookup_order must start with data_path for deterministic data lookup`);
    }
  } else if (lookupOrder.length === 0) {
    warnings.push(`${label}: data_path has no lookup_order; deterministic lookup evidence is weak`);
  }

  return { errors, warnings };
}

function auditFastpathsDoc(fastpathsDoc, options = {}) {
  const errors = [];
  const warnings = [];
  const fastpaths = fastpathsDoc?.fastpaths;
  const policy = fastpathsDoc?.policy || {};
  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
  const capabilityIds = options.capabilityIds || new Set();

  if (!Array.isArray(fastpaths)) {
    errors.push("fastpaths must be an array");
    return { ok: false, errors, warnings, counts: {} };
  }

  const maxActive = Number(policy.max_active_fastpaths || 30);
  const stableSlots = Number(policy.stable_slots || 20);
  const probationSlots = Number(policy.probation_slots || 10);
  const promotionThreshold = Number(policy.promotion_threshold_count || 3);
  const seenIntents = new Set();
  let activeCount = 0;
  let stableCount = 0;
  let probationCount = 0;
  let retiredCount = 0;

  for (const [idx, entry] of fastpaths.entries()) {
    const label = entry && entry.intent ? entry.intent : `entry[${idx}]`;
    if (!entry || typeof entry !== "object") {
      errors.push(`${label}: entry must be an object`);
      continue;
    }

    if (!entry.intent || typeof entry.intent !== "string") {
      errors.push(`${label}: intent is required`);
    } else if (seenIntents.has(entry.intent)) {
      errors.push(`${label}: duplicate intent`);
    } else {
      seenIntents.add(entry.intent);
    }

    if (!Array.isArray(entry.match_terms) || entry.match_terms.length === 0) {
      errors.push(`${label}: match_terms must be a non-empty array`);
    } else if (entry.match_terms.some((term) => typeof term !== "string" || !term.trim())) {
      errors.push(`${label}: match_terms must contain only non-empty strings`);
    }

    const status = entry.status || "stable";
    if (!["stable", "probation", "retired"].includes(status)) {
      errors.push(`${label}: status must be stable, probation, or retired`);
    }
    if (status === "retired") retiredCount += 1;
    else activeCount += 1;
    if (status === "stable") stableCount += 1;
    if (status === "probation") probationCount += 1;

    if (!entry.added_at) warnings.push(`${label}: added_at missing`);
    if (status !== "retired" && !entry.last_seen_at) warnings.push(`${label}: last_seen_at missing`);

    if (entry.capability_id && capabilityIds.size > 0 && !capabilityIds.has(entry.capability_id)) {
      errors.push(`${label}: capability_id not found in capabilities-index.json (${entry.capability_id})`);
    }
    if (entry.verify_capability_id && capabilityIds.size > 0 && !capabilityIds.has(entry.verify_capability_id)) {
      errors.push(`${label}: verify_capability_id not found in capabilities-index.json (${entry.verify_capability_id})`);
    }
    if (entry.target_type && !TARGET_TYPES.has(entry.target_type)) {
      errors.push(`${label}: target_type must be one of ${[...TARGET_TYPES].join(", ")}`);
    }
    if (entry.target_id != null && typeof entry.target_id !== "string") {
      errors.push(`${label}: target_id must be a string when present`);
    }
    if (!AUTHORITATIVE_ROUTE_FIELDS.some((field) => Boolean(entry[field]))) {
      errors.push(`${label}: must declare at least one authoritative route field`);
    }

    if (status !== "retired") {
      for (const field of PATH_FIELDS) {
        if (!entry[field]) continue;
        if (!existsInWorkspace(entry[field], workspaceRoot)) {
          errors.push(`${label}: ${field} does not exist (${entry[field]})`);
        }
      }

      const recipeValidation = validateRecipeRoute(entry, label, options);
      errors.push(...recipeValidation.errors);
      warnings.push(...recipeValidation.warnings);
      const dataValidation = validateDataRoute(entry, label, options);
      errors.push(...dataValidation.errors);
      warnings.push(...dataValidation.warnings);
    }

    if (status === "probation") {
      if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
        errors.push(`${label}: probation entries require evidence`);
      }
      if (Number(entry.hit_count_7d || 0) < promotionThreshold) {
        warnings.push(`${label}: probation hit_count_7d is below promotion threshold (${promotionThreshold}); keep in probation`);
      }
    }
  }

  if (activeCount > maxActive) errors.push(`active fastpaths exceed cap: ${activeCount}/${maxActive}`);
  if (stableCount > stableSlots) errors.push(`stable fastpaths exceed cap: ${stableCount}/${stableSlots}`);
  if (probationCount > probationSlots) errors.push(`probation fastpaths exceed cap: ${probationCount}/${probationSlots}`);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    counts: { activeCount, stableCount, probationCount, retiredCount, maxActive },
  };
}

function writeFastpathsWithSnapshot(file, nextDoc, options = {}) {
  const env = options.env || process.env;
  const blockers = getFastpathWriteBlockers({ ...options, env });
  if (blockers.length > 0) {
    const error = new Error(`Fastpath write blocked: ${blockers.join(",")}`);
    error.code = "FASTPATH_WRITE_BLOCKED";
    error.blockers = blockers;
    throw error;
  }

  const audit = options.audit === false
    ? { ok: true, errors: [], warnings: [], counts: {} }
    : auditFastpathsDoc(nextDoc, options);
  if (!audit.ok) {
    const error = new Error(`Fastpath audit failed: ${audit.errors.join("; ")}`);
    error.code = "FASTPATH_AUDIT_FAILED";
    error.audit = audit;
    throw error;
  }

  const previousText = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const nextText = `${JSON.stringify(nextDoc, null, 2)}\n`;
  const previousChecksum = sha256(previousText);
  const nextChecksum = sha256(nextText);
  const now = options.now || new Date().toISOString();
  const snapshotDir = resolveSnapshotDir(file, options);
  fs.mkdirSync(snapshotDir, { recursive: true });
  const snapshotPath = path.join(snapshotDir, `${now.replace(/[:.]/g, "-")}-${slug(options.source)}.json`);
  const snapshot = {
    createdAt: now,
    source: options.source || "unknown",
    target: file,
    previousChecksum,
    nextChecksum,
    reason: options.reason || "",
    rollback: {
      restoreFromSnapshot: snapshotPath,
      target: file,
    },
    previousText,
  };
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, nextText, "utf8");
  fs.renameSync(tmp, file);
  invalidateJsonCache(tmp);
  invalidateJsonCache(file);

  return {
    snapshotPath,
    previousChecksum,
    nextChecksum,
    audit,
  };
}

module.exports = {
  DEFAULT_FASTPATHS_FILE,
  DEFAULT_SNAPSHOT_DIR,
  auditFastpathsDoc,
  collectCapabilityIds,
  getFastpathWriteBlockers,
  readJson,
  sha256,
  writeFastpathsWithSnapshot,
};

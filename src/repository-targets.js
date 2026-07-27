"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { resolveWorkspaceRoot } = require("./myos-compat");

const MAX_NESTED_DEPTH = 4;
const MAX_NESTED_REPOS = 12;

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function isGitRoot(candidate) {
  return Boolean(candidate) && fs.existsSync(path.join(candidate, ".git"));
}

function findNearestGitRoot(startPath) {
  let current = path.resolve(startPath || process.cwd());
  while (true) {
    if (isGitRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function findNestedGitRoots(rootPath, options = {}) {
  const root = path.resolve(rootPath || process.cwd());
  const maxDepth = Number(options.maxDepth || MAX_NESTED_DEPTH);
  const maxRepos = Number(options.maxRepos || MAX_NESTED_REPOS);
  const found = [];
  const stack = [{ dir: root, depth: 0 }];

  while (stack.length && found.length < maxRepos) {
    const { dir, depth } = stack.pop();
    if (depth > 0 && isGitRoot(dir)) {
      found.push(dir);
      continue;
    }
    if (depth >= maxDepth) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return found.sort();
}

function loadProjectRepositoryTargets(projectSlug, options = {}) {
  if (!projectSlug) return [];
  const workspaceRoot = options.workspaceRoot || resolveWorkspaceRoot();
  const indexPath = options.projectIndexPath || path.join(workspaceRoot, "projects", "_index.json");
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch {
    return [];
  }
  const project = index.projects?.[projectSlug];
  if (!project || !Array.isArray(project.repositories)) return [];
  return project.repositories.map((entry) => {
    const absolutePath = path.resolve(workspaceRoot, String(entry.path || ""));
    return {
      id: String(entry.id || path.basename(absolutePath)),
      path: absolutePath,
      aliases: [...new Set([
        entry.id,
        entry.name,
        path.basename(absolutePath),
        ...(Array.isArray(entry.aliases) ? entry.aliases : []),
      ].filter(Boolean).map(String))],
      gitRoot: isGitRoot(absolutePath) ? absolutePath : null,
    };
  });
}

function scoreTarget(text, target) {
  const haystack = normalizeText(text);
  let score = 0;
  for (const alias of target.aliases || []) {
    const needle = normalizeText(alias);
    if (!needle) continue;
    if (haystack === needle) score = Math.max(score, 100);
    else if (haystack.includes(needle)) score = Math.max(score, 60 + Math.min(20, needle.length));
  }
  return score;
}

function resolveRepositoryTarget(input, plan = {}, options = {}) {
  const text = normalizeText(input);
  const explicitScope = plan.searchScope || options.cwd || "";
  if (!explicitScope) {
    return {
      authoritative: false,
      confidence: "low",
      reason: "no_repository_scope",
      primaryTarget: null,
      taskScope: "",
      writableSafe: false,
      candidates: [],
    };
  }
  const scope = path.resolve(explicitScope);
  const configured = loadProjectRepositoryTargets(plan.projectSlug, options)
    .filter((target) => target.gitRoot);
  const ranked = configured
    .map((target) => ({ ...target, score: scoreTarget(text, target) }))
    .filter((target) => target.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  if (ranked.length && (!ranked[1] || ranked[0].score > ranked[1].score)) {
    return {
      authoritative: true,
      confidence: ranked[0].score >= 75 ? "high" : "medium",
      reason: "configured_repository_alias",
      primaryTarget: ranked[0],
      taskScope: ranked[0].gitRoot,
      writableSafe: true,
      candidates: ranked,
    };
  }

  if (isGitRoot(scope)) {
    return {
      authoritative: true,
      confidence: "high",
      reason: "search_scope_is_git_root",
      primaryTarget: { id: path.basename(scope), path: scope, gitRoot: scope, aliases: [] },
      taskScope: scope,
      writableSafe: true,
      candidates: [],
    };
  }

  const nestedRoots = findNestedGitRoots(scope, options);
  if (nestedRoots.length === 1) {
    const only = nestedRoots[0];
    const name = path.basename(only);
    if (text.includes(normalizeText(name))) {
      return {
        authoritative: true,
        confidence: "medium",
        reason: "single_nested_repository_named",
        primaryTarget: { id: name, path: only, gitRoot: only, aliases: [name] },
        taskScope: only,
        writableSafe: true,
        candidates: [],
      };
    }
  }
  if (nestedRoots.length > 0 || configured.length > 1) {
    return {
      authoritative: false,
      confidence: "low",
      reason: "ambiguous_repository_target",
      primaryTarget: null,
      taskScope: scope,
      writableSafe: false,
      candidates: configured,
      nestedGitRoots: nestedRoots,
    };
  }

  const nearest = findNearestGitRoot(scope);
  return {
    authoritative: Boolean(nearest),
    confidence: nearest ? "medium" : "low",
    reason: nearest ? "scope_belongs_to_single_repository" : "no_git_repository",
    primaryTarget: nearest
      ? { id: path.basename(nearest), path: nearest, gitRoot: nearest, aliases: [] }
      : null,
    taskScope: scope,
    writableSafe: Boolean(nearest),
    candidates: [],
  };
}

function compactRepositoryRouting(routing = {}) {
  return {
    authoritative: Boolean(routing.authoritative),
    confidence: routing.confidence || "low",
    reason: routing.reason || "",
    writableSafe: Boolean(routing.writableSafe),
    taskScope: routing.taskScope || "",
    primaryTarget: routing.primaryTarget
      ? {
          id: routing.primaryTarget.id,
          path: routing.primaryTarget.path,
          gitRoot: routing.primaryTarget.gitRoot,
        }
      : null,
    candidateCount: Array.isArray(routing.candidates) ? routing.candidates.length : 0,
    nestedRepositoryCount: Array.isArray(routing.nestedGitRoots) ? routing.nestedGitRoots.length : 0,
  };
}

module.exports = {
  compactRepositoryRouting,
  findNearestGitRoot,
  findNestedGitRoots,
  loadProjectRepositoryTargets,
  resolveRepositoryTarget,
};

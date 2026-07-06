"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { resolveHomePath, resolveWorkspacePath } = require("./myos-compat");

const DEFAULT_CONFIG_FILE = path.join(__dirname, "..", "config", "data-sources.example.json");
const LOCAL_CONFIG_FILE = path.join(__dirname, "..", "config", "data-sources.json");
const VALID_MODES = new Set(["content", "sqlite", "pointer"]);

function readConfigFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function loadDataSourcesConfig(options = {}) {
  if (options.config && typeof options.config === "object") return options.config;

  const candidates = [
    options.configPath,
    options.env?.MYOS_DATA_SOURCES_CONFIG || process.env.MYOS_DATA_SOURCES_CONFIG,
    LOCAL_CONFIG_FILE,
    DEFAULT_CONFIG_FILE,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const parsed = readConfigFile(candidate);
    if (parsed) return parsed;
  }

  return { version: 1, dataSources: [] };
}

function resolveConfiguredPath(entry = {}) {
  const rawPath = String(entry.path || "").trim();
  if (!rawPath) return "";
  if (rawPath === "<workspace>") return resolveWorkspacePath();
  if (rawPath.startsWith("<workspace>/")) {
    return resolveWorkspacePath(rawPath.slice("<workspace>/".length));
  }
  if (rawPath === "<myos-home>") return resolveHomePath();
  if (rawPath.startsWith("<myos-home>/")) {
    return resolveHomePath(rawPath.slice("<myos-home>/".length));
  }
  if (path.isAbsolute(rawPath)) return rawPath;

  const base = String(entry.base || "workspace").trim().toLowerCase();
  if (base === "myos-home" || base === "home-root") return resolveHomePath(rawPath);
  if (base === "cwd") return path.resolve(process.cwd(), rawPath);
  return resolveWorkspacePath(rawPath);
}

function normalizeTermList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((term) => String(term || "").trim().toLowerCase()).filter(Boolean);
}

function normalizeDataSourceEntry(entry = {}) {
  const id = String(entry.id || "").trim();
  if (!id) return null;

  const mode = VALID_MODES.has(entry.mode) ? entry.mode : "content";
  return {
    id,
    label: String(entry.label || id).trim(),
    mode,
    path: resolveConfiguredPath(entry),
    maxChars: Number.isFinite(Number(entry.maxChars)) ? Number(entry.maxChars) : undefined,
    sqlite: entry.sqlite && typeof entry.sqlite === "object" ? { ...entry.sqlite } : null,
    fastpath: entry.fastpath && typeof entry.fastpath === "object" ? { ...entry.fastpath } : null,
    matchTerms: normalizeTermList(entry.matchTerms),
    excludeTerms: normalizeTermList(entry.excludeTerms),
    workerFollowupTerms: normalizeTermList(entry.workerFollowupTerms),
    readOnly: entry.readOnly !== false,
    preferOverProject: entry.preferOverProject === true,
  };
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesTerm(text, term) {
  const needle = String(term || "").trim().toLowerCase();
  if (!needle) return false;
  const escaped = escapeRegex(needle).replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

function matchesAnyTerm(text, terms = []) {
  return terms.some((term) => matchesTerm(text, term));
}

/**
 * Config-driven data-source selection. A source is selected when the query
 * matches one of its configured `matchTerms` and none of its `excludeTerms`.
 * With an empty config nothing is selected, so routing is unaffected.
 */
function selectDataSourceIds(query, options = {}) {
  const text = String(query || "").toLowerCase();
  const selected = [];
  for (const source of getConfiguredDataSources(options)) {
    if (source.matchTerms.length === 0) continue;
    if (source.excludeTerms.length > 0 && matchesAnyTerm(text, source.excludeTerms)) continue;
    if (matchesAnyTerm(text, source.matchTerms)) selected.push(source.id);
  }
  return selected;
}

function getDataLookupAllowlist(options = {}) {
  return new Set(getConfiguredDataSources(options).filter((source) => source.readOnly).map((source) => source.id));
}

function getPreferOverProjectSources(options = {}) {
  return new Set(getConfiguredDataSources(options).filter((source) => source.preferOverProject).map((source) => source.id));
}

function matchesWorkerFollowup(query, sourceIds = [], options = {}) {
  const text = String(query || "").toLowerCase();
  const catalog = getDataSourceCatalog(options);
  return sourceIds.some((id) => {
    const source = catalog[id];
    return source && source.workerFollowupTerms.length > 0 && matchesAnyTerm(text, source.workerFollowupTerms);
  });
}

function getConfiguredDataSources(options = {}) {
  const config = loadDataSourcesConfig(options);
  const entries = Array.isArray(config.dataSources) ? config.dataSources : [];
  return entries
    .filter((entry) => entry && entry.enabled !== false)
    .map(normalizeDataSourceEntry)
    .filter(Boolean);
}

function getDataSourceCatalog(options = {}) {
  return Object.fromEntries(getConfiguredDataSources(options).map((entry) => [entry.id, entry]));
}

function getDataSource(sourceId, options = {}) {
  return getDataSourceCatalog(options)[sourceId] || null;
}

function getDataSearchScope(sourceIds = [], options = {}) {
  const catalog = getDataSourceCatalog(options);
  return sourceIds
    .map((source) => catalog[source]?.path)
    .filter(Boolean)
    .join(", ");
}

function readConfiguredTextSource(sourceId, maxChars = 8000, options = {}) {
  const source = getDataSource(sourceId, options);
  if (!source || !source.path || !["content", "pointer"].includes(source.mode)) return "";
  try {
    return fs.readFileSync(source.path, "utf8").slice(0, source.maxChars || maxChars).trim();
  } catch {
    return "";
  }
}

function getDataSourceFastpathTemplate(sourceId, options = {}) {
  const source = getDataSource(sourceId, options);
  if (!source?.fastpath) return null;
  return {
    intent: source.fastpath.intent || `${source.label} lookup`,
    match_terms: Array.isArray(source.fastpath.matchTerms) ? source.fastpath.matchTerms : [],
    target_id: source.id,
    data_path: source.path || "",
    lookup_order: Array.isArray(source.fastpath.lookupOrder)
      ? source.fastpath.lookupOrder
      : [source.path || source.label].filter(Boolean),
    stop_rule: source.fastpath.stopRule || `Use the configured ${source.label} source for matching lookups.`,
  };
}

module.exports = {
  DEFAULT_CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  getConfiguredDataSources,
  getDataLookupAllowlist,
  getDataSearchScope,
  getDataSource,
  getDataSourceCatalog,
  getDataSourceFastpathTemplate,
  getPreferOverProjectSources,
  loadDataSourcesConfig,
  matchesWorkerFollowup,
  readConfiguredTextSource,
  resolveConfiguredPath,
  selectDataSourceIds,
};

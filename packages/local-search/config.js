"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_LIMITS: DOCUMENT_LIMITS } = require("./documents");

const DEFAULTS = Object.freeze({
  maxResults: 8,
  maxBytes: 12_000,
  queryDeadlineMs: 5_000,
  maxContentScanBytes: 64 * 1024 ** 2,
  indexDeadlineMs: 60_000,
  pollIntervalMs: 30_000,
  quotaBytes: 20 * 1024 ** 3,
  reserveBytes: 20 * 1024 ** 3,
  reserveFraction: 0.1,
  inferenceWaitMs: 30_000,
  idleDwellMs: 5 * 60_000,
  healthyDwellMs: 2 * 60_000,
  sampleGapMs: 60_000,
  probeTimeoutMs: 1_000,
  probeOutputBytes: 64 * 1024,
  maintenanceMaxFiles: 10_000,
  writeAmplification: 4,
  embeddingDimensions: 1024,
  embeddingBytesPerDimension: 8,
  writeScratchBytes: 64 * 1024 ** 2,
  minimumAvailableBytes: 1024 ** 3,
  modelSizeMultiplier: 2,
  fixedMemoryOverheadBytes: 512 * 1024 ** 2,
  memoryProbeTimeoutMs: 1_000,
  memoryProbeOutputBytes: 64 * 1024,
});

function fail(message) {
  const error = new Error(message);
  error.code = "INVALID_CONFIG";
  throw error;
}

function rejectUnknown(input, allowed, label) {
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) fail(`${label} contains unknown field: ${unknown[0]}`);
}

function absolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value) fail(`${label} must be a normalized absolute path`);
  return value;
}

function containsSensitiveRoot(rootPath) {
  const normalized = rootPath.replaceAll("\\", "/").toLowerCase();
  const components = normalized.split("/").filter(Boolean);
  if (components.some((part) => part === ".ssh" || part === ".aws" || part === ".azure" || part === ".config/gcloud" || part === "keychains" || /^\.env(?:\.|$)/.test(part))) return true;
  return [
    "/library/cloudstorage", "/library/mobile documents", "/library/keychains",
    "/application support/google/chrome", "/application support/chromium",
    "/application support/microsoft edge", "/application support/firefox/profiles",
    "/library/safari", "/.config/gcloud", "/.myos/agent-chrome", "/dropbox", "/onedrive", "/google drive",
  ].some((fragment) => normalized === fragment || normalized.endsWith(fragment) || normalized.includes(`${fragment}/`));
}

function positive(value, fallback, label) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isFinite(candidate) || candidate <= 0) fail(`${label} must be finite and positive`);
  return candidate;
}

function positiveInteger(value, fallback, label) {
  const candidate = positive(value, fallback, label);
  if (!Number.isSafeInteger(candidate)) fail(`${label} must be a positive integer`);
  return candidate;
}

function normalizeRoot(root) {
  if (!root || typeof root !== "object" || Array.isArray(root)) fail("each root must be an object");
  rejectUnknown(root, new Set(["id", "path", "contentEnabled", "extensions", "maxFiles", "maxFileBytes", "admissionManifest", "admissionPolicySha256"]), "root");
  if (typeof root.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(root.id)) fail("root id is malformed");
  const extensions = root.extensions;
  if (!Array.isArray(extensions) || extensions.length === 0 || extensions.some((item) => typeof item !== "string" || !/^\.[a-z0-9]+$/i.test(item))) fail(`extensions for ${root.id} are malformed`);
  const rootPath = absolute(root.path, `root ${root.id} path`);
  const hasAdmissionManifest = root.admissionManifest != null;
  const hasAdmissionPolicy = root.admissionPolicySha256 != null;
  if (hasAdmissionManifest !== hasAdmissionPolicy) fail(`root ${root.id} admission manifest and policy hash must be configured together`);
  const admissionManifest = hasAdmissionManifest ? absolute(root.admissionManifest, `root ${root.id} admissionManifest`) : null;
  const admissionPolicySha256 = hasAdmissionPolicy && typeof root.admissionPolicySha256 === "string" && /^[a-f0-9]{64}$/i.test(root.admissionPolicySha256)
    ? root.admissionPolicySha256.toLowerCase() : hasAdmissionPolicy ? fail(`root ${root.id} admissionPolicySha256 is malformed`) : null;
  if (admissionManifest) {
    const rel = path.relative(rootPath, admissionManifest);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) fail(`root ${root.id} admissionManifest must be outside its root`);
  }
  if (rootPath === path.parse(rootPath).root) fail("filesystem root cannot be approved");
  if (rootPath === path.resolve(require("node:os").homedir())) fail("the whole home directory cannot be approved");
  if (containsSensitiveRoot(rootPath)) fail(`root ${root.id} is a sensitive or browser profile path`);
  return Object.freeze({
    id: root.id,
    path: rootPath,
    contentEnabled: root.contentEnabled === true,
    extensions: Object.freeze([...new Set(extensions.map((item) => item.toLowerCase()))]),
    maxFiles: positiveInteger(root.maxFiles, 10_000, `root ${root.id} maxFiles`),
    maxFileBytes: positiveInteger(root.maxFileBytes, 5 * 1024 ** 2, `root ${root.id} maxFileBytes`),
    admissionManifest,
    admissionPolicySha256,
  });
}

function normalizeQmd(qmd) {
  if (qmd == null) return null;
  if (!qmd || typeof qmd !== "object" || Array.isArray(qmd)) fail("qmd must be an object");
  rejectUnknown(qmd, new Set(["nodePath", "packageRoot", "modelPaths", "modelHashes", "timeoutMs", "outputBytes"]), "qmd");
  const models = qmd.modelPaths || {};
  rejectUnknown(models, new Set(["embed", "rerank", "generate"]), "qmd modelPaths");
  const normalizedModels = {};
  for (const name of ["embed", "rerank", "generate"]) {
    if (models[name] !== undefined) {
      const modelPath = absolute(models[name], `qmd model ${name}`);
      if (!modelPath.toLowerCase().endsWith(".gguf")) fail(`qmd model ${name} must be a local GGUF file`);
      normalizedModels[name] = modelPath;
    }
  }
  if (!normalizedModels.embed) fail("qmd modelPaths.embed is required");
  const hashes = qmd.modelHashes || {};
  rejectUnknown(hashes, new Set(["embed", "rerank", "generate"]), "qmd modelHashes");
  for (const [name, hash] of Object.entries(hashes)) {
    if (!Object.hasOwn(normalizedModels, name) || typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash)) fail(`qmd model hash ${name} is malformed`);
  }
  return Object.freeze({
    nodePath: absolute(qmd.nodePath, "qmd nodePath"),
    packageRoot: absolute(qmd.packageRoot, "qmd packageRoot"),
    modelPaths: Object.freeze(normalizedModels),
    modelHashes: Object.freeze({ ...hashes }),
    timeoutMs: positiveInteger(qmd.timeoutMs, 30_000, "qmd timeoutMs"),
    outputBytes: positiveInteger(qmd.outputBytes, 1024 ** 2, "qmd outputBytes"),
  });
}

function normalizeParser(parser) {
  if (parser == null) return null;
  if (!parser || typeof parser !== "object" || Array.isArray(parser)) fail("parser must be an object");
  const limitNames = Object.keys(DOCUMENT_LIMITS);
  rejectUnknown(parser, new Set(["pythonPath", ...limitNames]), "parser");
  const normalized = { pythonPath: absolute(parser.pythonPath, "parser pythonPath") };
  for (const name of limitNames) {
    if (parser[name] === undefined) continue;
    const value = positiveInteger(parser[name], null, `parser ${name}`);
    if (value > DOCUMENT_LIMITS[name]) fail(`parser ${name} cannot exceed the hard limit`);
    normalized[name] = value;
  }
  return Object.freeze(normalized);
}

function normalizeConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("configuration must be an object");
  rejectUnknown(input, new Set(["version", "enabled", "stateDirectory", "roots", "budgets", "qmd", "parser", "resourcePolicy"]), "configuration");
  if (input.version !== undefined && input.version !== 1) fail("configuration version must be 1");
  if (typeof input.enabled !== "boolean") fail("enabled must be a boolean");
  const roots = (input.roots || []).map(normalizeRoot);
  if (input.enabled && roots.length === 0) fail("enabled configuration requires at least one root");
  if (new Set(roots.map((root) => root.id)).size !== roots.length) fail("duplicate root id");
  const stateDirectory = absolute(input.stateDirectory, "stateDirectory");
  for (const root of roots) {
    const rel = path.relative(root.path, stateDirectory);
    const reverse = path.relative(stateDirectory, root.path);
    const stateInsideRoot = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    const rootInsideState = reverse === "" || (!reverse.startsWith("..") && !path.isAbsolute(reverse));
    if (stateInsideRoot || rootInsideState) fail("stateDirectory must not overlap approved roots");
    if (root.admissionManifest) for (const approved of roots) {
      const manifestRelative = path.relative(approved.path, root.admissionManifest);
      if (manifestRelative === "" || (!manifestRelative.startsWith("..") && !path.isAbsolute(manifestRelative))) {
        fail(`root ${root.id} admissionManifest must be outside every approved root`);
      }
    }
  }
  for (let index = 0; index < roots.length; index += 1) for (let other = index + 1; other < roots.length; other += 1) {
    const rel = path.relative(roots[index].path, roots[other].path);
    const reverse = path.relative(roots[other].path, roots[index].path);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)) || (!reverse.startsWith("..") && !path.isAbsolute(reverse))) fail("approved roots must not overlap");
  }
  const budgets = input.budgets || {};
  rejectUnknown(budgets, new Set(["maxResults", "maxBytes", "maxTokens", "queryDeadlineMs", "indexDeadlineMs", "maxContentScanBytes", "pollIntervalMs", "quotaBytes", "reserveBytes", "reserveFraction", "maintenanceMaxFiles", "maintenanceMaxSourceBytes", "writeAmplification", "embeddingDimensions", "embeddingBytesPerDimension", "writeScratchBytes"]), "budgets");
  const resourcePolicy = input.resourcePolicy || {};
  rejectUnknown(resourcePolicy, new Set(["inferenceWaitMs", "background", "memory"]), "resourcePolicy");
  const background = resourcePolicy.background || {};
  rejectUnknown(background, new Set(["idleDwellMs", "healthyDwellMs", "sampleGapMs", "probeTimeoutMs", "probeOutputBytes"]), "resourcePolicy background");
  const memory = resourcePolicy.memory || {};
  rejectUnknown(memory, new Set(["minimumAvailableBytes", "modelSizeMultiplier", "fixedOverheadBytes", "probeTimeoutMs", "probeOutputBytes"]), "resourcePolicy memory");
  return Object.freeze({
    version: 1,
    enabled: input.enabled === true,
    stateDirectory,
    roots: Object.freeze(roots),
    budgets: Object.freeze({
      maxResults: Math.min(8, positiveInteger(budgets.maxResults, DEFAULTS.maxResults, "maxResults")),
      maxBytes: positiveInteger(budgets.maxBytes, DEFAULTS.maxBytes, "maxBytes"),
      maxTokens: budgets.maxTokens == null ? null : positiveInteger(budgets.maxTokens, null, "maxTokens"),
      queryDeadlineMs: positiveInteger(budgets.queryDeadlineMs, DEFAULTS.queryDeadlineMs, "queryDeadlineMs"),
      maxContentScanBytes: positiveInteger(budgets.maxContentScanBytes, DEFAULTS.maxContentScanBytes, "maxContentScanBytes"),
      indexDeadlineMs: positiveInteger(budgets.indexDeadlineMs, DEFAULTS.indexDeadlineMs, "indexDeadlineMs"),
      pollIntervalMs: positiveInteger(budgets.pollIntervalMs, DEFAULTS.pollIntervalMs, "pollIntervalMs"),
      quotaBytes: positiveInteger(budgets.quotaBytes, DEFAULTS.quotaBytes, "quotaBytes"),
      reserveBytes: positiveInteger(budgets.reserveBytes, DEFAULTS.reserveBytes, "reserveBytes"),
      reserveFraction: (() => { const value = positive(budgets.reserveFraction, DEFAULTS.reserveFraction, "reserveFraction"); if (value > 1) fail("reserveFraction cannot exceed 1"); return value; })(),
      maintenanceMaxFiles: positiveInteger(budgets.maintenanceMaxFiles, DEFAULTS.maintenanceMaxFiles, "maintenanceMaxFiles"),
      maintenanceMaxSourceBytes: positiveInteger(budgets.maintenanceMaxSourceBytes, budgets.maxContentScanBytes ?? DEFAULTS.maxContentScanBytes, "maintenanceMaxSourceBytes"),
      writeAmplification: positive(budgets.writeAmplification, DEFAULTS.writeAmplification, "writeAmplification"),
      embeddingDimensions: positiveInteger(budgets.embeddingDimensions, DEFAULTS.embeddingDimensions, "embeddingDimensions"),
      embeddingBytesPerDimension: positiveInteger(budgets.embeddingBytesPerDimension, DEFAULTS.embeddingBytesPerDimension, "embeddingBytesPerDimension"),
      writeScratchBytes: positiveInteger(budgets.writeScratchBytes, DEFAULTS.writeScratchBytes, "writeScratchBytes"),
    }),
    resourcePolicy: Object.freeze({
      inferenceWaitMs: positiveInteger(resourcePolicy.inferenceWaitMs, DEFAULTS.inferenceWaitMs, "inferenceWaitMs"),
      background: Object.freeze({
        idleDwellMs: positiveInteger(background.idleDwellMs, DEFAULTS.idleDwellMs, "idleDwellMs"),
        healthyDwellMs: positiveInteger(background.healthyDwellMs, DEFAULTS.healthyDwellMs, "healthyDwellMs"),
        sampleGapMs: positiveInteger(background.sampleGapMs, DEFAULTS.sampleGapMs, "sampleGapMs"),
        probeTimeoutMs: positiveInteger(background.probeTimeoutMs, DEFAULTS.probeTimeoutMs, "probeTimeoutMs"),
        probeOutputBytes: positiveInteger(background.probeOutputBytes, DEFAULTS.probeOutputBytes, "probeOutputBytes"),
      }),
      memory: Object.freeze({
        minimumAvailableBytes: positiveInteger(memory.minimumAvailableBytes, DEFAULTS.minimumAvailableBytes, "minimumAvailableBytes"),
        modelSizeMultiplier: positive(memory.modelSizeMultiplier, DEFAULTS.modelSizeMultiplier, "modelSizeMultiplier"),
        fixedOverheadBytes: positiveInteger(memory.fixedOverheadBytes, DEFAULTS.fixedMemoryOverheadBytes, "fixedOverheadBytes"),
        probeTimeoutMs: positiveInteger(memory.probeTimeoutMs, DEFAULTS.memoryProbeTimeoutMs, "memory probeTimeoutMs"),
        probeOutputBytes: positiveInteger(memory.probeOutputBytes, DEFAULTS.memoryProbeOutputBytes, "memory probeOutputBytes"),
      }),
    }),
    qmd: normalizeQmd(input.qmd),
    parser: normalizeParser(input.parser),
  });
}

function assertOwnerOnly(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("config must be a regular non-symlink file");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("config must be owned by the current user");
  if ((stat.mode & 0o077) !== 0) fail("config permissions must be owner-only");
}

function loadConfig(configPath) {
  absolute(configPath, "config path");
  assertOwnerOnly(configPath);
  return normalizeConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
}

function writeConfig(configPath, input) {
  absolute(configPath, "config path");
  const config = normalizeConfig(input);
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, configPath);
  fs.chmodSync(configPath, 0o600);
  return config;
}

module.exports = { DEFAULTS, loadConfig, normalizeConfig, writeConfig };

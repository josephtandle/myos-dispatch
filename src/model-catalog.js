const fs = require("fs");
const path = require("path");

const WORKSPACE_ROOT = path.resolve(__dirname, "..");

const CATALOG_PATHS = {
  openai: path.join(WORKSPACE_ROOT, "data", "models", "openai-model-catalog.json"),
  openrouter: path.join(WORKSPACE_ROOT, "data", "models", "openrouter-model-catalog.json"),
  google: path.join(WORKSPACE_ROOT, "data", "models", "google-model-catalog.json"),
  anthropic: path.join(WORKSPACE_ROOT, "data", "models", "anthropic-model-catalog.json"),
};

function normalizeProvider(provider) {
  const raw = String(provider || "").trim().toLowerCase();
  if (!raw) return "openai";
  if (raw === "anthropic" || raw === "claude") return "anthropic";
  if (raw === "codex") return "openai";
  if (raw === "openai") return "openai";
  if (raw === "openrouter") return "openrouter";
  if (raw === "google" || raw === "gemini") return "google";
  throw new Error(`Unsupported provider: ${provider}`);
}

function loadCatalog(provider) {
  const normalized = normalizeProvider(provider);
  const target = CATALOG_PATHS[normalized];

  if (!target || !fs.existsSync(target)) {
    throw new Error(`Model catalog not found for provider: ${normalized}`);
  }

  const catalog = JSON.parse(fs.readFileSync(target, "utf8"));
  if (catalog.provider !== normalized) {
    throw new Error(`Catalog provider mismatch: expected ${normalized}, found ${catalog.provider}`);
  }

  return catalog;
}

function getProfile(catalog, profileId) {
  const profile = catalog.routing_profiles.find((entry) => entry.id === profileId);
  if (!profile) throw new Error(`Unknown routing profile: ${profileId}`);
  return profile;
}

function getModel(catalog, modelId) {
  const model = catalog.models.find((entry) => entry.id === modelId);
  if (!model) throw new Error(`Unknown model id: ${modelId}`);
  return model;
}

function resolveProfileModel(catalog, profileId) {
  const profile = getProfile(catalog, profileId);
  const modelId = (profile.preferred || [])[0];
  if (!modelId) throw new Error(`Routing profile ${profileId} has no preferred models`);
  return {
    profile,
    model: getModel(catalog, modelId),
  };
}

module.exports = {
  CATALOG_PATHS,
  WORKSPACE_ROOT,
  normalizeProvider,
  loadCatalog,
  getProfile,
  getModel,
  resolveProfileModel,
};

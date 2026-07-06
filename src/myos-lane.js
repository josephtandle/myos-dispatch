const fs = require("fs");
const path = require("path");

const { WORKSPACE_ROOT, normalizeProvider } = require("./model-catalog");

const DEFAULT_LANE_STATE = Object.freeze({
  authMode: "api",
  apiProvider: "openai",
  routeOverrides: {},
});

function getLaneStatePath() {
  return process.env.MYOS_LANE_STATE_PATH || path.join(WORKSPACE_ROOT, ".myos-lane.json");
}

const SUPPORTED_API_PROVIDERS = ["openai", "openrouter", "google"];

function normalizeApiProvider(provider) {
  const normalized = normalizeProvider(provider || DEFAULT_LANE_STATE.apiProvider);
  if (!SUPPORTED_API_PROVIDERS.includes(normalized)) {
    throw new Error(`Unsupported MyOS API provider: ${provider}`);
  }
  return normalized;
}

function normalizeAuthMode(authMode) {
  const normalized = String(authMode || DEFAULT_LANE_STATE.authMode).trim().toLowerCase();
  if (normalized === "api" || normalized === "oauth") return normalized;
  throw new Error(`Unsupported MyOS auth mode: ${authMode}`);
}

function normalizeLaneState(state = {}) {
  return {
    authMode: normalizeAuthMode(state.authMode),
    apiProvider: normalizeApiProvider(state.apiProvider),
    routeOverrides:
      state.routeOverrides && typeof state.routeOverrides === "object" ? state.routeOverrides : {},
    updatedAt: state.updatedAt || null,
    updatedBy: state.updatedBy || null,
  };
}

function readLaneState() {
  const target = getLaneStatePath();

  if (!fs.existsSync(target)) {
    return {
      ...DEFAULT_LANE_STATE,
      updatedAt: null,
      updatedBy: null,
    };
  }

  const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  return normalizeLaneState(parsed);
}

function writeLaneState(nextState, { updatedBy = "unknown" } = {}) {
  const target = getLaneStatePath();
  const current = readLaneState();
  const normalized = normalizeLaneState({
    ...current,
    ...nextState,
    updatedAt: new Date().toISOString(),
    updatedBy,
  });

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(normalized, null, 2) + "\n", "utf8");
  fs.renameSync(temp, target);

  return normalized;
}

module.exports = {
  DEFAULT_LANE_STATE,
  SUPPORTED_API_PROVIDERS,
  getLaneStatePath,
  normalizeApiProvider,
  normalizeAuthMode,
  normalizeLaneState,
  readLaneState,
  writeLaneState,
};

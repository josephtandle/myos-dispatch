"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { invalidateJsonCache, readJsonCached } = require("../json-cache");

function freezeStage(stage = {}) {
  return Object.freeze({
    ...stage,
    capabilities:
      stage.capabilities && typeof stage.capabilities === "object"
        ? Object.freeze({ ...stage.capabilities })
        : stage.capabilities,
    promotionCriteria:
      stage.promotionCriteria && typeof stage.promotionCriteria === "object"
        ? Object.freeze({ ...stage.promotionCriteria })
        : stage.promotionCriteria ?? null,
  });
}

function resolveValue(value, options) {
  return typeof value === "function" ? value(options) : value;
}

function parseTime(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : 0;
}

function isExpired(value, now) {
  if (!value?.until) return false;
  return parseTime(value.until) <= parseTime(now || new Date().toISOString());
}

function healthKey(type, value) {
  return `${type}:${String(value || "unknown").toLowerCase()}`;
}

function createStagedPromotionPolicy(config = {}) {
  const stages = Object.freeze((config.stages || []).map((stage) => freezeStage(stage)));
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const stageByPlanVersion = new Map(stages.map((stage) => [stage.planVersion, stage]));
  const promotionHistoryLimit = Number(config.promotionHistoryLimit || 25);
  const defaultStage = config.defaultStage;

  function normalizeStageId(value) {
    const text = String(value || "").trim().toLowerCase();
    if (!text) return "";
    if (stageById.has(text)) return text;
    const versionMatch = text.match(/(?:^|-)v?([0-9]+)$/);
    if (versionMatch && stageById.has(`v${versionMatch[1]}`)) return `v${versionMatch[1]}`;
    return stageByPlanVersion.get(text)?.id || "";
  }

  function stageFor(value) {
    return stageById.get(normalizeStageId(value)) || stageById.get(defaultStage);
  }

  function resolveStateFile(options = {}) {
    if (typeof config.resolveStateFile === "function") {
      return config.resolveStateFile(options);
    }
    const env = options.env || process.env;
    const configuredDefault = resolveValue(config.defaultStateFile, options);
    return options.stateFile || env[config.stateFileEnvVar] || configuredDefault;
  }

  function readState(options = {}) {
    try {
      const stateFile = resolveStateFile(options);
      return config.normalizeState(readJsonCached(stateFile));
    } catch {
      return config.defaultState();
    }
  }

  function writeState(state, options = {}) {
    const stateFile = resolveStateFile(options);
    const normalized = config.normalizeState(state);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, stateFile);
    invalidateJsonCache(tmp);
    invalidateJsonCache(stateFile);
  }

  function getStage(options = {}) {
    const env = options.env || process.env;
    const override = normalizeStageId(options.override || env[config.stageOverrideEnvVar]);
    const state = config.normalizeState(options.state || readState(options));
    const stage = stageFor(override || state.activeStage);
    return {
      ...stage,
      source: override ? "env" : "state",
      policyVersion: config.policyVersion,
      state: config.compactState(state),
    };
  }

  function applyPromotionIfEligible(state, stage, metrics, options = {}) {
    const env = options.env || process.env;
    if ((config.autoPromoteEnvVar && env[config.autoPromoteEnvVar] === "0") || options.enabled === false) {
      return null;
    }
    if (!config.isEligibleForPromotion(stage, metrics, state, options)) return null;
    const nextStage = stageFor(stage.nextStage);
    const promoted = {
      from: stage.id,
      to: nextStage.id,
      at: options.now || new Date().toISOString(),
      policyVersion: config.policyVersion,
      evidence: config.buildPromotionEvidence
        ? config.buildPromotionEvidence(metrics, state, stage, nextStage, options)
        : {},
    };
    state.activeStage = nextStage.id;
    state.promotions = [...(Array.isArray(state.promotions) ? state.promotions : []), promoted].slice(
      -promotionHistoryLimit,
    );
    return promoted;
  }

  function activeQuarantines(health = {}, now = new Date().toISOString()) {
    const normalizedHealth = config.normalizeHealthState ? config.normalizeHealthState(health) : health;
    return Object.fromEntries(
      Object.entries(normalizedHealth?.quarantines || {}).filter(([, quarantine]) => !isExpired(quarantine, now)),
    );
  }

  function hasProtectedActiveQuarantine(health = {}, now = new Date().toISOString()) {
    return Object.values(activeQuarantines(health, now)).some((quarantine) => quarantine.protected);
  }

  function isTargetQuarantined(state = {}, type, value, options = {}) {
    const now = options.now || new Date().toISOString();
    const normalizedState = config.normalizeState(state);
    const key = healthKey(type, value);
    const quarantine = activeQuarantines(normalizedState.health, now)[key];
    return quarantine || null;
  }

  return {
    policyVersion: config.policyVersion,
    stages,
    normalizeStageId,
    stageFor,
    resolveStateFile,
    readState,
    writeState,
    getStage,
    applyPromotionIfEligible,
    activeQuarantines,
    hasProtectedActiveQuarantine,
    isTargetQuarantined,
    healthKey,
    isExpired,
    parseTime,
  };
}

module.exports = {
  createStagedPromotionPolicy,
  healthKey,
  isExpired,
  parseTime,
};

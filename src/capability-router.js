'use strict';

const path = require('node:path');
const { resolveWorkspaceRoot } = require('./myos-compat.js');
const { readJsonCached } = require('./json-cache');

const WORKSPACE_ROOT = resolveWorkspaceRoot();
const CAPABILITIES_INDEX_PATH = path.join(WORKSPACE_ROOT, 'capabilities-index.json');
const MIN_CAPABILITY_EVIDENCE_SCORE = 10;
const MIN_CAPABILITY_TOTAL_SCORE = 18;
const ROUTING_COMPLAINT_RE = /\b(bad routing error|routing is messed up|routing.*wrong|wrong route|route this correctly|fix (?:this )?in the routing|fix your routing|not asking for a link|log your mistake)\b/i;
const GENERIC_TOKENS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'get', 'give',
  'help', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'live', 'me', 'my', 'of',
  'on', 'or', 'our', 'project', 'status', 'that', 'the', 'their', 'this', 'to',
  'up', 'we', 'with', 'you', 'your',
]);

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function tokenize(value) {
  return normalizeText(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function meaningfulTokens(value) {
  return tokenize(value).filter((token) => token.length >= 3 && !GENERIC_TOKENS.has(token));
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasBoundedPhrase(text, phrase) {
  const needle = normalizeText(phrase).trim();
  if (!needle) return false;
  const escaped = escapeRegex(needle).replace(/\s+/g, '\\s+');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(normalizeText(text));
}

function loadCapabilityIndex(options = {}) {
  const indexPath = options.indexPath || CAPABILITIES_INDEX_PATH;
  try {
    const parsed = readJsonCached(indexPath);
    return parsed && Array.isArray(parsed.capabilities) ? parsed : { capabilities: [], lanes: {} };
  } catch {
    return { capabilities: [], lanes: {} };
  }
}

function scorePhrases(haystack, tokens, phrases = []) {
  let score = 0;
  for (const phrase of phrases) {
    const needle = normalizeText(phrase);
    if (!needle) continue;
    if (hasBoundedPhrase(haystack, needle)) {
      score += Math.min(40, Math.max(10, needle.length));
      continue;
    }
    if (needle.includes(' ')) continue;
    if (tokens.has(needle)) score += 8;
  }
  return score;
}

function scoreCapabilityMatch(capability, text) {
  const haystack = normalizeText(text);
  const tokens = new Set(meaningfulTokens(text));

  let evidenceScore = 0;
  evidenceScore += scorePhrases(haystack, tokens, capability.aliases || []);
  evidenceScore += scorePhrases(haystack, tokens, capability.use_when || []);

  const description = normalizeText(capability.description || '');
  if (description && haystack.includes(description)) {
    evidenceScore += 20;
  } else {
    for (const token of meaningfulTokens(description)) {
      if (tokens.has(token)) evidenceScore += 2;
    }
  }

  for (const token of meaningfulTokens(capability.id || '')) {
    if (token.length >= 4 && tokens.has(token)) evidenceScore += 4;
  }

  for (const avoid of capability.avoid_when || []) {
    const needle = normalizeText(avoid);
    if (needle && haystack.includes(needle)) evidenceScore -= 25;
  }

  const priorityBoost = evidenceScore > 0
    ? Math.min(15, Math.round(Number(capability.priority || 0) / 10))
    : 0;

  return {
    score: evidenceScore + priorityBoost,
    evidenceScore,
  };
}

function scoreCapability(capability, text) {
  return scoreCapabilityMatch(capability, text).score;
}

function inferExecutionSignals(text) {
  const haystack = normalizeText(text);

  return {
    mentionsWorkflow: /\b(war room|multi-agent)\b/.test(haystack),
    mentionsDeterministicWork: /\b(check|get|find|list|update|delete|create|publish|upload|cancel|status|metrics|health|dns|booking|post)\b/.test(haystack),
    mentionsAdaptiveWork: /\b(plan|design|brainstorm|figure out|investigate|strategy|architect|improve|refactor)\b/.test(haystack),
  };
}

function shortlistCapabilities(text, lane = null, limit = 5, options = {}) {
  if (ROUTING_COMPLAINT_RE.test(normalizeText(text))) {
    return [];
  }
  const index = loadCapabilityIndex(options);
  const scored = index.capabilities
    .filter((capability) => !lane || capability.execution_lane === lane)
    .map((capability) => ({
      capability,
      ...scoreCapabilityMatch(capability, text),
    }))
    .filter((entry) =>
      entry.score > 0 &&
      (entry.evidenceScore >= MIN_CAPABILITY_EVIDENCE_SCORE || entry.score >= MIN_CAPABILITY_TOTAL_SCORE)
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored;
}

function selectExecutionLane(text, options = {}) {
  const signals = inferExecutionSignals(text);
  const workflowCandidates = shortlistCapabilities(text, 'workflow', 3, options);
  const recipeCandidates = shortlistCapabilities(text, 'recipe_dispatcher', 3, options);
  const workerCandidates = shortlistCapabilities(text, 'worker_skill', 3, options);

  if (
    signals.mentionsWorkflow &&
    workflowCandidates[0] &&
    workflowCandidates[0].evidenceScore >= 10 &&
    workflowCandidates[0].score >= 15
  ) {
    return {
      lane: 'workflow',
      reason: 'explicit_workflow_pattern',
      candidates: workflowCandidates,
    };
  }

  if (signals.mentionsDeterministicWork && recipeCandidates[0] && recipeCandidates[0].score >= 45) {
    return {
      lane: 'recipe_dispatcher',
      reason: 'deterministic_operational_match',
      candidates: recipeCandidates,
    };
  }

  if (signals.mentionsAdaptiveWork) {
    return {
      lane: 'worker_skill',
      reason: 'adaptive_request',
      candidates: workerCandidates,
    };
  }

  if (recipeCandidates[0] && (!workerCandidates[0] || recipeCandidates[0].score > workerCandidates[0].score + 15)) {
    return {
      lane: 'recipe_dispatcher',
      reason: 'recipe_score_dominant',
      candidates: recipeCandidates,
    };
  }

  if (
    workflowCandidates[0] &&
    workflowCandidates[0].evidenceScore >= 20 &&
    workflowCandidates[0].score > 60
  ) {
    return {
      lane: 'workflow',
      reason: 'workflow_score_dominant',
      candidates: workflowCandidates,
    };
  }

  return {
    lane: 'worker_skill',
    reason: 'default_worker_skill',
    candidates: workerCandidates,
  };
}

module.exports = {
  CAPABILITIES_INDEX_PATH,
  inferExecutionSignals,
  loadCapabilityIndex,
  scoreCapability,
  scoreCapabilityMatch,
  selectExecutionLane,
  shortlistCapabilities,
};

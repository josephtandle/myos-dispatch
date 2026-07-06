"use strict";

const DEFAULT_STOP_RULES = Object.freeze([
  "done_verified",
  "explicit_pause",
  "real_risk",
  "auth_required",
  "destructive_action",
  "material_ambiguity",
]);

const GOAL_MODES = Object.freeze({
  1: "direct",
  2: "bounded_goal",
  3: "ralph",
  4: "ultragoal",
});

const DIRECT_STATUS_RE = /\b(status|are you awake|are you there|bring up|restart|open|show|list|what is|what's|where is|who is|which)\b/;
const DIRECT_LOOKUP_RE = /\b(link|url|id|status|version|path|file|title|time|date|count)\b/;
const ACTION_RE = /\b(implement|fix|build|create|update|add|wire|ship|verify|test|debug|repair|revise|evaluate|plan|send|write|draft|run|audit|delete|remove|clean up|cleanup|triage|organize|handoff|hand off)\b/;
const MANAGER_HANDOFF_RE = /\b(?:ask|tell)\s+[a-z0-9-]+(?:\s+(?:project\s+)?manager|\s+agent)\b|\b(?:give|hand off|handoff|talk to|chat with|bring up)\b(?!\s+me\b).{0,48}\b[a-z0-9-]+(?:\s+(?:project\s+)?manager|\s+agent)\b/;
const AUTONOMY_RE = /\b(don't stop|do not stop|keep going|autonomous|automatically|without me|default for all|all sessions|all commands|project manager|standing|durable|goal scale|ralph|ultragoal)\b/;
const PLANNING_RE = /\b(plan|evaluate|proposal|strategy|dispatch|routing|policy|governance|council|infrastructure|migration|architecture)\b/;
const MULTI_STEP_RE = /\b(and then|then|after that|next|also|plus|while|across|end-to-end|through verification|from .* to .*)\b|[,;].*[,;]/;
const APPROVAL_RE = /\b(delete|destroy|drop database|rm -rf|wipe|revoke|production data|prod data|firewall|dns|billing|charge|send to client|email everyone)\b|rotate\b.{0,32}\bkey\b/;

const SYSTEM_TERMS = Object.freeze([
  "dispatch",
  "runtime",
  "worker",
  "recipe",
  "capability",
  "project",
  "agent",
  "codex",
  "claude",
  "gemini",
  "oauth",
  "api",
  "model",
  "policy",
  "tests",
  "database",
  "db",
  "browser",
  "github",
  "gitnexus",
  "graphiti",
  "graphify",
  "mission control",
  "launchd",
  "cron",
  "ios",
  "docs",
  "sports",
]);

function normalizeText(value) {
  if (Array.isArray(value)) return value.map(normalizeText).join(" ");
  if (value && typeof value === "object") {
    if (Array.isArray(value.messages)) {
      return value.messages
        .map((message) => normalizeText(message?.content || ""))
        .join(" ");
    }
    return normalizeText(value.text || value.prompt || value.command || "");
  }
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function includesTerm(text, term) {
  return new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}

function countSystemsTouched(text, context = {}) {
  const found = new Set();
  for (const term of SYSTEM_TERMS) {
    if (includesTerm(text, term)) found.add(term);
  }

  const route = context.route || {};
  if (route.lane) found.add(`lane:${route.lane}`);
  if (Array.isArray(route.candidates) && route.candidates.length > 0) found.add("capability");
  if (Array.isArray(context.projectMatches) && context.projectMatches.length > 0) found.add("project");
  if (Array.isArray(context.dataSources) && context.dataSources.length > 0) found.add("data");
  if (Array.isArray(context.candidates) && context.candidates.length > 1) found.add("recipe_candidates");

  return found.size;
}

function countActionVerbs(text) {
  const matches = text.match(/\b(implement|fix|build|create|update|add|wire|ship|verify|test|debug|repair|revise|evaluate|plan|send|write|draft|run|audit|delete|remove|clean up|cleanup|triage|organize|handoff|hand off)\b/g);
  return matches ? new Set(matches).size : 0;
}

function confidenceFor(scale, reasons) {
  if (scale === 4) return reasons.length >= 3 ? "high" : "medium";
  if (scale === 1) return reasons.includes("direct_lookup_or_status") ? "high" : "medium";
  return reasons.length >= 2 ? "high" : "medium";
}

function goalMetadata(scale, reasons, blockedBy = []) {
  const normalizedScale = Math.max(1, Math.min(4, Number(scale) || 3));
  return {
    goalScale: normalizedScale,
    goalMode: GOAL_MODES[normalizedScale],
    goalConfidence: confidenceFor(normalizedScale, reasons),
    goalReasons: [...new Set(reasons)],
    stopRules: [...DEFAULT_STOP_RULES],
    requiresPlan: normalizedScale >= 4,
    requiresApproval: blockedBy.length > 0,
    blockedBy,
  };
}

function normalizeExistingGoalMetadata(value = {}) {
  if (!value || typeof value !== "object" || !value.goalScale) return null;
  const base = goalMetadata(value.goalScale, value.goalReasons || ["provided_goal_scale"], value.blockedBy || []);
  return {
    ...base,
    goalMode: value.goalMode || base.goalMode,
    goalConfidence: value.goalConfidence || base.goalConfidence,
    stopRules: Array.isArray(value.stopRules) && value.stopRules.length > 0 ? value.stopRules : base.stopRules,
    requiresPlan: value.requiresPlan != null ? Boolean(value.requiresPlan) : base.requiresPlan,
    requiresApproval: value.requiresApproval != null ? Boolean(value.requiresApproval) : base.requiresApproval,
  };
}

function inferGoalScale(input, context = {}) {
  const existing = normalizeExistingGoalMetadata(input?.dispatchPlan || input);
  if (existing) return existing;

  const text = normalizeText(input);
  const reasons = [];
  const blockedBy = [];
  const parallelizationPlan =
    context.parallelizationPlan ||
    input?.parallelizationPlan ||
    input?.dispatchPlan?.parallelizationPlan ||
    null;
  const backgroundTaskCount = Array.isArray(parallelizationPlan?.backgroundTasks)
    ? parallelizationPlan.backgroundTasks.length
    : 0;
  const hasParallelBackgroundWork =
    backgroundTaskCount >= 2 &&
    !parallelizationPlan?.blockedReasons?.length &&
    parallelizationPlan?.mode !== "none";
  const hasOrchestratedFanout =
    hasParallelBackgroundWork &&
    (parallelizationPlan?.joinPolicy === "require_before_final" ||
      /implementation|verification|read_only|sidecar/i.test(String(parallelizationPlan?.mode || "")));

  if (APPROVAL_RE.test(text)) {
    blockedBy.push("approval_sensitive_operation");
    reasons.push("risk_or_approval_signal");
  }

  const systemsTouched = countSystemsTouched(text, context);
  const hasManagerHandoff = MANAGER_HANDOFF_RE.test(text);
  const hasAction = ACTION_RE.test(text) || hasManagerHandoff || context.actionType === "write";
  const hasMultiStep = MULTI_STEP_RE.test(text);
  const hasAutonomy = AUTONOMY_RE.test(text);
  const hasPlanning = PLANNING_RE.test(text) || context.intent === "planning_evaluation";
  const actionVerbCount = countActionVerbs(text);
  const routeLane = context.route?.lane || context.routeKey || "";
  const routeComplex = ["workflow", "recipe_dispatcher"].includes(routeLane) ||
    (Array.isArray(context.candidates) && context.candidates.length > 1);

  if (hasMultiStep) reasons.push("multi_step_outcome");
  if (hasAutonomy) reasons.push("autonomy_or_durable_goal_signal");
  if (hasPlanning) reasons.push("planning_or_dispatch_signal");
  if (hasManagerHandoff) reasons.push("manager_handoff");
  if (actionVerbCount >= 3) reasons.push("multiple_action_outcomes");
  if (systemsTouched >= 2) reasons.push("multiple_systems_touched");
  if (routeComplex) reasons.push("workflow_or_recipe_route");
  if (hasParallelBackgroundWork) reasons.push("parallel_background_work");
  if (hasOrchestratedFanout) reasons.push("orchestrated_fanout");

  const scale4Score = [
    hasMultiStep,
    hasAutonomy,
    hasPlanning && hasAction,
    hasManagerHandoff,
    actionVerbCount >= 3,
    systemsTouched >= 3,
    routeComplex && hasAction,
    hasParallelBackgroundWork && hasAction,
    hasOrchestratedFanout && hasAction,
  ].filter(Boolean).length;

  const hasStructuralScale4Signal =
    hasMultiStep || hasManagerHandoff || hasParallelBackgroundWork || hasOrchestratedFanout;
  if (
    scale4Score >= 3 ||
    (hasAction && scale4Score >= 2 && hasStructuralScale4Signal) ||
    (hasAutonomy && hasPlanning && systemsTouched >= 2) ||
    (actionVerbCount >= 3 && hasMultiStep && systemsTouched >= 2)
  ) {
    return goalMetadata(4, reasons, blockedBy);
  }

  if (!hasAction && DIRECT_STATUS_RE.test(text) && (DIRECT_LOOKUP_RE.test(text) || text.split(/\s+/).length <= 8)) {
    return goalMetadata(1, ["direct_lookup_or_status"], blockedBy);
  }

  if (!hasAction && (DIRECT_STATUS_RE.test(text) || text.split(/\s+/).length <= 12)) {
    return goalMetadata(2, ["bounded_answer"], blockedBy);
  }

  if (hasAction) reasons.push("actionable_goal");
  return goalMetadata(3, reasons.length > 0 ? reasons : ["default_actionable_goal"], blockedBy);
}

module.exports = {
  DEFAULT_STOP_RULES,
  GOAL_MODES,
  inferGoalScale,
  normalizeExistingGoalMetadata,
};

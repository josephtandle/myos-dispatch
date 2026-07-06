"use strict";

const { resolveDispatchPlan } = require("../workspace-context");
const {
  getTypedEvidenceShadowStage,
  recordTypedEvidenceShadowLiveComparison,
} = require("./typed-evidence-shadow-policy");

// Self-contained generic read-only data-source config so the canary exercises
// the safe data-lookup routing path without depending on any private workspace
// config. Real deployments supply their own config via the data-source registry.
const CANARY_DATA_SOURCES = Object.freeze({
  version: 1,
  dataSources: [
    {
      id: "entities",
      label: "entities",
      mode: "content",
      path: "data/entities.md",
      readOnly: true,
      matchTerms: [
        "entity info",
        "business entity info",
        "company info",
        "company entity info",
        "business info",
        "llc info",
        "corporate registration info",
        "incorporation info",
        "entity details",
        "registered business info",
      ],
    },
    {
      id: "profile",
      label: "profile",
      mode: "content",
      path: "data/profile.md",
      readOnly: true,
      matchTerms: [
        "my address",
        "my mailing address",
        "my home address",
        "my display name",
        "my time zone",
        "my postal address",
      ],
    },
    {
      id: "computer_info",
      label: "computer-info",
      mode: "content",
      path: "data/computer.md",
      readOnly: true,
      matchTerms: [
        "computer specs",
        "laptop specs",
        "serial number",
        "monitor sizes",
        "monitor size",
        "screen size",
        "hardware specs",
        "device specs",
        "machine specs",
      ],
    },
  ],
});

const SAFE_AUTHORITATIVE_PROMPTS = Object.freeze([
  "what is my entity info?",
  "what is my business entity info?",
  "what is my company info?",
  "what is my company entity info?",
  "what is my business info?",
  "what is my LLC info?",
  "what is my corporate registration info?",
  "what is my incorporation info?",
  "what are my entity details?",
  "what is my registered business info?",
  "what is my address?",
  "what is my mailing address?",
  "what is my home address?",
  "what is my display name?",
  "what is my time zone?",
  "what is my postal address?",
  "what are my computer specs?",
  "what are my laptop specs?",
  "what is my serial number?",
  "what are my monitor sizes?",
  "what is my monitor size?",
  "what is my screen size?",
  "what are my hardware specs?",
  "what are my device specs?",
  "what are my machine specs?",
]);

function resolveCanaryPlan(prompt, options = {}) {
  const baseEnv = options.env || {};
  const stateFile = options.stateFile;
  // Without an explicit promotion state file, pin the safe-authoritative stage
  // (v2) so the canary is self-contained and does not depend on ambient state.
  const env = stateFile
    ? baseEnv
    : { ...baseEnv, MYOS_TYPED_EVIDENCE_SHADOW_VERSION: baseEnv.MYOS_TYPED_EVIDENCE_SHADOW_VERSION || "v2" };
  return resolveDispatchPlan(prompt, {
    env,
    typedEvidenceShadowPolicy: { stateFile },
    dataSourceOptions: { config: CANARY_DATA_SOURCES },
  });
}

function validateCanaryPlan(plan, prompt) {
  const authoritative = Boolean(plan.shadowDispatch?.authoritative);
  const useShadow = Boolean(plan.shadowDispatch?.authorityDecision?.useShadow);
  const safeEligible = Boolean(plan.shadowDispatch?.authorityDecision?.safeAuthoritativeEligible);
  const branch = plan.shadowDispatch?.plan?.branch || null;
  const lane = plan.shadowDispatch?.plan?.route?.lane || plan.shadowDispatch?.plan?.executionLane || null;
  const actionType = plan.shadowDispatch?.plan?.actionType || null;

  if (!authoritative || !useShadow || !safeEligible || branch !== "data" || lane !== "data_lookup" || actionType !== "read") {
    throw new Error(
      `Unsafe typed-evidence canary prompt: ${prompt} -> ` +
      JSON.stringify({ authoritative, useShadow, safeEligible, branch, lane, actionType }),
    );
  }
}

function runTypedEvidenceShadowCanary(options = {}) {
  const cycles = Math.max(1, Number(options.cycles || 1));
  const prompts = Array.isArray(options.prompts) && options.prompts.length > 0
    ? options.prompts
    : SAFE_AUTHORITATIVE_PROMPTS;

  const runs = [];
  let promoted = null;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    for (const prompt of prompts) {
      const plan = resolveCanaryPlan(prompt, options);
      validateCanaryPlan(plan, prompt);
      const progression = recordTypedEvidenceShadowLiveComparison({
        comparison: plan.shadowDispatch?.comparison || { same: true },
        authorityDecision: plan.shadowDispatch?.authorityDecision,
        outcomeStatus: "ok",
      }, {
        stateFile: options.stateFile,
        env: options.env || process.env,
      });
      if (progression.promoted) promoted = progression.promoted;
      runs.push({
        cycle: cycle + 1,
        prompt,
        branch: plan.branch,
        lane: plan.route?.lane || null,
        comparisonSame: Boolean(plan.shadowDispatch?.comparison?.same),
        authoritative: true,
        promoted: progression.promoted || null,
      });
    }
  }

  return {
    prompts,
    cycles,
    runs,
    promoted,
    finalState: getTypedEvidenceShadowStage({
      stateFile: options.stateFile,
      env: options.env || process.env,
    }).state,
  };
}

module.exports = {
  SAFE_AUTHORITATIVE_PROMPTS,
  resolveCanaryPlan,
  runTypedEvidenceShadowCanary,
  validateCanaryPlan,
};

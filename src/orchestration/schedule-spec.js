"use strict";

const { buildExecutionEnvelope } = require("./execution-envelope");

const SUPPORTED_SUBSTRATES = new Set(["codex_scheduled", "cron", "launchd", "systemd"]);
const SAFE_ACTIONS = new Set(["report", "propose"]);
const SCHEDULED_MUTATION_RE = /\b(send|email|message|text|whatsapp|telegram|publish|deploy|push|merge|delete|remove|wipe|destroy|drop|charge|refund|purchase|buy|upload|post|share|execute|run|apply|commit|log\s*in|authenticate|rotate|write|update|modify|create)\b/i;

function isSimpleCronField(field, min, max) {
  return String(field).split(",").every((segment) => {
    const [base, stepText] = segment.split("/");
    if (stepText != null) {
      const step = Number(stepText);
      if (!Number.isInteger(step) || step < 1 || step > max) return false;
    }
    if (base === "*") return true;
    if (/^\d+$/.test(base)) {
      const value = Number(base);
      return value >= min && value <= max;
    }
    const range = base.match(/^(\d+)-(\d+)$/);
    if (!range) return false;
    const start = Number(range[1]);
    const end = Number(range[2]);
    return start >= min && end <= max && start <= end;
  });
}

function isRecognizedCadence(cadence) {
  const value = String(cadence || "").trim();
  const cronFields = value.split(/\s+/);
  if (
    cronFields.length === 5 &&
    isSimpleCronField(cronFields[0], 0, 59) &&
    isSimpleCronField(cronFields[1], 0, 23) &&
    isSimpleCronField(cronFields[2], 1, 31) &&
    isSimpleCronField(cronFields[3], 1, 12) &&
    isSimpleCronField(cronFields[4], 0, 7)
  ) {
    return true;
  }
  return /^(hourly|daily|weekly|monthly|every\s+\d+\s+(?:minutes?|hours?|days?|weeks?)|RRULE:|R\d*\/|P(?:T|\d))/i.test(value);
}

function normalizeScheduleSpec(spec = {}) {
  return {
    scheduleId: String(spec.scheduleId || "").trim(),
    owner: String(spec.owner || "").trim(),
    cadence: String(spec.cadence || "").trim(),
    timezone: String(spec.timezone || "UTC").trim(),
    substrate: String(spec.substrate || "codex_scheduled").trim(),
    action: String(spec.action || "report").trim(),
    prompt: String(spec.prompt || "").trim(),
    repository: String(spec.repository || "").trim(),
    worktreePolicy: String(spec.worktreePolicy || "isolated_if_repository_scoped").trim(),
    externalMutation: Boolean(spec.externalMutation),
    enabled: spec.enabled !== false,
  };
}

function validateScheduleSpec(spec = {}) {
  const normalized = normalizeScheduleSpec(spec);
  const errors = [];
  if (!normalized.scheduleId) errors.push("schedule_id_required");
  if (!normalized.owner) errors.push("owner_required");
  if (!normalized.cadence) errors.push("cadence_required");
  else if (!isRecognizedCadence(normalized.cadence)) errors.push("cadence_unrecognized");
  if (!normalized.prompt) errors.push("prompt_required");
  else if (SCHEDULED_MUTATION_RE.test(normalized.prompt)) errors.push("scheduled_prompt_mutation_or_send_forbidden");
  if (!SUPPORTED_SUBSTRATES.has(normalized.substrate)) errors.push("unsupported_substrate");
  if (!SAFE_ACTIONS.has(normalized.action)) errors.push("gold_canary_allows_report_or_propose_only");
  if (normalized.externalMutation) errors.push("external_mutation_forbidden");
  return {
    ok: errors.length === 0,
    errors,
    spec: normalized,
  };
}

function compileScheduleSpec(spec = {}, options = {}) {
  const validated = validateScheduleSpec(spec);
  if (!validated.ok) {
    return {
      status: "rejected",
      errors: validated.errors,
      spec: validated.spec,
      execution: null,
    };
  }
  const env = options.env || process.env;
  if (
    !validated.spec.enabled ||
    String(env.MYOS_ORCHESTRATION_GOLD_ENABLED ?? "1") === "0" ||
    String(env.MYOS_SCHEDULED_DISPATCH_ENABLED ?? "1") === "0"
  ) {
    return {
      status: "disabled",
      errors: [],
      spec: validated.spec,
      execution: null,
    };
  }
  return {
    status: "ready",
    errors: [],
    spec: validated.spec,
    execution: {
      initiator: "unattended",
      approvalPolicy: "never",
      mutationPolicy: "report_or_propose_only",
      repository: validated.spec.repository || null,
      worktreePolicy: validated.spec.worktreePolicy,
      environment: {
        MYOS_INITIATOR: "unattended",
        MYOS_BACKGROUND_AGENTS_ENABLED: "0",
        MYOS_CODEX_PLUGIN_ROUTING_ENABLED: "0",
        MYOS_WRITABLE_SIDECARS_ENABLED: "0",
      },
      envelope: buildExecutionEnvelope(validated.spec.prompt, {
        actionType: "read",
        projectSlug: options.projectSlug || null,
      }, {
        env: {
          ...env,
          MYOS_INITIATOR: "unattended",
        },
        blockedReasons: [],
      }),
    },
  };
}

module.exports = {
  SAFE_ACTIONS,
  SUPPORTED_SUBSTRATES,
  compileScheduleSpec,
  isSimpleCronField,
  isRecognizedCadence,
  normalizeScheduleSpec,
  validateScheduleSpec,
};

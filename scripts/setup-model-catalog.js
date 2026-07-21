"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { CANONICAL_TASK_CLASSES, ROUTING_POLICY } = require("../src/myos-routing");
const { loadCatalog, resolveProfileModel } = require("../src/model-catalog");
const {
  preferredHomeRoot,
  resolveModelCatalogLocalPath,
} = require("../src/myos-compat");

const PROVIDER_ORDER = ["openai", "google", "anthropic", "openrouter"];

const PROVIDER_ENV_KEYS = {
  openai: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  google: [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_AI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
  ],
  anthropic: ["ANTHROPIC_API_KEY"],
};

const PROVIDER_CLI = {
  openai: "codex",
  anthropic: "claude",
  google: "gemini",
};

const TASK_DESCRIPTIONS = {
  cheap_routing: "Fast, low-cost text replies and simple transformations.",
  default_automation: "Routine assistant work and general task handling.",
  heavy_synthesis: "Longer reasoning, writing, and synthesis tasks.",
  task_class_is_elite: "Highest-priority synthesis when quality matters most.",
  planning: "Step-by-step planning, analysis, and decision support.",
  audio_transcription: "Speech to text conversion.",
  audio_diarization: "Identify who is speaking in an audio clip.",
  realtime_audio: "Live voice work that needs low latency.",
};

function defaultProbeEnv(env = process.env) {
  return env;
}

function commandExists(command) {
  const result = process.platform === "win32"
    ? spawnSync("cmd", ["/d", "/s", "/c", `where ${command} >nul 2>nul`], {
        timeout: 3000,
        stdio: "ignore",
      })
    : spawnSync("sh", ["-lc", `command -v ${command} >/dev/null 2>&1`], {
        timeout: 3000,
        stdio: "ignore",
      });
  return !result.error && result.status === 0;
}

function runOllamaList() {
  const result = spawnSync("ollama", ["list"], {
    timeout: 3000,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) return [];
  const output = String(result.stdout || "").trim();
  if (!output) return [];
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const rows = lines.slice(1);
  const models = [];
  for (const row of rows) {
    const model = row.split(/\s+/)[0];
    if (model && model.toLowerCase() !== "name") models.push(model);
  }
  return [...new Set(models)];
}

function defaultProbes(env = process.env) {
  return {
    cliAvailable(command) {
      return commandExists(command);
    },
    envHas(key) {
      return Boolean(String(defaultProbeEnv(env)[key] || "").trim());
    },
    ollamaModels() {
      if (!commandExists("ollama")) return null;
      return runOllamaList();
    },
    mlxWhisperAvailable() {
      return commandExists("mlx_whisper");
    },
    now() {
      return new Date();
    },
  };
}

function normalizeProviderAvailability(probes, env = process.env) {
  const availability = {};
  for (const provider of PROVIDER_ORDER) {
    const cli = PROVIDER_CLI[provider];
    const oauth = cli ? Boolean(probes.cliAvailable(cli)) : false;
    const apiKey = Boolean((PROVIDER_ENV_KEYS[provider] || []).some((key) => probes.envHas(key)));
    if (!oauth && !apiKey) continue;
    availability[provider] = {
      oauthCli: oauth ? cli : undefined,
      oauth,
      apiKey,
    };
  }
  return availability;
}

function normalizeLocalAvailability(probes) {
  const hasOllama = Boolean(probes.cliAvailable("ollama"));
  const models = hasOllama ? (probes.ollamaModels() || []) : [];
  return {
    ollama: {
      available: hasOllama,
      models,
    },
    mlxWhisper: {
      available: Boolean(probes.mlxWhisperAvailable()),
    },
  };
}

function resolveTargetCandidate(taskClass, lane, target, providers) {
  if (!target || target.type !== "llm") return null;
  const providerState = providers[target.provider];
  if (!providerState) return null;
  if (lane === "interactive_oauth" && !providerState.oauth) return null;
  if (lane === "unattended_api" && !providerState.apiKey) return null;
  if (lane === "unattended_local") return null;

  const catalog = loadCatalog(target.provider);
  if (target.model) {
    const resolvedModel = catalog.models.find(
      (entry) => entry.id === target.model || entry.model === target.model
    );
    if (!resolvedModel) return null;
    const resolvedProfile = target.profile
      ? catalog.routing_profiles.find((entry) => entry.id === target.profile)
      : null;
    if (target.profile && !resolvedProfile) return null;
    return {
      type: "llm",
      provider: target.provider,
      profile: target.profile || null,
      model: resolvedModel.id,
      authMode: lane === "interactive_oauth" ? "oauth" : "api",
      lane,
      source: "auto",
      taskClass,
    };
  }

  if (!target.profile) return null;
  try {
    const resolved = resolveProfileModel(catalog, target.profile);
    return {
      type: "llm",
      provider: target.provider,
      profile: resolved.profile.id,
      model: resolved.model.id,
      authMode: lane === "interactive_oauth" ? "oauth" : "api",
      lane,
      source: "auto",
      taskClass,
    };
  } catch {
    return null;
  }
}

function chooseAssignment(taskClass, providers, local) {
  const routes = ROUTING_POLICY.taskClasses[taskClass] || {};
  for (const preferredLane of ["interactive_oauth", "unattended_api", "unattended_local"]) {
    const route = routes[preferredLane];
    if (!route) continue;
    if (preferredLane === "unattended_local") {
      continue;
    }
    for (const target of route.llmTargets || []) {
      const candidate = resolveTargetCandidate(taskClass, preferredLane, target, providers);
      if (candidate) return candidate;
    }
  }

  if (local.ollama.available && ["cheap_routing", "default_automation", "heavy_synthesis", "task_class_is_elite", "planning"].includes(taskClass)) {
    const route = routes.unattended_local || {};
    for (const target of route.llmTargets || []) {
      const candidate = resolveTargetCandidate(taskClass, "unattended_local", target, providers);
      if (candidate) return candidate;
    }
  }

  return null;
}

function firstEnablementHint(taskClass) {
  const routes = ROUTING_POLICY.taskClasses[taskClass] || {};
  for (const lane of ["unattended_api", "interactive_oauth", "unattended_local"]) {
    const route = routes[lane];
    if (!route) continue;
    for (const target of route.llmTargets || []) {
      if (lane === "unattended_api") {
        const envKey = (PROVIDER_ENV_KEYS[target.provider] || [])[0];
        if (envKey) return `set ${envKey}`;
      }
      if (lane === "interactive_oauth") {
        const cli = PROVIDER_CLI[target.provider];
        if (cli) return `install ${cli} CLI`;
      }
      if (lane === "unattended_local") {
        return "install ollama";
      }
    }
  }
  return "enable a supported provider";
}

function buildAssignments(providers, local) {
  const assignments = {};
  for (const taskClass of CANONICAL_TASK_CLASSES) {
    const candidate = chooseAssignment(taskClass, providers, local);
    if (candidate) {
      assignments[taskClass] = candidate;
      continue;
    }

    assignments[taskClass] = {
      unassigned: true,
      reason: `no provider for ${taskClass} detected`,
      enableWith: firstEnablementHint(taskClass),
    };
  }
  return assignments;
}

function buildModelCatalog({ homeRoot = preferredHomeRoot(), probes = defaultProbes(), now = probes.now?.bind(probes) || (() => new Date()), existing = null } = {}) {
  const providers = normalizeProviderAvailability(probes);
  const local = normalizeLocalAvailability(probes);
  const assignments = buildAssignments(providers, local);
  const overrides = existing && existing.overrides && typeof existing.overrides === "object" && !Array.isArray(existing.overrides)
    ? existing.overrides
    : {};

  return {
    version: 1,
    generatedAt: now().toISOString(),
    providers,
    local,
    assignments,
    overrides,
    homeRoot,
  };
}

function taskClassDescription(taskClass) {
  return TASK_DESCRIPTIONS[taskClass] || "General MyOS work.";
}

function formatAssignmentLine(taskClass, assignment) {
  if (assignment.unassigned) {
    return `Unassigned: ${assignment.reason}. Enable with ${assignment.enableWith}.`;
  }

  const laneLabel = assignment.lane === "interactive_oauth"
    ? "interactive_oauth"
    : assignment.lane === "unattended_api"
      ? "unattended_api"
      : "unattended_local";
  return `Assigned: ${assignment.model}, available through ${laneLabel} because ${assignment.authMode === "oauth" ? "the CLI is present" : "an API key is present"}.`;
}

function describeDetectedProvider(provider, state) {
  const parts = [];
  if (state.oauth) parts.push(`${state.oauthCli} CLI signed in on this machine`);
  if (state.apiKey) parts.push("API key in your environment");
  return `- ${provider}: ${parts.join(", plus an ")}`;
}

function renderDetectedModels(catalog) {
  const lines = [];
  const providerNames = Object.keys(catalog.providers || {});
  for (const provider of providerNames) {
    lines.push(describeDetectedProvider(provider, catalog.providers[provider]));
  }
  if (catalog.local?.ollama?.available) {
    const models = catalog.local.ollama.models || [];
    lines.push(`- local: ollama${models.length ? ` (${models.join(", ")})` : ""}`);
  }
  if (catalog.local?.mlxWhisper?.available) {
    lines.push("- local: mlx_whisper for on-device transcription");
  }
  if (!lines.length) {
    lines.push("- none yet: no provider CLIs, API keys, or local runtimes were detected");
  }
  return lines;
}

function renderReport(catalog) {
  const lines = [];
  lines.push("MyOS Dispatch is a routing layer for prompts and tasks.");
  lines.push("It reads each request, picks the right lane for the work, and keeps risky actions gated.");
  lines.push("Recipe, tool, and data work stay separated so each step uses the cheapest model that can do it well.");
  lines.push("When a stronger model is needed, Dispatch can route there without changing how you ask.");
  lines.push("If a request needs a safer path, it holds that work behind the right checks.");
  lines.push("The goal is to keep the system simple, fast, and predictable.");
  lines.push("");
  lines.push("These are the models I identified as available on this machine:");
  lines.push(...renderDetectedModels(catalog));
  lines.push("");
  lines.push("I've made my best guess assigning the eight task classes to them:");

  for (const taskClass of CANONICAL_TASK_CLASSES) {
    const assignment = catalog.assignments[taskClass];
    lines.push(`${taskClass}: ${taskClassDescription(taskClass)}`);
    lines.push(formatAssignmentLine(taskClass, assignment));
  }

  lines.push("");
  lines.push("Here are the task classes. I've assigned them to these models. Let me know if you would like to change any of them.");
  lines.push(`Edit ${path.join(catalog.homeRoot, "config", "model-catalog.local.json")}, in the overrides section. Re-running node scripts/setup-model-catalog.js --report refreshes assignments without touching overrides.`);
  return lines.join("\n");
}

function readExistingCatalog(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) return null;
    return JSON.parse(fs.readFileSync(targetPath, "utf8"));
  } catch {
    return null;
  }
}

function writeModelCatalog(targetPath, catalog) {
  const output = {
    version: catalog.version,
    generatedAt: catalog.generatedAt,
    providers: catalog.providers,
    local: catalog.local,
    assignments: catalog.assignments,
    overrides: catalog.overrides,
  };
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  return output;
}

function parseArgs(argv) {
  const args = {
    home: null,
    report: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--home") {
      args.home = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--home=")) {
      args.home = arg.slice("--home=".length);
      continue;
    }
    if (arg === "--report") {
      args.report = true;
      continue;
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const homeRoot = args.home || process.env.MYOS_HOME_ROOT || preferredHomeRoot();
  const targetPath = resolveModelCatalogLocalPath(homeRoot);
  const existing = readExistingCatalog(targetPath);
  const catalog = buildModelCatalog({
    homeRoot,
    probes: defaultProbes(),
    existing,
  });
  const written = writeModelCatalog(targetPath, catalog);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(written, null, 2)}\n`);
    return written;
  }

  if (args.report) {
    process.stdout.write(`${renderReport({ ...written, homeRoot })}\n`);
    return written;
  }

  process.stdout.write(`Model catalog written to ${targetPath}\n`);
  return written;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  TASK_DESCRIPTIONS,
  buildAssignments,
  buildModelCatalog,
  defaultProbes,
  formatAssignmentLine,
  firstEnablementHint,
  main,
  normalizeLocalAvailability,
  normalizeProviderAvailability,
  parseArgs,
  readExistingCatalog,
  renderReport,
  resolveTargetCandidate,
  writeModelCatalog,
};

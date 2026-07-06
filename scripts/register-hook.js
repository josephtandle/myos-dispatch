#!/usr/bin/env node
"use strict";

// register-hook.js — defensively merge the MyOS Dispatch hook into a
// Claude Code settings.json using node (no jq, for portability).
//
// SAFETY CONTRACT:
//   - NEVER overwrites the file. Reads existing JSON, mutates only the
//     `hooks` object and one `env` key, and writes the result back.
//   - IDEMPOTENT: existing MyOS Dispatch hook entries (identified by the
//     stable marker in the command string) are stripped before re-adding,
//     so re-running never duplicates.
//   - PRESERVES every unrelated key (model, theme, permissions, other
//     hooks, other env vars).
//   - --dry-run prints the planned result without writing.
//   - --remove strips the hook + our env key (reversible uninstall).
//
// Usage:
//   node scripts/register-hook.js --settings <path> --node <nodePath> \
//        --hook <hookPath> --home <MYOS_HOME_ROOT> \
//        [--surface claude] [--with-pretool] [--dry-run] [--remove]

const fs = require("node:fs");
const path = require("node:path");

const MARKER = "myos-dispatch-hook"; // stable substring present in our command
const HOME_ENV_KEY = "MYOS_HOME_ROOT";

function parseArgs(argv) {
  const args = {
    settings: "",
    node: "node",
    hook: "",
    home: "",
    surface: "claude",
    withPretool: false,
    dryRun: false,
    remove: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const take = () => argv[++i] || "";
    if (a === "--settings") args.settings = take();
    else if (a === "--node") args.node = take();
    else if (a === "--hook") args.hook = take();
    else if (a === "--home") args.home = take();
    else if (a === "--surface") args.surface = take();
    else if (a === "--with-pretool") args.withPretool = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--remove") args.remove = true;
  }
  return args;
}

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath, "utf8");
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    throw new Error("settings.json is not a JSON object");
  } catch (error) {
    throw new Error(`Refusing to touch unparseable settings.json (${error.message}). No changes made.`);
  }
}

function quote(value) {
  // Wrap in double quotes for the shell; escape embedded quotes.
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function buildCommand(nodePath, hookPath, surface) {
  return `${quote(nodePath)} ${quote(hookPath)} --surface=${surface}`;
}

function isOurHookEntry(entry) {
  return entry
    && typeof entry === "object"
    && typeof entry.command === "string"
    && entry.command.includes(MARKER);
}

// Remove every MyOS Dispatch hook entry from a single event array, dropping
// any group that becomes empty. Returns the filtered array.
function stripMarkerFromEvent(groups) {
  if (!Array.isArray(groups)) return [];
  const cleaned = [];
  for (const group of groups) {
    if (!group || typeof group !== "object") {
      cleaned.push(group);
      continue;
    }
    if (!Array.isArray(group.hooks)) {
      cleaned.push(group);
      continue;
    }
    const hooks = group.hooks.filter((entry) => !isOurHookEntry(entry));
    if (hooks.length === 0) continue; // drop group that only held our entry
    cleaned.push({ ...group, hooks });
  }
  return cleaned;
}

function stripAll(hooks) {
  const result = {};
  for (const [event, groups] of Object.entries(hooks || {})) {
    const cleaned = stripMarkerFromEvent(groups);
    if (cleaned.length) result[event] = cleaned;
  }
  return result;
}

function addToEvent(hooks, event, group) {
  const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
  hooks[event] = [...existing, group];
}

function merge(settings, args) {
  const out = { ...settings };
  const command = buildCommand(args.node, args.hook, args.surface);

  // Always start by stripping any prior MyOS Dispatch hook entries.
  let hooks = stripAll(out.hooks || {});

  if (!args.remove) {
    addToEvent(hooks, "UserPromptSubmit", {
      hooks: [{ type: "command", command }],
    });
    if (args.withPretool) {
      addToEvent(hooks, "PreToolUse", {
        matcher: "Bash",
        hooks: [{ type: "command", command }],
      });
    }
  }

  if (Object.keys(hooks).length) out.hooks = hooks;
  else delete out.hooks;

  // Manage exactly one env key.
  const env = { ...(out.env && typeof out.env === "object" ? out.env : {}) };
  if (args.remove) {
    delete env[HOME_ENV_KEY];
  } else if (args.home) {
    env[HOME_ENV_KEY] = args.home;
  }
  if (Object.keys(env).length) out.env = env;
  else delete out.env;

  return { settings: out, command };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.settings) {
    process.stderr.write("register-hook: --settings <path> is required\n");
    process.exit(2);
  }
  if (!args.remove && (!args.hook || !args.node)) {
    process.stderr.write("register-hook: --hook and --node are required when adding\n");
    process.exit(2);
  }

  let existing;
  try {
    existing = readSettings(args.settings);
  } catch (error) {
    process.stderr.write(`register-hook: ${error.message}\n`);
    process.exit(1);
    return;
  }

  const { settings, command } = merge(existing, args);
  const serialized = `${JSON.stringify(settings, null, 2)}\n`;

  const summaryTarget = settings.hooks && settings.hooks.UserPromptSubmit
    ? JSON.stringify(settings.hooks.UserPromptSubmit, null, 2)
    : "(none)";

  if (args.dryRun) {
    process.stdout.write("--- MyOS Dispatch hook merge (dry run) ---\n");
    process.stdout.write(`settings: ${args.settings}\n`);
    process.stdout.write(args.remove ? "action: REMOVE hook + env key\n" : "action: ADD/UPDATE hook\n");
    if (!args.remove) process.stdout.write(`command: ${command}\n`);
    process.stdout.write(`UserPromptSubmit after merge:\n${summaryTarget}\n`);
    return;
  }

  fs.mkdirSync(path.dirname(args.settings), { recursive: true });
  fs.writeFileSync(args.settings, serialized, "utf8");
  process.stdout.write(
    args.remove
      ? `register-hook: removed MyOS Dispatch hook from ${args.settings}\n`
      : `register-hook: merged MyOS Dispatch hook into ${args.settings}\n`
  );
}

if (require.main === module) {
  main();
}

module.exports = { merge, readSettings, buildCommand, MARKER, HOME_ENV_KEY };

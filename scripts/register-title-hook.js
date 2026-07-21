#!/usr/bin/env node
"use strict";

// register-title-hook.js — defensively merge the MyOS Dispatch shell-title
// hook (bin/myos-title-hook) into a Claude Code settings.json using node
// (no jq, for portability). Mirrors register-hook.js's safety contract
// exactly; kept as a separate script/marker so the two hooks can be
// installed, updated, or removed independently.
//
// SAFETY CONTRACT (same as register-hook.js):
//   - NEVER overwrites the file. Reads existing JSON, mutates only the
//     `hooks` object, and writes the result back.
//   - IDEMPOTENT: existing myos-title-hook entries (identified by the
//     stable marker in the command string) are stripped before re-adding,
//     so re-running never duplicates.
//   - PRESERVES every unrelated key (model, theme, permissions, other
//     hooks including the dispatch hook, env vars).
//   - Registers under BOTH SessionStart and Stop (one hook binary,
//     branches on hook_event_name at runtime).
//   - --dry-run prints the planned result without writing.
//   - --remove strips both hook entries (reversible uninstall).
//
// Usage:
//   node scripts/register-title-hook.js --settings <path> --node <nodePath> \
//        --hook <hookPath> [--dry-run] [--remove]

const fs = require("node:fs");
const path = require("node:path");

const MARKER = "myos-title-hook"; // stable substring present in our command
// Precise match for OUR hook only: the hook binary (optionally .js) as a
// whole path segment. The char before the marker must be a path/quote/
// whitespace boundary, and the char after must be a quote/whitespace/end
// boundary — so a foreign command that merely contains this substring
// (e.g. a wrapper script name) never matches.
const MARKER_RE = /(^|[/\\"'\s])myos-title-hook(\.js)?["'\s]*$/;
const EVENTS = ["SessionStart", "Stop"];

function parseArgs(argv) {
  const args = { settings: "", node: "node", hook: "", dryRun: false, remove: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const take = () => argv[++i] || "";
    if (a === "--settings") args.settings = take();
    else if (a === "--node") args.node = take();
    else if (a === "--hook") args.hook = take();
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
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function buildCommand(nodePath, hookPath) {
  return `${quote(nodePath)} ${quote(hookPath)}`;
}

function isOurHookEntry(entry) {
  return entry
    && typeof entry === "object"
    && typeof entry.command === "string"
    && MARKER_RE.test(entry.command);
}

function describeShape(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

// Same B1 fail-safe as register-hook.js: refuse rather than risk silently
// dropping a user's foreign hooks if `hooks` isn't the shape we expect.
function validateHooksShape(hooks) {
  if (hooks === undefined) return;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error(
      `Refusing to touch settings.json: unexpected 'hooks' shape (expected a plain object, got ${describeShape(hooks)}). No changes made.`
    );
  }
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) {
      throw new Error(
        `Refusing to touch settings.json: unexpected 'hooks' shape (event '${event}' is ${describeShape(value)}, expected an array). No changes made.`
      );
    }
  }
}

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
  const command = buildCommand(args.node, args.hook);

  validateHooksShape(out.hooks);

  let hooks = stripAll(out.hooks || {});

  if (!args.remove) {
    for (const event of EVENTS) {
      addToEvent(hooks, event, {
        matcher: "",
        hooks: [{ type: "command", command, timeout: 5 }],
      });
    }
  }

  if (Object.keys(hooks).length) out.hooks = hooks;
  else delete out.hooks;

  return { settings: out, command };
}

function backupTimestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function backupExisting(settingsPath) {
  if (!fs.existsSync(settingsPath)) return null;
  let bak = `${settingsPath}.bak-${backupTimestamp()}`;
  if (fs.existsSync(bak)) {
    let i = 1;
    while (fs.existsSync(`${bak}-${i}`)) i += 1;
    bak = `${bak}-${i}`;
  }
  fs.copyFileSync(settingsPath, bak);
  return bak;
}

function atomicWrite(settingsPath, content) {
  const dir = path.dirname(settingsPath);
  const tmp = path.join(dir, `.${path.basename(settingsPath)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, content, "utf8");
  try {
    fs.renameSync(tmp, settingsPath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* best effort cleanup */ }
    throw error;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.settings) {
    process.stderr.write("register-title-hook: --settings <path> is required\n");
    process.exit(2);
  }
  if (!args.remove && (!args.hook || !args.node)) {
    process.stderr.write("register-title-hook: --hook and --node are required when adding\n");
    process.exit(2);
  }

  let existing;
  try {
    existing = readSettings(args.settings);
  } catch (error) {
    process.stderr.write(`register-title-hook: ${error.message}\n`);
    process.exit(1);
    return;
  }

  let settings;
  let command;
  try {
    ({ settings, command } = merge(existing, args));
  } catch (error) {
    process.stderr.write(`register-title-hook: ${error.message}\n`);
    process.exit(1);
    return;
  }
  const serialized = `${JSON.stringify(settings, null, 2)}\n`;

  if (args.dryRun) {
    process.stdout.write("--- MyOS Dispatch title-hook merge (dry run) ---\n");
    process.stdout.write(`settings: ${args.settings}\n`);
    process.stdout.write(args.remove ? "action: REMOVE hooks\n" : "action: ADD/UPDATE hooks\n");
    if (!args.remove) process.stdout.write(`command: ${command}\n`);
    for (const event of EVENTS) {
      const groups = (settings.hooks && settings.hooks[event]) || [];
      process.stdout.write(`${event} after merge:\n${JSON.stringify(groups, null, 2)}\n`);
    }
    return;
  }

  fs.mkdirSync(path.dirname(args.settings), { recursive: true });
  const bak = backupExisting(args.settings);
  if (bak) process.stdout.write(`register-title-hook: backed up ${args.settings} -> ${bak}\n`);
  atomicWrite(args.settings, serialized);
  process.stdout.write(
    args.remove
      ? `register-title-hook: removed myos-title-hook from ${args.settings}\n`
      : `register-title-hook: merged myos-title-hook (SessionStart + Stop) into ${args.settings}\n`
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  merge,
  readSettings,
  buildCommand,
  validateHooksShape,
  isOurHookEntry,
  MARKER,
  MARKER_RE,
  EVENTS,
};

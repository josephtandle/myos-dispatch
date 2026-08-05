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
const os = require("node:os");

// Directories the OS may reap out from under us. A hook binary here dies
// silently; a settings.json here is a throwaway sandbox.
const EPHEMERAL_ROOTS = [
  os.tmpdir(),
  "/tmp",
  "/private/tmp",
  "/var/folders",
  "/private/var/folders",
];

function isEphemeralPath(candidate) {
  const resolved = path.resolve(candidate);
  return EPHEMERAL_ROOTS.some((root) => {
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

const MARKER = "myos-dispatch-hook"; // stable substring present in our command
// Precise match for OUR hook only: the hook binary (optionally .js) immediately
// followed by our --surface flag. This avoids false-positive matches against a
// foreign command that merely CONTAINS the substring "myos-dispatch-hook"
// (e.g. ".../my-wrapper-for-myos-dispatch-hook-logging.sh"). The char before the
// marker must be a path/quote/whitespace boundary, and the char(s) after (before
// --surface) must be quote/whitespace — so a hyphenated wrapper name never matches.
const MARKER_RE = /(^|[/\\"'\s])myos-dispatch-hook(\.js)?["'\s]+--surface\b/;
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
    allowEphemeralHook: false,
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
    else if (a === "--allow-ephemeral-hook") args.allowEphemeralHook = true;
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
    && MARKER_RE.test(entry.command);
}

// Human-readable description of an unexpected value, for error messages.
function describeShape(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

// B1 fail-safe: before ANY add or remove, prove the `hooks` block has the shape
// we know how to safely edit. `hooks` must be absent OR a plain object whose
// every event value is an array. Anything else (array/string/null hooks, or a
// non-array event value) means a schema we don't understand — refuse rather than
// risk silently dropping a user's foreign hooks. Throws; caller exits 1 without
// rewriting the file.
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

  // B1: fail-safe on unexpected `hooks` shape BEFORE any add or remove. Applies
  // to both code paths (add and --remove) since both flow through here.
  validateHooksShape(out.hooks);

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

// Timestamp for backup filenames: YYYYMMDD-HHMMSS (matches installer convention).
function backupTimestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// B2: always back up an existing settings file before we write over it (add AND
// remove). Returns the backup path, or null if there was nothing to back up. If
// a backup with this second-granular name already exists, disambiguate so we
// never clobber a prior backup.
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

// Atomic write: write to a temp file in the same directory, then rename onto the
// target. rename is atomic on the same filesystem, so a crash or full disk can
// never leave a half-written / truncated settings.json.
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
    process.stderr.write("register-hook: --settings <path> is required\n");
    process.exit(2);
  }
  if (!args.remove && (!args.hook || !args.node)) {
    process.stderr.write("register-hook: --hook and --node are required when adding\n");
    process.exit(2);
  }

  // Ephemeral-path guards. Both keyed off the hook living somewhere the OS
  // will reap; B3 (fatal) is checked before B2 (overridable).
  if (!args.remove && isEphemeralPath(args.hook)) {
    const resolvedHook = path.resolve(args.hook);

    // B3: an ephemeral hook may ONLY ever be written into an ephemeral
    // settings.json. --allow-ephemeral-hook does not excuse this case.
    //
    // Rehearsing an install inside a fake HOME is legitimate, and such a
    // rehearsal genuinely needs an ephemeral hook path -- so B2 below is
    // overridable. What is never legitimate is a sandboxed rehearsal writing
    // that throwaway path into the operator's REAL settings.json. That
    // combination is always a mistake, so it fails closed with no escape hatch.
    //
    // Real incident 2026-08-05 13:47-15:15: an install-rehearsal harness ran
    // seven times from fresh mktemp dirs, each run pointing the live
    // ~/.claude/settings.json at its own soon-to-be-reaped clone (and dropping
    // the PreToolUse hook on the way). Dispatch routing was dead for ~2h and
    // would have stayed dead until the 08:15 guard the next morning.
    //
    // Deliberately NOT keyed off os.homedir(): a harness that exports a fake
    // HOME would slip straight past that. "Is the settings target durable?" is
    // the property that actually matters, and it holds whatever HOME says.
    if (!isEphemeralPath(args.settings)) {
      process.stderr.write(
        `register-hook: refusing to point a durable settings.json at an ephemeral hook:\n` +
        `  settings: ${path.resolve(args.settings)}\n` +
        `  hook:     ${resolvedHook}\n` +
        `The hook path will be reaped by the OS, silently killing dispatch routing\n` +
        `for every session using these settings. If this is an install rehearsal,\n` +
        `point --settings at your sandbox instead of the live file. There is no\n` +
        `override for this case.\n`
      );
      process.exit(1);
      return;
    }

    // B2: refuse to register a hook binary that lives in an ephemeral directory.
    //
    // install.sh computes the hook path from its own location
    // (REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"). Run the installer from a
    // throwaway clone -- `curl | bash`, an agent testing an upgrade, a CI
    // scratch dir -- and it happily writes that mktemp path into settings.json.
    // The OS reaps the directory, and from then on EVERY session silently loses
    // dispatch routing, because a missing hook binary fails open with no error.
    //
    // Real incident 2026-08-03 16:06: hook pointed at
    // /var/folders/.../T/tmp.ELbp1SciY0/h/bin/myos-dispatch-hook. Undetected
    // until the 08:15 guard run the next morning. Fail closed here instead.
    //
    // Deliberately NOT an existence check: install.sh legitimately registers
    // before the binary is in place, and the test suite uses a plausible-but-
    // absent path. Only ephemerality is disqualifying.
    if (!args.allowEphemeralHook) {
      process.stderr.write(
        `register-hook: refusing to register a hook inside a temporary directory:\n` +
        `  ${resolvedHook}\n` +
        `This path will be reaped by the OS and dispatch routing would fail open\n` +
        `silently. Install from a permanent checkout (e.g. ~/myos-dispatch) and\n` +
        `re-run. Override only if you know the directory is durable:\n` +
        `  --allow-ephemeral-hook\n`
      );
      process.exit(1);
      return;
    }
  }

  let existing;
  try {
    existing = readSettings(args.settings);
  } catch (error) {
    process.stderr.write(`register-hook: ${error.message}\n`);
    process.exit(1);
    return;
  }

  let settings;
  let command;
  try {
    ({ settings, command } = merge(existing, args));
  } catch (error) {
    // B1 validation failure (or any merge failure) — refuse, do not rewrite.
    process.stderr.write(`register-hook: ${error.message}\n`);
    process.exit(1);
    return;
  }
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
  // B2: back up any existing file before the write (add AND remove).
  const bak = backupExisting(args.settings);
  if (bak) process.stdout.write(`register-hook: backed up ${args.settings} -> ${bak}\n`);
  atomicWrite(args.settings, serialized);
  process.stdout.write(
    args.remove
      ? `register-hook: removed MyOS Dispatch hook from ${args.settings}\n`
      : `register-hook: merged MyOS Dispatch hook into ${args.settings}\n`
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
  HOME_ENV_KEY,
};

"use strict";

// Adversarial safety matrix for scripts/register-rabbithole-hook.js.
//
// #1 rule: NEVER corrupt or silently drop a user's existing settings.json.
// Every case runs the script as a real subprocess against a settings.json
// inside a throwaway mktemp sandbox (never the real ~/.claude), and asserts
// the exact outcome — including byte-identity when the tool must refuse.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "register-rabbithole-hook.js");
const HOOK = "/opt/myos-dispatch/bin/myos-rabbithole-hook";
const NODE = process.execPath;

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rrh-home-"));
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  return { home, settings: path.join(claudeDir, "settings.json") };
}

function runReg(extraArgs) {
  const base = ["--node", NODE, "--hook", HOOK];
  const res = spawnSync(NODE, [SCRIPT, ...base, ...extraArgs], { encoding: "utf8" });
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

function add(settings, extra = []) {
  return runReg(["--settings", settings, ...extra]);
}

function remove(settings) {
  return runReg(["--settings", settings, "--remove"]);
}

function read(settings) {
  return fs.readFileSync(settings, "utf8");
}

function countOurHooks(parsed) {
  const { isOurHookEntry } = require("../scripts/register-rabbithole-hook.js");
  let n = 0;
  const hooks = parsed.hooks || {};
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (g && Array.isArray(g.hooks)) n += g.hooks.filter(isOurHookEntry).length;
    }
  }
  return n;
}

test("(a) file absent -> minimal valid file created with our hook", () => {
  const { settings } = sandbox();
  fs.rmSync(settings, { force: true });
  const r = add(settings);
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(read(settings));
  assert.strictEqual(countOurHooks(parsed), 1);
  assert.ok(parsed.hooks.UserPromptSubmit);
});

test("(b) empty file -> same as absent", () => {
  const { settings } = sandbox();
  fs.writeFileSync(settings, "", "utf8");
  const r = add(settings);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(countOurHooks(JSON.parse(read(settings))), 1);
});

test("(c) malformed JSON -> REFUSES, exit 1, file byte-identical", () => {
  const { settings } = sandbox();
  const original = "{ this is : not valid json ]]";
  fs.writeFileSync(settings, original, "utf8");
  const r = add(settings);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(read(settings), original);
});

test("(d) hooks as ARRAY -> REFUSES exit1, file UNCHANGED (B1)", () => {
  const { settings } = sandbox();
  const original = JSON.stringify({ hooks: [{ command: "foreign" }] }, null, 2) + "\n";
  fs.writeFileSync(settings, original, "utf8");
  const rAdd = add(settings);
  assert.strictEqual(rAdd.status, 1);
  assert.strictEqual(read(settings), original);
  const rRem = remove(settings);
  assert.strictEqual(rRem.status, 1);
  assert.strictEqual(read(settings), original);
});

test("(e) coexists with the dispatch hook AND the shell-title hook on the same UserPromptSubmit event", () => {
  const { settings } = sandbox();
  const foreign = {
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "/opt/myos-dispatch/bin/myos-dispatch-hook --surface=claude" }] },
      ],
    },
  };
  fs.writeFileSync(settings, JSON.stringify(foreign, null, 2), "utf8");
  const r = add(settings);
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(read(settings));
  const cmds = parsed.hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(cmds.some((c) => c.includes("myos-dispatch-hook")), "dispatch hook preserved");
  assert.ok(cmds.some((c) => c.includes("myos-rabbithole-hook")), "our hook added");
  assert.strictEqual(countOurHooks(parsed), 1);
});

test("(f) run add twice -> no duplicate", () => {
  const { settings } = sandbox();
  fs.rmSync(settings, { force: true });
  assert.strictEqual(add(settings).status, 0);
  assert.strictEqual(add(settings).status, 0);
  assert.strictEqual(countOurHooks(JSON.parse(read(settings))), 1);
});

test("(g) model/theme/permissions preserved through add and remove", () => {
  const { settings } = sandbox();
  const original = {
    model: "sonnet",
    theme: "light",
    permissions: { allow: ["Bash(git status)"], deny: [] },
  };
  fs.writeFileSync(settings, JSON.stringify(original, null, 2), "utf8");
  assert.strictEqual(add(settings).status, 0);
  const parsed = JSON.parse(read(settings));
  assert.strictEqual(parsed.model, "sonnet");
  assert.deepStrictEqual(parsed.permissions, { allow: ["Bash(git status)"], deny: [] });

  const rr = remove(settings);
  assert.strictEqual(rr.status, 0, rr.stderr);
  const after = JSON.parse(read(settings));
  assert.strictEqual(after.model, "sonnet");
  assert.strictEqual(countOurHooks(after), 0);
});

test("(h) --remove preserves a foreign hook whose command merely CONTAINS the marker substring", () => {
  const { settings } = sandbox();
  const loggingWrapper = "/usr/local/bin/my-wrapper-for-myos-rabbithole-hook-logging.sh --verbose";
  const original = {
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: loggingWrapper }] }] },
  };
  fs.writeFileSync(settings, JSON.stringify(original, null, 2), "utf8");
  const r = remove(settings);
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(read(settings));
  const cmds = parsed.hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(cmds.includes(loggingWrapper));
});

test("(i) --remove creates a backup file first", () => {
  const { settings } = sandbox();
  assert.strictEqual(add(settings).status, 0);
  for (const f of fs.readdirSync(path.dirname(settings))) {
    if (f.includes(".bak-")) fs.rmSync(path.join(path.dirname(settings), f));
  }
  const r = remove(settings);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /backed up .* -> .*\.bak-/);
  const baks = fs.readdirSync(path.dirname(settings)).filter((f) => f.includes(".bak-"));
  assert.ok(baks.length >= 1);
});

test("tighter marker: our real command matches, logging-wrapper does not", () => {
  const { isOurHookEntry, buildCommand } = require("../scripts/register-rabbithole-hook.js");
  const ours = buildCommand(NODE, HOOK);
  assert.ok(isOurHookEntry({ command: ours }));
  assert.ok(
    !isOurHookEntry({ command: "/usr/local/bin/my-wrapper-for-myos-rabbithole-hook-logging.sh --verbose" })
  );
});

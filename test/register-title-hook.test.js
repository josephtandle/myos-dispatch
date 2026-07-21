"use strict";

// Adversarial safety matrix for scripts/register-title-hook.js.
//
// #1 rule: NEVER corrupt or silently drop a user's existing settings.json.
// Every case runs register-title-hook.js as a real subprocess against a
// settings.json inside a throwaway mktemp sandbox (never the real
// ~/.claude), and asserts the exact outcome — including byte-identity when
// the tool must refuse.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "register-title-hook.js");
const HOOK = "/opt/myos-dispatch/bin/myos-title-hook";
const NODE = process.execPath;

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rth-home-"));
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

// Count our hook entries across every event/group in a parsed settings object.
function countOurHooks(parsed) {
  const { isOurHookEntry } = require("../scripts/register-title-hook.js");
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

test("(a) file absent -> minimal valid file created with our hook on BOTH events", () => {
  const { settings } = sandbox();
  fs.rmSync(settings, { force: true });
  assert.ok(!fs.existsSync(settings));
  const r = add(settings);
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(read(settings));
  assert.strictEqual(countOurHooks(parsed), 2, "one entry each under SessionStart and Stop");
  assert.ok(parsed.hooks.SessionStart);
  assert.ok(parsed.hooks.Stop);
});

test("(b) empty file -> same as absent", () => {
  const { settings } = sandbox();
  fs.writeFileSync(settings, "", "utf8");
  const r = add(settings);
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(read(settings));
  assert.strictEqual(countOurHooks(parsed), 2);
});

test("(c) malformed JSON -> REFUSES, exit 1, file byte-identical", () => {
  const { settings } = sandbox();
  const original = "{ this is : not valid json ]]";
  fs.writeFileSync(settings, original, "utf8");
  const r = add(settings);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(read(settings), original, "malformed file must be untouched");
});

test("(d) no hooks key -> hooks added, other keys kept", () => {
  const { settings } = sandbox();
  fs.writeFileSync(settings, JSON.stringify({ model: "opus", theme: "dark" }), "utf8");
  const r = add(settings);
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(read(settings));
  assert.strictEqual(parsed.model, "opus");
  assert.strictEqual(parsed.theme, "dark");
  assert.strictEqual(countOurHooks(parsed), 2);
});

test("(e) hooks as ARRAY -> REFUSES exit1, file UNCHANGED (B1)", () => {
  const { settings } = sandbox();
  const original = JSON.stringify({ hooks: [{ command: "foreign" }] }, null, 2) + "\n";
  fs.writeFileSync(settings, original, "utf8");

  const rAdd = add(settings);
  assert.strictEqual(rAdd.status, 1, "add must refuse");
  assert.match(rAdd.stderr, /unexpected 'hooks' shape/);
  assert.strictEqual(read(settings), original, "add must not touch the file");

  const rRem = remove(settings);
  assert.strictEqual(rRem.status, 1, "remove must refuse");
  assert.strictEqual(read(settings), original, "remove must not touch the file");
});

test("(f) event value as OBJECT or STRING -> REFUSES exit1, unchanged", () => {
  for (const bad of [{ Stop: { command: "x" } }, { Stop: "run-me" }]) {
    const { settings } = sandbox();
    const original = JSON.stringify({ hooks: bad }, null, 2) + "\n";
    fs.writeFileSync(settings, original, "utf8");

    const rAdd = add(settings);
    assert.strictEqual(rAdd.status, 1);
    assert.match(rAdd.stderr, /unexpected 'hooks' shape/);
    assert.strictEqual(read(settings), original);

    const rRem = remove(settings);
    assert.strictEqual(rRem.status, 1);
    assert.strictEqual(read(settings), original);
  }
});

test("(g) foreign UserPromptSubmit hook (the dispatch hook) and other events fully preserved", () => {
  const { settings } = sandbox();
  const foreign = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "/opt/myos-dispatch/bin/myos-dispatch-hook --surface=claude" }] }],
      PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "/usr/local/bin/foreign-post.sh" }] }],
      SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "/usr/local/bin/foreign-session-start.sh" }] }],
    },
  };
  fs.writeFileSync(settings, JSON.stringify(foreign, null, 2), "utf8");
  const r = add(settings);
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(read(settings));

  const upsCommands = parsed.hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(upsCommands.includes("/opt/myos-dispatch/bin/myos-dispatch-hook --surface=claude"), "dispatch hook preserved");
  assert.ok(parsed.hooks.PostToolUse, "PostToolUse group preserved");
  assert.strictEqual(parsed.hooks.PostToolUse[0].hooks[0].command, "/usr/local/bin/foreign-post.sh");

  const sessionStartCommands = parsed.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(sessionStartCommands.includes("/usr/local/bin/foreign-session-start.sh"), "foreign SessionStart entry preserved alongside ours");
  assert.strictEqual(countOurHooks(parsed), 2, "our hook added exactly once per event");
});

test("(h) run add twice -> no duplicate", () => {
  const { settings } = sandbox();
  fs.rmSync(settings, { force: true });
  assert.strictEqual(add(settings).status, 0);
  assert.strictEqual(add(settings).status, 0);
  const parsed = JSON.parse(read(settings));
  assert.strictEqual(countOurHooks(parsed), 2, "second add must not duplicate");
});

test("(i) model/theme/permissions/env keys all preserved, removal restores cleanly", () => {
  const { settings } = sandbox();
  const original = {
    model: "sonnet",
    theme: "light",
    permissions: { allow: ["Bash(git status)"], deny: [] },
    env: { FOO: "bar" },
  };
  fs.writeFileSync(settings, JSON.stringify(original, null, 2), "utf8");
  const r = add(settings);
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(read(settings));
  assert.strictEqual(parsed.model, "sonnet");
  assert.strictEqual(parsed.theme, "light");
  assert.deepStrictEqual(parsed.permissions, { allow: ["Bash(git status)"], deny: [] });
  assert.strictEqual(parsed.env.FOO, "bar", "unrelated env key preserved");
  assert.strictEqual(countOurHooks(parsed), 2);

  const rr = remove(settings);
  assert.strictEqual(rr.status, 0, rr.stderr);
  const after = JSON.parse(read(settings));
  assert.strictEqual(after.env.FOO, "bar");
  assert.strictEqual(after.model, "sonnet");
  assert.strictEqual(countOurHooks(after), 0);
});

test("(j) --remove preserves a foreign hook whose command merely CONTAINS the marker substring", () => {
  const { settings } = sandbox();
  const loggingWrapper = "/usr/local/bin/my-wrapper-for-myos-title-hook-logging.sh --verbose";
  const original = {
    hooks: {
      Stop: [
        { matcher: "", hooks: [{ type: "command", command: loggingWrapper }] },
      ],
    },
  };
  fs.writeFileSync(settings, JSON.stringify(original, null, 2), "utf8");
  const r = remove(settings);
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(read(settings));
  const cmds = parsed.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(cmds.includes(loggingWrapper), "logging-wrapper hook must survive removal (tighter marker)");
});

test("(k) --remove creates a backup file first", () => {
  const { settings } = sandbox();
  assert.strictEqual(add(settings).status, 0);
  for (const f of fs.readdirSync(path.dirname(settings))) {
    if (f.includes(".bak-")) fs.rmSync(path.join(path.dirname(settings), f));
  }
  const r = remove(settings);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /backed up .* -> .*\.bak-/, "remove must announce a backup");
  const baks = fs.readdirSync(path.dirname(settings)).filter((f) => f.includes(".bak-"));
  assert.ok(baks.length >= 1, "a backup file must exist after remove");
});

test("tighter marker: our real command matches, logging-wrapper does not", () => {
  const { isOurHookEntry, buildCommand } = require("../scripts/register-title-hook.js");
  const ours = buildCommand(NODE, HOOK);
  assert.ok(isOurHookEntry({ command: ours }), "our built command must match");
  assert.ok(
    !isOurHookEntry({ command: "/usr/local/bin/my-wrapper-for-myos-title-hook-logging.sh --verbose" }),
    "hyphenated wrapper name must NOT match"
  );
});

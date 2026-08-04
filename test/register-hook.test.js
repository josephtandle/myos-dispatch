"use strict";

// Adversarial safety matrix for scripts/register-hook.js.
//
// #1 rule: NEVER corrupt or silently drop a user's existing settings.json.
// Every case runs register-hook.js as a real subprocess against a settings.json
// inside a throwaway mktemp sandbox (never the real ~/.claude), and asserts the
// exact outcome — including byte-identity when the tool must refuse.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "register-hook.js");
// A plausible hook path; it need not exist for register-hook to build the command.
const HOOK = "/opt/myos-dispatch/bin/myos-dispatch-hook";
const NODE = process.execPath;

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rh-home-"));
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  return { home, settings: path.join(claudeDir, "settings.json") };
}

function runReg(extraArgs) {
  const base = ["--node", NODE, "--hook", HOOK, "--home", "/home/testroot", "--surface", "claude"];
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
  const { isOurHookEntry } = require("../scripts/register-hook.js");
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
  assert.ok(!fs.existsSync(settings));
  const r = add(settings);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(settings));
  const parsed = JSON.parse(read(settings));
  assert.strictEqual(countOurHooks(parsed), 1);
  assert.ok(parsed.hooks.UserPromptSubmit);
});

test("(b) empty file -> same as absent", () => {
  const { settings } = sandbox();
  fs.writeFileSync(settings, "", "utf8");
  const r = add(settings);
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(read(settings));
  assert.strictEqual(countOurHooks(parsed), 1);
});

test("(c) malformed JSON -> REFUSES, exit 1, file byte-identical", () => {
  const { settings } = sandbox();
  const original = '{ this is : not valid json ]]';
  fs.writeFileSync(settings, original, "utf8");
  const r = add(settings);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(read(settings), original, "malformed file must be untouched");
});

test("(d) no hooks key -> hook added, other keys kept", () => {
  const { settings } = sandbox();
  fs.writeFileSync(settings, JSON.stringify({ model: "opus", theme: "dark" }), "utf8");
  const r = add(settings);
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(read(settings));
  assert.strictEqual(parsed.model, "opus");
  assert.strictEqual(parsed.theme, "dark");
  assert.strictEqual(countOurHooks(parsed), 1);
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
  for (const bad of [{ UserPromptSubmit: { command: "x" } }, { UserPromptSubmit: "run-me" }]) {
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

test("(g) foreign UserPromptSubmit + PostToolUse groups preserved, our hook added", () => {
  const { settings } = sandbox();
  const foreign = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "/usr/local/bin/foreign-ups.sh" }] }],
      PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "/usr/local/bin/foreign-post.sh" }] }],
    },
  };
  fs.writeFileSync(settings, JSON.stringify(foreign, null, 2), "utf8");
  const r = add(settings);
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(read(settings));

  const upsCommands = parsed.hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(upsCommands.includes("/usr/local/bin/foreign-ups.sh"), "foreign UPS hook preserved");
  assert.ok(parsed.hooks.PostToolUse, "PostToolUse group preserved");
  assert.strictEqual(parsed.hooks.PostToolUse[0].hooks[0].command, "/usr/local/bin/foreign-post.sh");
  assert.strictEqual(countOurHooks(parsed), 1, "our hook added exactly once");
});

test("(h) run add twice -> no duplicate", () => {
  const { settings } = sandbox();
  fs.rmSync(settings, { force: true });
  assert.strictEqual(add(settings).status, 0);
  assert.strictEqual(add(settings).status, 0);
  const parsed = JSON.parse(read(settings));
  assert.strictEqual(countOurHooks(parsed), 1, "second add must not duplicate");
});

test("(i) model/theme/permissions/env keys all preserved", () => {
  const { settings } = sandbox();
  const original = {
    model: "sonnet",
    theme: "light",
    permissions: { allow: ["Bash(git status)"], deny: [] },
    env: { FOO: "bar", MYOS_HOME_ROOT: "/old" },
  };
  fs.writeFileSync(settings, JSON.stringify(original, null, 2), "utf8");
  const r = add(settings);
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(read(settings));
  assert.strictEqual(parsed.model, "sonnet");
  assert.strictEqual(parsed.theme, "light");
  assert.deepStrictEqual(parsed.permissions, { allow: ["Bash(git status)"], deny: [] });
  assert.strictEqual(parsed.env.FOO, "bar", "unrelated env key preserved");
  assert.strictEqual(parsed.env.MYOS_HOME_ROOT, "/home/testroot", "our env key set");
  assert.strictEqual(countOurHooks(parsed), 1);

  // And removal restores env without dropping FOO.
  const rr = remove(settings);
  assert.strictEqual(rr.status, 0, rr.stderr);
  const after = JSON.parse(read(settings));
  assert.strictEqual(after.env.FOO, "bar");
  assert.ok(!("MYOS_HOME_ROOT" in after.env), "our env key removed");
  assert.strictEqual(after.model, "sonnet");
});

test("(j) --remove preserves a foreign hook whose command merely CONTAINS the marker substring", () => {
  const { settings } = sandbox();
  const loggingWrapper = "/usr/local/bin/my-wrapper-for-myos-dispatch-hook-logging.sh --surface=claude";
  const original = {
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: loggingWrapper }] },
      ],
    },
  };
  fs.writeFileSync(settings, JSON.stringify(original, null, 2), "utf8");
  const r = remove(settings);
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(read(settings));
  const cmds = parsed.hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(cmds.includes(loggingWrapper), "logging-wrapper hook must survive removal (tighter marker)");
});

test("(k) --remove creates a backup file first", () => {
  const { settings } = sandbox();
  // Seed with a real, matching hook so remove has something to strip.
  assert.strictEqual(add(settings).status, 0);
  // Clear any add-time backups so we assert the remove-time backup specifically.
  for (const f of fs.readdirSync(path.dirname(settings))) {
    if (f.includes(".bak-")) fs.rmSync(path.join(path.dirname(settings), f));
  }
  const r = remove(settings);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /backed up .* -> .*\.bak-/, "remove must announce a backup");
  const baks = fs.readdirSync(path.dirname(settings)).filter((f) => f.includes(".bak-"));
  assert.ok(baks.length >= 1, "a backup file must exist after remove");
});

// (l) Regression for the 2026-08-03 incident: install.sh derives the hook path
// from its own location, so running it out of a throwaway clone wrote a
// /var/folders/.../tmp.XXXX path into the real settings.json. The OS reaped the
// directory and every session silently lost dispatch routing — a missing hook
// binary fails open with no error. Ephemeral hook paths must be refused.
test("(l) hook path inside a temp dir -> REFUSES exit1, file UNCHANGED", () => {
  const { settings } = sandbox();
  // Establish a good, known-permanent registration first.
  add(settings);
  const before = read(settings);

  const tmpHook = path.join(os.tmpdir(), "tmp.FAKE1234", "h", "bin", "myos-dispatch-hook");
  const res = spawnSync(
    NODE,
    [SCRIPT, "--settings", settings, "--node", NODE, "--hook", tmpHook,
     "--home", "/home/testroot", "--surface", "claude"],
    { encoding: "utf8" }
  );

  assert.strictEqual(res.status, 1, "must exit 1 on an ephemeral hook path");
  assert.match(res.stderr, /temporary directory/i);
  assert.strictEqual(read(settings), before, "settings.json must be untouched");
});

test("(l2) --allow-ephemeral-hook is the documented escape hatch", () => {
  const { settings } = sandbox();
  const tmpHook = path.join(os.tmpdir(), "tmp.FAKE1234", "h", "bin", "myos-dispatch-hook");
  const res = spawnSync(
    NODE,
    [SCRIPT, "--settings", settings, "--node", NODE, "--hook", tmpHook,
     "--home", "/home/testroot", "--surface", "claude", "--allow-ephemeral-hook"],
    { encoding: "utf8" }
  );
  assert.strictEqual(res.status, 0, "override must permit the write");
  assert.strictEqual(countOurHooks(JSON.parse(read(settings))), 1);
});

test("tighter marker: our real command matches, logging-wrapper does not", () => {
  const { isOurHookEntry, buildCommand } = require("../scripts/register-hook.js");
  const ours = buildCommand(NODE, HOOK, "claude");
  assert.ok(isOurHookEntry({ command: ours }), "our built command must match");
  assert.ok(
    !isOurHookEntry({ command: "/usr/local/bin/my-wrapper-for-myos-dispatch-hook-logging.sh --surface=claude" }),
    "hyphenated wrapper name must NOT match"
  );
});

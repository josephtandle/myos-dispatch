"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { gitWriteTarget, findRepoTop, claimNudge } = require("../src/git-claim-nudge");

function fixture(t) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-claim-nudge-")));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const repo = path.join(scratch, "repo");
  const env = { ...process.env, HOME: scratch, MYOS_HOME_ROOT: scratch, OPENCLAW_HOME_ROOT: scratch,
    MYOS_WORKSPACE: scratch, MYOS_WORKSPACE_ROOT: scratch, MYOS_DATA_SOURCES_CONFIG: "none",
    MYOS_DISPATCH_HOOK_LOG_DIR: path.join(scratch, "logs"), MYOS_BACKGROUND_AGENTS_ENABLED: "0",
    MYOS_AUTO_FANOUT: "0", MYOS_JEV_ENABLED: "0", MYOS_GIT_CLAIM_NUDGE: "1",
    MYOS_GIT_CLAIMS_FILE: path.join(scratch, "claims.json"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(scratch, "no-gitconfig"), GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  delete env.TYPESAFE_API_KEY;
  delete env.NODE_OPTIONS;
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[key];
  const git = (...args) => execFileSync("git", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", repo);
  const store = (claims = [], enforcedRepos = [repo]) => fs.writeFileSync(env.MYOS_GIT_CLAIMS_FILE,
    JSON.stringify({ schemaVersion: 1, enforcedRepos, claims, released: [] }));
  store();
  const options = { command: "git commit -m x", cwd: repo, sessionId: "test-session", env, stateDir: path.join(scratch, "nudge-state") };
  return { scratch, repo, env, git, store, options };
}

test("gitWriteTarget recognizes writes and ignores read-only commands and arguments", () => {
  for (const verb of ["commit", "merge", "push", "cherry-pick", "revert", "am", "rebase", "pull"]) {
    assert.deepEqual(gitWriteTarget(`git ${verb}`), { verb, dir: null });
  }
  for (const command of ["git status", "git log", "git branch", "git diff", "echo git commit",
    "git-manager start . --task x", "git tag -l", "git tag --list x", "git tag -d x",
    "git tag -ln x", "git tag --delete x", "git tag", "git tag -m message", "git checkout main",
    "git switch main", "echo 'a && git commit'"]) assert.equal(gitWriteTarget(command), null, command);
  for (const command of ["git -c a=b commit", "git -c a=b --no-pager commit", "git status; git commit",
    "false || git commit", "printf x | git commit"]) assert.equal(gitWriteTarget(command).verb, "commit", command);
  assert.deepEqual(gitWriteTarget("cd x && git commit -m y"), { verb: "commit", dir: "x" });
  assert.deepEqual(gitWriteTarget("git -C /p commit"), { verb: "commit", dir: "/p" });
  assert.deepEqual(gitWriteTarget('cd "with spaces" && git -C sub commit'), { verb: "commit", dir: "with spaces/sub" });
  assert.deepEqual(gitWriteTarget("git commit -m 'x; git push' && git push"), { verb: "commit", dir: null });
  for (const command of ["git checkout -b x", "git checkout -B x", "git switch -c x", "git switch -C x"])
    assert.ok(gitWriteTarget(command), command);
  for (const command of ["git tag v1", "git tag -a v1 -m message", "git tag v1 -mhello", "git tag v1 -Ffile"])
    assert.equal(gitWriteTarget(command).verb, "tag");
});

test("findRepoTop resolves primary repositories and linked worktrees", t => {
  const f = fixture(t);
  const nested = path.join(f.repo, "nested", "directory");
  fs.mkdirSync(nested, { recursive: true });
  assert.deepEqual(findRepoTop(nested), { top: f.repo, primary: f.repo });
  f.git("-C", f.repo, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "initial");
  const linked = path.join(f.scratch, "linked");
  f.git("-C", f.repo, "worktree", "add", "-qb", "linked", linked);
  assert.deepEqual(findRepoTop(linked), { top: linked, primary: f.repo });
  assert.match(claimNudge({ ...f.options, cwd: linked }), /\(worktree .*linked\)/);
  assert.equal(findRepoTop(f.scratch), null);
});

test("nudge is advisory and deduplicates only within a session and repo", t => {
  const f = fixture(t);
  const nudge = claimNudge(f.options);
  assert.match(nudge, /^\[MyOS git check-in\] First git commit in /);
  assert.ok(nudge.includes(`git-manager start ${f.repo} --task <slug>`));
  assert.match(nudge, /Advisory only: this command is not blocked\.$/);
  assert.equal(claimNudge(f.options), null);
  assert.ok(claimNudge({ ...f.options, sessionId: "another-session" }));
  assert.ok(claimNudge({ ...f.options, sessionId: "" }));
  assert.ok(claimNudge({ ...f.options, sessionId: "" }));
  const state = JSON.parse(fs.readFileSync(path.join(f.options.stateDir, "test-session.json")));
  assert.deepEqual(state.nudged, [f.repo]);
  assert.equal(typeof state.updatedAt, "number");
});

test("enforcement and active worktree claims are boundary-safe", t => {
  const f = fixture(t);
  const options = { ...f.options, sessionId: "" };
  f.store([], []);
  assert.equal(claimNudge(options), null);
  f.store([{ status: "active", worktree: f.repo }]);
  assert.equal(claimNudge(options), null);
  f.store([{ status: "active", worktree: f.scratch }]);
  assert.equal(claimNudge(options), null);
  f.store([{ status: "active", worktree: f.repo.slice(0, -1) }]);
  assert.ok(claimNudge(options));
  for (const status of ["released", "expired"]) {
    f.store([{ status, worktree: f.repo }]);
    assert.ok(claimNudge(options));
  }
});

test("missing, corrupt, invalid, disabled and inaccessible inputs fail open", t => {
  const f = fixture(t);
  assert.equal(claimNudge({ ...f.options, env: { ...f.env, MYOS_GIT_CLAIM_NUDGE: "0" } }), null);
  assert.equal(claimNudge({ ...f.options, command: "git status" }), null);
  fs.unlinkSync(f.env.MYOS_GIT_CLAIMS_FILE);
  assert.equal(claimNudge(f.options), null);
  for (const content of ["{broken", "null", "{}", '{"schemaVersion":2,"enforcedRepos":[],"claims":[]}']) {
    fs.writeFileSync(f.env.MYOS_GIT_CLAIMS_FILE, content);
    assert.equal(claimNudge(f.options), null);
  }
  f.store();
  assert.equal(claimNudge({ ...f.options, fsImpl: { statSync() { throw new Error("inaccessible"); } } }), null);
  assert.ok(claimNudge({ ...f.options, fsImpl: { ...fs, writeFileSync() { throw new Error("read-only state"); } } }));
});

test("default workspace store, safe state names and pruning", t => {
  const f = fixture(t);
  const defaultFile = path.join(f.scratch, "agents", "git-manager", "data", "claims.json");
  fs.mkdirSync(path.dirname(defaultFile), { recursive: true });
  fs.copyFileSync(f.env.MYOS_GIT_CLAIMS_FILE, defaultFile);
  fs.mkdirSync(f.options.stateDir);
  const stale = path.join(f.options.stateDir, "stale.json");
  fs.writeFileSync(stale, "{}");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stale, old, old);
  const env = { ...f.env };
  delete env.MYOS_GIT_CLAIMS_FILE;
  assert.ok(claimNudge({ ...f.options, env, sessionId: "../../escape" }));
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(path.join(f.scratch, "escape.json")), false);
  assert.equal(fs.readdirSync(f.options.stateDir).length, 1);
});

test("200 nudge calls average under 10 ms", t => {
  const f = fixture(t);
  const start = performance.now();
  for (let i = 0; i < 200; i++) assert.ok(claimNudge({ ...f.options, sessionId: `latency-${i}` }));
  const average = (performance.now() - start) / 200;
  t.diagnostic(`claimNudge average: ${average.toFixed(3)} ms over 200 calls`);
  assert.ok(average < 10, `average ${average} ms`);
});

test("PreToolUse adds context only, respects none, and leaves git status alone", t => {
  const f = fixture(t);
  const hook = path.resolve(__dirname, "../bin/myos-dispatch-hook");
  const run = (command, flags = [], sessionId = "t1") => execFileSync(process.execPath,
    [hook, "--surface=codex", "--context=full", ...flags], {
      env: f.env, encoding: "utf8", input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash",
        tool_input: { command }, cwd: f.repo, session_id: sessionId }),
    });
  const output = run("git commit -m x");
  const parsed = JSON.parse(output).hookSpecificOutput;
  assert.match(parsed.additionalContext, /\[MyOS git check-in\]/);
  assert.doesNotMatch(output, /permissionDecision|deny/);
  assert.equal(Object.hasOwn(parsed, "updatedInput"), false);
  assert.doesNotMatch(run("git commit -m x"), /\[MyOS git check-in\]/);
  assert.doesNotMatch(run("git status"), /\[MyOS git check-in\]/);
  // The CLI uses the first --context flag, so pass only none for this case.
  const none = execFileSync(process.execPath, [hook, "--surface=codex", "--context=none"], {
    env: f.env, encoding: "utf8", input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash",
      tool_input: { command: "git commit -m x" }, cwd: f.repo, session_id: "none-session" }),
  });
  assert.equal(none, "");
  assert.equal(fs.existsSync(path.join(f.scratch, "state", "git-claim-nudge", "none-session.json")), false);
  assert.ok(fs.existsSync(path.join(f.scratch, "state", "git-claim-nudge", "t1.json")));
});

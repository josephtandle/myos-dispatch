"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runBackgroundTask,
} = require("../src/background/background-agent-runner");

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "myos-worktree-repo-"));
  git(["init", "-q"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "MyOS Test"], repo);
  fs.mkdirSync(path.join(repo, "allowed"), { recursive: true });
  fs.writeFileSync(path.join(repo, "allowed", "seed.txt"), "seed\n", "utf8");
  git(["add", "-A"], repo);
  git(["commit", "-qm", "seed"], repo);
  return repo;
}

function taskFor(repo) {
  return {
    id: "implement-1",
    kind: "implement",
    role: "implement",
    prompt: "Add a bounded file",
    scope: repo,
    ownershipPaths: [path.join(repo, "allowed")],
    writeScope: [path.join(repo, "allowed")],
    required: true,
    mode: "workspace_write",
    executionEnvelope: {
      filesystemProfile: "isolated_git_worktree",
      networkPolicy: "disabled",
      goalMutationAllowed: false,
    },
  };
}

function optionsFor(artifactRoot, runCommand) {
  return {
    command: "codex",
    artifactRoot,
    orchestratorContext: {
      orchestrator: "myos-dispatch",
      runId: "sidecar-run-test",
      token: "sidecar-token-test",
      parentTaskId: "root",
    },
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MYOS_BACKGROUND_MIN_FREE_DISK_GIB: "0",
      CUSTOMER_SECRET: "must-not-leak",
      AWS_ACCESS_KEY_ID: "must-not-leak",
      GITHUB_PAT: "must-not-leak",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      KUBECONFIG: "/tmp/kubeconfig",
      DOCKER_CONFIG: "/tmp/docker",
      NPM_CONFIG_USERCONFIG: "/tmp/npmrc",
    },
    runCommand,
  };
}

test("writable sidecar includes new files in a durable hashed patch and leaves shared checkout clean", async () => {
  const repo = makeRepo();
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "myos-worktree-artifacts-"));
  let worktreePath;
  const result = await runBackgroundTask(taskFor(repo), optionsFor(artifacts, async ({ cwd, env, invocation }) => {
    worktreePath = cwd;
    assert.notEqual(cwd, repo);
    assert.equal(env.CUSTOMER_SECRET, undefined);
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(env.GITHUB_PAT, undefined);
    assert.equal(env.SSH_AUTH_SOCK, undefined);
    assert.equal(env.KUBECONFIG, undefined);
    assert.equal(env.DOCKER_CONFIG, undefined);
    assert.equal(env.NPM_CONFIG_USERCONFIG, undefined);
    assert.ok(invocation.args.includes("--ignore-user-config"));
    fs.writeFileSync(path.join(cwd, "allowed", "new.txt"), "new\n", "utf8");
    return { code: 0, signal: null, stdout: "done", stderr: "" };
  }));

  assert.equal(result.status, "completed", JSON.stringify(result, null, 2));
  assert.deepEqual(result.changedFiles, ["allowed/new.txt"]);
  assert.match(result.patchSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.verificationResult, "patch_reverse_check_passed");
  assert.equal(fs.existsSync(result.patchArtifact), true);
  assert.match(fs.readFileSync(result.patchArtifact, "utf8"), /new\.txt/);
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(fs.existsSync(path.join(repo, "allowed", "new.txt")), false);
  assert.equal(git(["status", "--porcelain"], repo), "");
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(artifacts, { recursive: true, force: true });
});

test("dirty repositories fail required writable sidecars without claiming implementation success", async () => {
  const repo = makeRepo();
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "myos-worktree-artifacts-"));
  fs.writeFileSync(path.join(repo, "allowed", "user-change.txt"), "uncommitted\n", "utf8");
  let invoked = false;
  const result = await runBackgroundTask(taskFor(repo), optionsFor(artifacts, async () => {
    invoked = true;
    return { code: 0, signal: null, stdout: "should not run", stderr: "" };
  }));

  assert.equal(invoked, false);
  assert.equal(result.status, "failed");
  assert.equal(result.effectiveMode, "workspace_write");
  assert.match(result.summary, /repository is dirty/);
  assert.equal(result.patchArtifact, undefined);
  assert.equal(fs.readFileSync(path.join(repo, "allowed", "user-change.txt"), "utf8"), "uncommitted\n");
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(artifacts, { recursive: true, force: true });
});

test("runner enforces writable and global orchestration switches at the execution boundary", async () => {
  for (const envOverride of [
    { MYOS_WRITABLE_SIDECARS_ENABLED: "0" },
    { MYOS_ORCHESTRATION_GOLD_ENABLED: "0" },
  ]) {
    const repo = makeRepo();
    let invoked = false;
    const result = await runBackgroundTask(taskFor(repo), {
      ...optionsFor(path.join(repo, "artifacts"), async () => {
        invoked = true;
        return { code: 0, signal: null, stdout: "", stderr: "" };
      }),
      env: {
        ...optionsFor("", async () => {}).env,
        ...envOverride,
      },
    });
    assert.equal(invoked, false);
    assert.equal(result.status, "failed");
    assert.match(result.summary, /disabled or unsafe/);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("writable sidecar fails closed on ownership escape and still removes the worktree", async () => {
  const repo = makeRepo();
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "myos-worktree-artifacts-"));
  let worktreePath;
  const result = await runBackgroundTask(taskFor(repo), optionsFor(artifacts, async ({ cwd }) => {
    worktreePath = cwd;
    fs.writeFileSync(path.join(cwd, "escape.txt"), "escape\n", "utf8");
    return { code: 0, signal: null, stdout: "done", stderr: "" };
  }));

  assert.equal(result.status, "failed");
  assert.match(result.verificationResult, /ownership_violation:escape\.txt/);
  assert.equal(result.patchArtifact, null);
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(git(["status", "--porcelain"], repo), "");
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(artifacts, { recursive: true, force: true });
});

test("runner exceptions are converted to failed results and cannot leak worktrees", async () => {
  const repo = makeRepo();
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "myos-worktree-artifacts-"));
  let worktreePath;
  const result = await runBackgroundTask(taskFor(repo), optionsFor(artifacts, async ({ cwd }) => {
    worktreePath = cwd;
    throw new Error("synthetic runner failure");
  }));

  assert.equal(result.status, "failed");
  assert.match(result.summary, /synthetic runner failure/);
  assert.equal(fs.existsSync(worktreePath), false);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(artifacts, { recursive: true, force: true });
});

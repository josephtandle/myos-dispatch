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
    callerProvider: "codex",
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
    assert.equal(invocation.args.includes("--ignore-user-config"), false);
    fs.writeFileSync(path.join(cwd, "allowed", "new.txt"), "new\n", "utf8");
    return { code: 0, signal: null, stdout: writerOutput(), stderr: "" };
  }));

  assert.equal(result.status, "needs-review", JSON.stringify(result, null, 2));
  assert.deepEqual(result.changedFiles, ["allowed/new.txt"]);
  assert.match(result.patchSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.verificationResult, "patch_reverse_check_passed");
  assert.equal(fs.existsSync(result.patchArtifact), true);
  assert.match(fs.readFileSync(result.patchArtifact, "utf8"), /new\.txt/);
  assert.equal(fs.existsSync(worktreePath), true);
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

test("writable sidecar fails closed on ownership escape and retains the worktree", async () => {
  const repo = makeRepo();
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "myos-worktree-artifacts-"));
  let worktreePath;
  const result = await runBackgroundTask(taskFor(repo), optionsFor(artifacts, async ({ cwd }) => {
    worktreePath = cwd;
    fs.writeFileSync(path.join(cwd, "escape.txt"), "escape\n", "utf8");
    return { code: 0, signal: null, stdout: writerOutput(), stderr: "" };
  }));

  assert.equal(result.status, "failed");
  assert.match(result.verificationResult, /ownership_violation:escape\.txt/);
  assert.equal(fs.existsSync(result.patchArtifact), true);
  assert.deepEqual(result.ownershipViolations, ["escape.txt"]);
  assert.equal(fs.existsSync(worktreePath), true);
  assert.equal(git(["status", "--porcelain"], repo), "");
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(artifacts, { recursive: true, force: true });
});

test("runner exceptions are converted to failed results and retain worktrees for inspection", async () => {
  const repo = makeRepo();
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "myos-worktree-artifacts-"));
  let worktreePath;
  const result = await runBackgroundTask(taskFor(repo), optionsFor(artifacts, async ({ cwd }) => {
    worktreePath = cwd;
    throw new Error("synthetic runner failure");
  }));

  assert.equal(result.status, "failed");
  assert.match(result.summary, /synthetic runner failure/);
  assert.equal(fs.existsSync(worktreePath), true);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(artifacts, { recursive: true, force: true });
});


test("explicit interactive Claude to Codex delegation preserves the exact model", () => {
  const { buildBackgroundWorkerInvocation } = require("../src/background/background-agent-runner");
  const invocation = buildBackgroundWorkerInvocation({
    mode: "workspace_write", effectiveMode: "workspace_write", model: "gpt-6-astra",
    ownershipPaths: ["src/example.js"],
  }, {
    command: "codex", callerProvider: "claude", env: {},
    delegation: { callerProvider: "claude", workerProvider: "codex", purpose: "code-write", context: "human-interactive" },
  });
  assert.equal(invocation.model, "gpt-6-astra");
  assert.equal(invocation.args.includes("--ignore-user-config"), false);
});

function writerOutput() {
  return [
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ findings: [], risks: [], checks: ["writer reports inspection"], confidence: "high" }) } },
    { type: "turn.completed", usage: {} },
  ].map(JSON.stringify).join("\n");
}

test("failed or malformed provider responses retain partial binary work and never succeed", async () => {
  for (const response of [
    { code: 0, stdout: "done" },
    { code: 0, stdout: "" },
    { code: 0, stdout: writerOutput() + '\n{"type":"turn.failed","error":{"message":"quota"}}' },
    { code: 0, stdout: '{"findings":[]}' },
    { code: 1, stdout: writerOutput(), stderr: "quota" },
    { code: null, signal: "SIGTERM", stdout: "", stderr: "timeout" },
  ]) {
    const repo = makeRepo();
    const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "myos-worktree-artifacts-"));
    const bytes = Buffer.from([0, 255, 128, 10, 1]);
    const result = await runBackgroundTask(taskFor(repo), optionsFor(artifacts, async ({ cwd }) => {
      fs.writeFileSync(path.join(cwd, "allowed", "partial.bin"), bytes);
      fs.writeFileSync(path.join(cwd, "allowed", "seed.txt"), "partial tracked\n");
      return response;
    }));
    assert.equal(result.status, "failed", JSON.stringify(response));
    assert.deepEqual(fs.readFileSync(path.join(result.worktreePath, "allowed", "partial.bin")), bytes);
    assert.match(fs.readFileSync(result.patchArtifact, "utf8"), /GIT binary patch/);
    assert.equal(require("node:crypto").createHash("sha256").update(fs.readFileSync(result.patchArtifact)).digest("hex"), result.patchSha256);
    assert.equal(git(["status", "--porcelain"], repo), "");
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(artifacts, { recursive: true, force: true });
  }
});

test("ownership is validated before invoking a writer", async () => {
  for (const paths of [[], ["../escape"], ["allowed/../../escape"], ["."], [".git/config"], ["allowed/link/new.txt"]]) {
    const repo = makeRepo();
    fs.symlinkSync(os.tmpdir(), path.join(repo, "allowed", "link"));
    git(["add", "-A"], repo);
    git(["commit", "-qm", "link fixture"], repo);
    const task = { ...taskFor(repo), ownershipPaths: paths };
    let invoked = false;
    const result = await runBackgroundTask(task, optionsFor(path.join(os.tmpdir(), "myos-path-tests"), async () => {
      invoked = true;
      return { code: 0, stdout: writerOutput() };
    }));
    assert.equal(invoked, false, JSON.stringify(paths));
    assert.equal(result.status, "failed");
    assert.match(result.summary, /ownership/);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("unreviewed orphan folders are never deleted based on age", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myos-sidecar-orphan-test-"));
  fs.writeFileSync(path.join(dir, "partial.txt"), "keep me");
  const old = new Date(Date.now() - 7 * 86400000);
  fs.utimesSync(dir, old, old);
  require("../src/background/background-agent-runner").cleanupOrphanSidecarWorktrees();
  assert.equal(fs.readFileSync(path.join(dir, "partial.txt"), "utf8"), "keep me");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("explicit delegation cannot widen default provider, context, or ownership gates", () => {
  const { buildBackgroundWorkerInvocation, resolveProviderCapabilities } = require("../src/background/background-agent-runner");
  const task = { effectiveMode: "workspace_write", model: "gpt-6-astra", ownershipPaths: ["owned.txt"] };
  const options = { command: "codex", callerProvider: "claude", env: {}, delegation: { callerProvider: "claude", workerProvider: "codex", purpose: "code-write", context: "human-interactive" } };
  for (const override of [
    { delegation: undefined }, { callerProvider: undefined }, { callerProvider: "codex" },
    { env: { MYOS_INITIATOR: "unattended" } }, { env: { MYOS_INITIATOR_OAUTH_DISABLED: "1" } },
    { env: { MYOS_INITIATOR: "bot" } }, { env: { MYOS_BACKGROUND_IS_SIDECAR: "1" } },
    { protectedSurface: true }, { projectSlug: "goldenclaw" },
    { delegation: { ...options.delegation, purpose: "research" } },
    { delegation: { ...options.delegation, workerProvider: "claude" } },
    { delegation: { ...options.delegation, context: "unattended" } },
  ]) assert.throws(() => buildBackgroundWorkerInvocation(task, { ...options, ...override }));
  assert.throws(() => buildBackgroundWorkerInvocation({ ...task, ownershipPaths: [] }, options));
  assert.throws(() => buildBackgroundWorkerInvocation({ ...task, effectiveMode: "read_only" }, options));
  assert.throws(() => buildBackgroundWorkerInvocation(task, { command: "claude", callerProvider: "claude", env: { MYOS_BACKGROUND_CLAUDE_WRITABLE: "1" } }), /Claude code authoring/);
  assert.equal(resolveProviderCapabilities("claude", { env: { MYOS_BACKGROUND_CLAUDE_WRITABLE: "1" } }).supportsWritablePatchWorktree, false);
  assert.throws(() => buildBackgroundWorkerInvocation(task, { command: "codex", env: { MYOS_BACKGROUND_ALLOW_CROSS_PROVIDER: "1" } }), /callerProvider/);
  assert.equal(buildBackgroundWorkerInvocation({ effectiveMode: "read_only" }, { command: "claude", callerProvider: "claude", env: {} }).args.includes("--bare"), false);
});

test("empty writer patches fail and artifacts cannot be redirected into the source checkout", async () => {
  const repo = makeRepo();
  let invoked = false;
  const empty = await runBackgroundTask(taskFor(repo), optionsFor(fs.mkdtempSync(path.join(os.tmpdir(), "myos-empty-test-")), async () => ({ code: 0, stdout: writerOutput() })));
  assert.equal(empty.status, "failed");
  const unsafe = await runBackgroundTask(taskFor(repo), optionsFor(path.join(repo, "artifacts"), async ({ cwd }) => {
    invoked = true;
    fs.writeFileSync(path.join(cwd, "allowed", "seed.txt"), "edit\n");
    return { code: 0, stdout: writerOutput() };
  }));
  assert.equal(invoked, false);
  assert.equal(unsafe.status, "failed");
  assert.equal(git(["status", "--porcelain"], repo), "");
});

test("artifact collection preserves the index, all bytes, and detects later tampering", async () => {
  const repo = makeRepo();
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "myos-byte-artifacts-"));
  const bytes = Buffer.from([255, 254, 10]);
  const result = await runBackgroundTask(taskFor(repo), optionsFor(artifacts, async ({ cwd }) => {
    fs.writeFileSync(path.join(cwd, "allowed", "new.dat"), bytes);
    return { code: 0, stdout: writerOutput() };
  }));
  assert.equal(result.status, "needs-review");
  assert.equal(git(["diff", "--cached", "--name-only"], result.worktreePath), "", "collector must not stage writer changes");
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "myos-byte-apply-test-"));
  git(["clone", "-q", repo, copy], repo);
  git(["apply", result.patchArtifact], copy);
  assert.deepEqual(fs.readFileSync(path.join(copy, "allowed", "new.dat")), bytes);
  const { verifyPatchArtifact } = require("../src/background/background-agent-runner");
  assert.equal(verifyPatchArtifact(result.patchArtifact, result.patchSha256), true);
  fs.appendFileSync(result.patchArtifact, "tampered");
  assert.throws(() => verifyPatchArtifact(result.patchArtifact, result.patchSha256), /hash mismatch/);
});

test("runner waits for provider termination before capturing partial work on timeout", async () => {
  const { runCommand } = require("../src/background/background-agent-runner");
  assert.equal(typeof runCommand, "function");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myos-timeout-test-"));
  const script = 'const fs=require("node:fs"); process.on("SIGTERM",()=>setTimeout(()=>{fs.writeFileSync("last.txt","preserved");process.exit(0)},80)); setInterval(()=>{},1000);';
  const result = await runCommand({ command: process.execPath, args: ["-e", script], cwd: dir, env: { PATH: process.env.PATH }, timeoutMs: 300 });
  assert.equal(result.signal, "SIGTERM");
  assert.equal(fs.readFileSync(path.join(dir, "last.txt"), "utf8"), "preserved");
});

test("writer handback appears in the parent digest without claiming review completion", () => {
  const { buildBackgroundDigest, buildWritablePrompt } = require("../src/background/background-agent-runner");
  assert.match(buildBackgroundDigest([{ taskId: "writer", status: "needs-review", summary: "patch ready" }]), /needs-review/);
  assert.match(buildWritablePrompt({ ownershipPaths: ["owned.txt"] }), /Do not commit/);
});

test("human Codex invocation pins OAuth and sandbox policy while loading host hooks", () => {
  const { buildBackgroundWorkerInvocation } = require("../src/background/background-agent-runner");
  const invocation = buildBackgroundWorkerInvocation({ effectiveMode: "workspace_write", ownershipPaths: ["owned.txt"], model: "gpt-6-astra" }, { command: "codex", callerProvider: "codex", env: {} });
  assert.ok(invocation.args.includes('forced_login_method="chatgpt"'));
  assert.ok(invocation.args.includes('model_provider="openai"'));
  assert.ok(invocation.args.includes("sandbox_workspace_write.network_access=false"));
  assert.ok(invocation.args.includes("sandbox_workspace_write.writable_roots=[]"));
  assert.equal(invocation.args.includes("--ignore-user-config"), false);
});

for (const parentExit of ["timeout", "normal"]) {
  test(`runner quiesces a stdio-ignore grandchild after ${parentExit} parent exit`, { skip: process.platform === "win32" }, async () => {
    const { runCommand } = require("../src/background/background-agent-runner");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myos-grandchild-test-"));
    // unref plus ignored stdio lets the direct parent close independently.
    // The grandchild stays in the runner-owned process group and ignores TERM.
    const grandchild = `const fs = require("node:fs");
      process.on("SIGTERM", () => {});
      fs.writeFileSync("ready.pid", String(process.pid));
      setInterval(() => fs.appendFileSync("late.txt", "write\\n"), 1000);`;
    const parent = `const fs = require("node:fs");
      fs.writeFileSync("group.pid", String(process.pid));
      const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });
      child.unref();
      const ready = setInterval(() => {
        if (!fs.existsSync("ready.pid")) return;
        ${parentExit === "normal" ? "clearInterval(ready);" : "// Wait for the runner timeout."}
      }, 10);`;
    try {
      const result = await runCommand({ command: process.execPath, args: ["-e", parent], cwd: dir,
        env: { PATH: process.env.PATH }, timeoutMs: parentExit === "timeout" ? 300 : 5000 });
      assert.equal(fs.existsSync(path.join(dir, "ready.pid")), true, "grandchild reached its signal handler");
      const bytes = () => fs.existsSync(path.join(dir, "late.txt")) ? fs.readFileSync(path.join(dir, "late.txt"), "utf8") : "";
      const captured = bytes();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.equal(bytes(), captured, "no descendant may write after the terminal result");
      assert.equal(result.cleanupFailed, false);
      assert.equal(result.code, parentExit === "normal" ? 0 : null);
      assert.equal(result.signal, parentExit === "timeout" ? "SIGTERM" : null);
      const pgid = Number(fs.readFileSync(path.join(dir, "group.pid"), "utf8"));
      assert.throws(() => process.kill(-pgid, 0), { code: "ESRCH" });
    } finally {
      if (fs.existsSync(path.join(dir, "group.pid"))) {
        const pgid = Number(fs.readFileSync(path.join(dir, "group.pid"), "utf8"));
        try { process.kill(-pgid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("unverified process cleanup retains work without capturing or accepting a patch", async () => {
  const repo = makeRepo();
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "myos-cleanup-failed-"));
  const result = await runBackgroundTask(taskFor(repo), optionsFor(artifacts, async ({ cwd }) => {
    fs.writeFileSync(path.join(cwd, "allowed", "seed.txt"), "possibly still changing\n");
    return { code: 0, stdout: writerOutput(), cleanupFailed: true };
  }));
  assert.equal(result.status, "failed");
  assert.equal(result.cleanupFailed, true);
  assert.equal(result.verificationResult, "process_cleanup_failed");
  assert.equal(result.patchArtifact, null);
  assert.deepEqual(result.artifacts, []);
  assert.equal(fs.readFileSync(path.join(result.worktreePath, "allowed", "seed.txt"), "utf8"), "possibly still changing\n");
  assert.equal(fs.readdirSync(result.artifactRoot).some((file) => file.endsWith(".patch")), false);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(artifacts, { recursive: true, force: true });
});

test("caller affinity accepts recognized executable paths and aliases and refuses unknown callers", () => {
  const { buildBackgroundWorkerInvocation } = require("../src/background/background-agent-runner");
  for (const [command, callerProvider] of [
    ["codex", "/usr/local/bin/codex"], ["codex", "codex.exe"],
    ["claude", "claude-code"], ["claude", "/usr/local/bin/claude_code"],
    ["gemini", "gemini-cli"], ["gemini", "C:\\tools\\gemini.cmd"],
  ]) {
    assert.equal(buildBackgroundWorkerInvocation({ effectiveMode: "read_only" }, { command, callerProvider, env: {} }).kind, command);
  }
  for (const callerProvider of [undefined, null, "", "unknown", "/bin/not-codex", "codex --model x", "codex/", 42]) {
    assert.throws(() => buildBackgroundWorkerInvocation({ effectiveMode: "read_only" }, { command: "codex", callerProvider, env: {} }), /callerProvider/);
  }
  assert.throws(() => buildBackgroundWorkerInvocation({ effectiveMode: "read_only" }, { command: "codex", callerProvider: "/bin/claude-code", env: {} }), /cross-provider/);
});

test("Windows writable execution fails before allocation or invocation without scoped tree control", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const repo = makeRepo();
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "myos-windows-refusal-"));
  let invoked = false;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    const result = await runBackgroundTask(taskFor(repo), optionsFor(artifacts, async () => {
      invoked = true;
      return { code: 0, stdout: writerOutput() };
    }));
    assert.equal(invoked, false);
    assert.equal(result.status, "failed");
    assert.equal(result.cleanupFailed, true);
    assert.match(result.summary, /Windows/);
    assert.equal(result.worktreePath == null, true);
    assert.deepEqual(fs.readdirSync(artifacts), []);
  } finally {
    Object.defineProperty(process, "platform", platform);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(artifacts, { recursive: true, force: true });
  }
});

test("runner bounds unverifiable cleanup and reports failure instead of success", { skip: process.platform === "win32" }, async (t) => {
  const { runCommand } = require("../src/background/background-agent-runner");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myos-unquiescent-test-"));
  const kill = process.kill.bind(process);
  const script = 'require("node:fs").writeFileSync("group.pid", String(process.pid)); process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);';
  const signals = [];
  t.mock.method(process, "kill", (pid, signal) => {
    const ownedPid = fs.existsSync(path.join(dir, "group.pid")) ? Number(fs.readFileSync(path.join(dir, "group.pid"), "utf8")) : null;
    if (pid === -ownedPid && signal !== 0) { signals.push(signal); return true; }
    return kill(pid, signal);
  });
  try {
    const start = Date.now();
    const result = await runCommand({ command: process.execPath, args: ["-e", script], cwd: dir,
      env: { PATH: process.env.PATH }, timeoutMs: 300 });
    assert.equal(result.cleanupFailed, true);
    assert.equal(result.code, null);
    assert.match(result.stderr, /quiescence could not be verified/);
    assert.ok(Date.now() - start < 7000, "cleanup must have a bounded wait");
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  } finally {
    t.mock.restoreAll();
    if (fs.existsSync(path.join(dir, "group.pid"))) {
      const pgid = Number(fs.readFileSync(path.join(dir, "group.pid"), "utf8"));
      try { kill(-pgid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      // Let Node reap this owned test process before deleting its fixture.
      for (let i = 0; i < 100; i += 1) {
        try { kill(-pgid, 0); }
        catch (error) { if (error.code === "ESRCH") break; throw error; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.throws(() => kill(-pgid, 0), { code: "ESRCH" });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

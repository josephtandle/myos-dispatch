"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync, execFileSync } = require("node:child_process");
const cli = path.resolve(__dirname, "../bin/myos-writer.js");

test("writer CLI offers an explicit one-shot delegation interface", () => {
  assert.equal(fs.existsSync(cli), true, "one-shot writer CLI must exist");
  const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--caller-provider/);
  assert.match(result.stdout, /--paths/);
});

test("writer CLI refuses incomplete or unsafe arguments with structured failure", () => {
  for (const args of [[], ["--apply", "x"], ["--scope", "/tmp", "--paths", "../x"], ["--prompt", "x".repeat(33000)]]) {
    const result = spawnSync(process.execPath, [cli, ...args, "--json"], { encoding: "utf8" });
    assert.equal(result.status, 1, JSON.stringify(args).slice(0, 100));
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "failed");
    assert.equal(payload.reviewRequired, true);
  }
});

function git(args, cwd) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function repoFixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "myos-writer-cli-test-"));
  git(["init", "-q"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  fs.writeFileSync(path.join(repo, "owned.txt"), "base\n");
  git(["add", "."], repo); git(["commit", "-qm", "base"], repo);
  return repo;
}
function writerOptions(repo) {
  return require(cli).parseArgs(["--scope", repo, "--paths", "owned.txt,new.bin", "--provider", "codex", "--model", "gpt-6-astra", "--caller-provider", "claude", "--prompt", "Edit owned file", "--json"]);
}
function output() {
  return [
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ findings: [], risks: [], checks: ["writer inspection"], confidence: "high" }) } },
    { type: "turn.completed", usage: {} },
  ].map(JSON.stringify).join("\n");
}

test("one-shot writer returns a reviewable manifest and exact model without touching source", async () => {
  const repo = repoFixture();
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "myos-writer-artifacts-"));
  const base = git(["rev-parse", "HEAD"], repo);
  const result = await require(cli).runWriter(writerOptions(repo), {
    artifactRoot: artifacts, stateFile: path.join(artifacts, "state.json"),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, MYOS_BACKGROUND_BACKPRESSURE_ENABLED: "0", MYOS_BACKGROUND_MIN_FREE_DISK_GIB: "0" },
    runCommand: async ({ cwd, invocation, env }) => {
      assert.equal(invocation.model, "gpt-6-astra");
      assert.equal(env.MYOS_BACKGROUND_AGENTS_ENABLED, "0");
      fs.writeFileSync(path.join(cwd, "owned.txt"), "changed\n");
      fs.writeFileSync(path.join(cwd, "new.bin"), Buffer.from([0, 255, 1]));
      return { code: 0, stdout: output() };
    },
  });
  assert.equal(result.status, "needs-review", JSON.stringify(result));
  assert.equal(result.reviewRequired, true);
  assert.equal(result.requestedModel, "gpt-6-astra");
  assert.equal(result.resolvedModel, "gpt-6-astra");
  assert.equal(result.providerReportedModel, null);
  assert.equal(result.ownedGroupStopped, null, "injected runners without cleanup evidence remain unknown");
  assert.equal(result.treeQuiescence, "unverified");
  assert.equal(result.baseSha, base);
  assert.deepEqual(result.changedFiles, ["new.bin", "owned.txt"]);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(result.patchArtifact)).digest("hex"), result.patchSha256);
  assert.equal(JSON.parse(fs.readFileSync(result.manifestArtifact)).patchSha256, result.patchSha256);
  assert.equal(git(["status", "--porcelain"], repo), "");
  assert.equal(fs.readFileSync(path.join(repo, "owned.txt"), "utf8"), "base\n");
  assert.equal(git(["rev-parse", "HEAD"], repo), base);
  assert.equal(fs.existsSync(result.worktreePath), true);
});

test("writer CLI preserves policy gates and failures without starting a provider", async () => {
  const repo = repoFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myos-writer-gates-"));
  for (const env of [
    { MYOS_BACKGROUND_AGENTS_ENABLED: "0" }, { MYOS_WRITABLE_SIDECARS_ENABLED: "0" },
    { MYOS_ORCHESTRATION_GOLD_ENABLED: "0" }, { MYOS_INITIATOR: "unattended" },
    { MYOS_BACKGROUND_IS_SIDECAR: "1" }, { MYOS_INITIATOR: "bot" },
  ]) {
    let invoked = false;
    const result = await require(cli).runWriter(writerOptions(repo), {
      artifactRoot: root, stateFile: path.join(root, "state.json"),
      env: { ...env, MYOS_BACKGROUND_BACKPRESSURE_ENABLED: "0", MYOS_BACKGROUND_MIN_FREE_DISK_GIB: "0" },
      runCommand: async () => { invoked = true; return { code: 0, stdout: output() }; },
    });
    assert.equal(invoked, false, JSON.stringify(env));
    assert.equal(result.status, "failed");
    assert.equal(result.reviewRequired, true);
  }
  fs.writeFileSync(path.join(repo, "dirty.txt"), "user work");
  const result = await require(cli).runWriter(writerOptions(repo), { env: { MYOS_BACKGROUND_BACKPRESSURE_ENABLED: "0", MYOS_BACKGROUND_MIN_FREE_DISK_GIB: "0" } });
  assert.equal(result.status, "failed");
  assert.match(result.summary, /dirty/);
});

test("writer manifest retains partial output after a provider exception", async () => {
  const repo = repoFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myos-writer-failure-"));
  const result = await require(cli).runWriter(writerOptions(repo), {
    artifactRoot: root, stateFile: path.join(root, "state.json"),
    env: { MYOS_BACKGROUND_BACKPRESSURE_ENABLED: "0", MYOS_BACKGROUND_MIN_FREE_DISK_GIB: "0" },
    runCommand: async ({ cwd }) => {
      fs.writeFileSync(path.join(cwd, "new.bin"), Buffer.from([0, 255, 2]));
      throw new Error("provider quota failure");
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(fs.existsSync(result.patchArtifact), true);
  assert.equal(JSON.parse(fs.readFileSync(result.manifestArtifact)).status, "failed");
  assert.equal(fs.existsSync(path.join(result.worktreePath, "new.bin")), true);
  assert.equal(git(["status", "--porcelain"], repo), "");
});

test("bounded prompt files and explicit model/provider mismatches fail closed", async () => {
  const repo = repoFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myos-writer-model-test-"));
  const file = path.join(root, "prompt.txt");
  fs.writeFileSync(file, "A bounded task");
  const args = ["--scope", repo, "--paths", "owned.txt", "--provider", "codex", "--model", "gpt-6-astra", "--caller-provider", "claude", "--prompt-file", file];
  assert.equal(require(cli).parseArgs(args).prompt, "A bounded task");
  fs.writeFileSync(file, "x".repeat(32769));
  assert.throws(() => require(cli).parseArgs(args), /32768/);
  const result = await require(cli).runWriter(writerOptions(repo), {
    artifactRoot: root, stateFile: path.join(root, "state.json"),
    env: { MYOS_BACKGROUND_BACKPRESSURE_ENABLED: "0", MYOS_BACKGROUND_MIN_FREE_DISK_GIB: "0" },
    runCommand: async ({ cwd }) => {
      fs.writeFileSync(path.join(cwd, "owned.txt"), "edit");
      return { code: 0, stdout: output() + '\n{"type":"thread.started","model":"substituted-model"}' };
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.resolvedModel, "gpt-6-astra");
  assert.equal(result.providerReportedModel, "substituted-model");
  assert.equal(fs.existsSync(result.patchArtifact), true);
});

test("writer timeout is bounded, defaults to fifteen minutes, and declares its task class", async () => {
  const repo = repoFixture();
  const base = ["--scope", repo, "--paths", "owned.txt", "--provider", "codex", "--model", "gpt-6-astra", "--caller-provider", "claude", "--prompt", "Edit owned file"];
  const { parseArgs, runWriter } = require(cli);
  assert.equal(parseArgs(base).timeoutMs, 900000);
  for (const value of ["0", "-1", "1800001", "1.5", "NaN", "Infinity", "1e3", "1000ms"]) {
    assert.throws(() => parseArgs([...base, "--timeout-ms", value]), /timeout-ms/);
  }
  assert.throws(() => parseArgs([...base, "--timeout-ms", "1000", "--timeout-ms", "2000"]), /duplicate/);
  assert.equal(parseArgs([...base, "--timeout-ms", "1"]).timeoutMs, 1);
  assert.equal(parseArgs([...base, "--timeout-ms", "1800000"]).timeoutMs, 1800000);
  for (const timeoutMs of [900000, 1200000]) {
    const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "myos-writer-timeout-"));
    let observed;
    const options = parseArgs(timeoutMs === 900000 ? base : [...base, "--timeout-ms", String(timeoutMs)]);
    const result = await runWriter(options, {
      artifactRoot: artifacts, stateFile: path.join(artifacts, "state.json"),
      env: { MYOS_BACKGROUND_BACKPRESSURE_ENABLED: "0", MYOS_BACKGROUND_MIN_FREE_DISK_GIB: "0" },
      runCommand: async ({ cwd, task, invocation, timeoutMs: actualTimeout }) => {
        observed = { taskClass: task.taskClass, model: invocation.model, timeoutMs: actualTimeout };
        fs.writeFileSync(path.join(cwd, "owned.txt"), "edit");
        return { code: 0, stdout: output() };
      },
    });
    assert.equal(result.status, "needs-review", JSON.stringify(result));
    assert.deepEqual(observed, { taskClass: "heavy_synthesis", model: "gpt-6-astra", timeoutMs });
  }
  const badRuntimeOptions = await runWriter({ ...parseArgs(base), timeoutMs: 1800001 });
  assert.equal(badRuntimeOptions.status, "failed");
  assert.match(badRuntimeOptions.summary, /timeout-ms/);
});


for (const detachedKind of ["writer", "server"]) {
test(`detached ${detachedKind} can outlive owned-group cleanup without changing the hash-pinned proposal`, { skip: process.platform === "win32" }, async () => {
  const { runCommand, verifyPatchArtifact } = require("../src/background/background-agent-runner");
  const repo = repoFixture();
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "myos-detached-boundary-"));
  const release = path.join(artifacts, "release");
  const done = path.join(artifacts, "done");
  const ready = path.join(artifacts, "ready");
  const startupError = path.join(artifacts, "startup-error");
  const waitFor = async (file) => {
    for (let i = 0; i < 500 && !fs.existsSync(file); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(file), true, `fixture did not create ${file}`);
  };
  // This intentionally violates the writer execution rule to demonstrate its
  // containment boundary. A new session escapes the runner-owned group.
  const server = `const fs = require("node:fs");
    const server = require("node:http").createServer((req, res) => res.end("fixture"));
    let closing = false;
    const finish = () => {
      if (closing) return;
      closing = true;
      clearInterval(poll);
      clearTimeout(deadline);
      setTimeout(() => {
        fs.writeFileSync("owned.txt", "late detached write\\n");
        fs.writeFileSync("late-marker.txt", "server survived\\n");
        server.close(() => fs.writeFileSync(${JSON.stringify(done)}, "done"));
      }, 100);
    };
    const poll = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) finish(); }, 20);
    const deadline = setTimeout(finish, 15000);
    server.on("error", (error) => {
      fs.writeFileSync(${JSON.stringify(startupError)}, error.stack);
      clearInterval(poll); clearTimeout(deadline);
    });
    ${detachedKind === "server"
      ? `server.listen(0, "127.0.0.1", () => fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)));`
      : `fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));`}`;
  const parent = `const fs = require("node:fs");
    fs.writeFileSync("owned.txt", "captured proposal\\n");
    const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(server)}], { detached: true, stdio: "ignore" });
    child.unref();
    const deadline = setTimeout(() => process.exit(1), 10000);
    const poll = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(startupError)})) {
        process.stderr.write(fs.readFileSync(${JSON.stringify(startupError)}, "utf8"));
        process.exit(1);
      }
      if (!fs.existsSync(${JSON.stringify(ready)})) return;
      clearInterval(poll); clearTimeout(deadline);
      process.stdout.write(${JSON.stringify(output())});
    }, 20);`;
  let observedCleanup;
  try {
    const result = await require(cli).runWriter(writerOptions(repo), {
      artifactRoot: artifacts, stateFile: path.join(artifacts, "state.json"),
      env: { MYOS_BACKGROUND_BACKPRESSURE_ENABLED: "0", MYOS_BACKGROUND_MIN_FREE_DISK_GIB: "0" },
      runCommand: async ({ cwd, input }) => {
        assert.match(input, /Do not start background servers, daemons, or detached processes/);
        observedCleanup = await runCommand({ command: process.execPath, args: ["-e", parent], cwd,
          env: { PATH: process.env.PATH }, timeoutMs: 12000 });
        return observedCleanup;
      },
    });
    assert.equal(result.status, "needs-review", JSON.stringify(result));
    assert.equal(result.reviewRequired, true);
    assert.equal(result.cleanupScope, "owned-process-group");
    assert.equal(result.ownedGroupStopped, true);
    assert.equal(result.treeQuiescence, "unverified");
    assert.equal(result.cleanupScope, observedCleanup.cleanupScope);
    assert.equal(result.ownedGroupStopped, observedCleanup.ownedGroupStopped);
    assert.equal(result.treeQuiescence, observedCleanup.treeQuiescence);
    assert.match(result.risks.join(" "), /Detached processes may survive/);
    assert.match(result.risks.join(" "), /retained worktree may change/);
    assert.match(result.risks.join(" "), /only the recorded patch hash/);
    const manifest = fs.readFileSync(result.manifestArtifact);
    assert.equal(JSON.parse(manifest).treeQuiescence, "unverified");
    assert.equal(JSON.parse(manifest).ownedGroupStopped, true);
    const patch = fs.readFileSync(result.patchArtifact);
    const recordedHash = result.patchSha256;
    assert.equal(path.relative(result.worktreePath, result.patchArtifact).startsWith(".."), true);
    const replay = path.join(artifacts, "review");
    git(["worktree", "add", "--detach", replay, result.baseSha], repo);
    verifyPatchArtifact(result.patchArtifact, recordedHash);
    git(["apply", "--check", result.patchArtifact], replay);
    git(["apply", result.patchArtifact], replay);
    const replayContents = fs.readFileSync(path.join(replay, "owned.txt"));
    assert.equal(replayContents.toString(), "captured proposal\n");
    assert.equal(fs.existsSync(path.join(result.worktreePath, "late-marker.txt")), false);
    fs.writeFileSync(release, "release");
    await waitFor(done);
    assert.equal(fs.readFileSync(path.join(result.worktreePath, "late-marker.txt"), "utf8"), "server survived\n");
    assert.equal(fs.readFileSync(path.join(result.worktreePath, "owned.txt"), "utf8"), "late detached write\n");
    assert.deepEqual(fs.readFileSync(result.patchArtifact), patch);
    assert.deepEqual(fs.readFileSync(result.manifestArtifact), manifest);
    assert.equal(crypto.createHash("sha256").update(patch).digest("hex"), recordedHash);
    assert.equal(verifyPatchArtifact(result.patchArtifact, recordedHash), true);
    assert.deepEqual(fs.readFileSync(path.join(replay, "owned.txt")), replayContents);
    assert.equal(fs.existsSync(path.join(replay, "late-marker.txt")), false);
    assert.equal(git(["status", "--porcelain"], repo), "");
  } finally {
    // Let the real detached fixture finish itself; retain both worktrees.
    fs.writeFileSync(release, "release");
    if (fs.existsSync(ready)) await waitFor(done);
  }
});
}

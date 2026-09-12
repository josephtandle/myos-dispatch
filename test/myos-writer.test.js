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

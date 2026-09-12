"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..");
const INSTALL_SH = path.join(REPO_ROOT, "bin", "install.sh");

test("smoke failure rolls back newly added main hook, title hook, rabbithole hook, and shell rc line", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "myos-install-rollback-"));
  const zshrcPath = path.join(tmpHome, ".zshrc");
  fs.writeFileSync(zshrcPath, "# User zshrc\nexport FOO=bar\n", "utf8");

  try {
    assert.throws(
      () => {
        execFileSync("bash", [INSTALL_SH, "--yes", "--with-shell-title", "--with-rabbit-hole"], {
          env: {
            ...process.env,
            HOME: tmpHome,
            TMPDIR: "/tmp",
            SHELL: "/bin/zsh",
            MYOS_HOME_ROOT: path.join(tmpHome, ".myos-dispatch"),
            MYOS_TEST_FAIL_SMOKE: "1",
          },
          stdio: "pipe",
        });
      },
      (err) => err.status !== 0 && /Smoke test failed/.test(String(err.stderr) + String(err.stdout)),
    );

    const settingsPath = path.join(tmpHome, ".claude", "settings.json");
    if (fs.existsSync(settingsPath)) {
      const content = fs.readFileSync(settingsPath, "utf8");
      assert.equal(content.includes("myos-dispatch-hook"), false);
      assert.equal(content.includes("myos-title-hook"), false);
      assert.equal(content.includes("myos-rabbithole-hook"), false);
    }

    const zshrcContent = fs.readFileSync(zshrcPath, "utf8");
    assert.equal(zshrcContent.includes("myos-dispatch shell-title hook"), false);
    assert.equal(zshrcContent.includes("export FOO=bar"), true);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("smoke failure preserves pre-existing hooks and shell rc lines", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "myos-install-rollback-pre-"));
  const claudeDir = path.join(tmpHome, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });

  const settingsPath = path.join(claudeDir, "settings.json");
  const preTitleHookPath = path.join(REPO_ROOT, "bin", "myos-title-hook");
  const preExistingSettings = {
    hooks: {
      SessionStart: [
        {
          type: "command",
          command: `${process.execPath} ${preTitleHookPath}`,
        },
      ],
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(preExistingSettings, null, 2), "utf8");

  const zshrcPath = path.join(tmpHome, ".zshrc");
  const preExistingRcContent =
    "# User zshrc\n# >>> myos-dispatch shell-title hook >>>\nsource \"/fake/path\"\n# <<< myos-dispatch shell-title hook <<<\nexport FOO=bar\n";
  fs.writeFileSync(zshrcPath, preExistingRcContent, "utf8");

  try {
    assert.throws(
      () => {
        execFileSync("bash", [INSTALL_SH, "--yes", "--with-shell-title", "--with-rabbit-hole"], {
          env: {
            ...process.env,
            HOME: tmpHome,
            TMPDIR: "/tmp",
            SHELL: "/bin/zsh",
            MYOS_HOME_ROOT: path.join(tmpHome, ".myos-dispatch"),
            MYOS_TEST_FAIL_SMOKE: "1",
          },
          stdio: "pipe",
        });
      },
      (err) => err.status !== 0 && /Smoke test failed/.test(String(err.stderr) + String(err.stdout)),
    );

    const content = fs.readFileSync(settingsPath, "utf8");
    assert.equal(content.includes("myos-title-hook"), true);
    assert.equal(content.includes("myos-dispatch-hook"), false);
    assert.equal(content.includes("myos-rabbithole-hook"), false);

    const zshrcContent = fs.readFileSync(zshrcPath, "utf8");
    assert.equal(zshrcContent.includes("myos-dispatch shell-title hook"), true);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("bash runtime both installs twice stably, preserves config, and rolls back failed update", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-runtime-"));
  const settings = path.join(home, ".claude", "settings.json");
  const codexSettings = path.join(home, "custom-codex", "hooks.json");
  for (const target of [settings, codexSettings]) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ model: "custom", teams: { keep: true }, hooks: { Stop: [{ hooks: [{ type: "command", command: "foreign" }] }] } }));
  }
  const { spawnSync } = require("node:child_process");
  const env = { HOME: home, CODEX_HOME: path.dirname(codexSettings), PATH: process.env.PATH, MYOS_HOME_ROOT: path.join(home, "data"), MYOS_BACKGROUND_AGENTS_ENABLED: "0", MYOS_AUTO_FANOUT: "0", MYOS_BACKGROUND_BACKPRESSURE_ENABLED: "0" };
  const run = (extra = [], extraEnv = {}) => spawnSync("bash", [INSTALL_SH, "--yes", "--runtime", "both", ...extra], { env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 30000 });
  const first = run(["--with-pretool"]);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const bytes = [settings, codexSettings].map(p => fs.readFileSync(p, "utf8"));
  const second = run();
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.deepEqual([settings, codexSettings].map(p => fs.readFileSync(p, "utf8")), bytes);
  for (const [i, surface] of ["claude", "codex"].entries()) {
    const parsed = JSON.parse(bytes[i]);
    assert.equal(parsed.model, "custom");
    assert.deepEqual(parsed.teams, { keep: true });
    assert.equal(parsed.hooks.Stop[0].hooks[0].command, "foreign");
    assert.match(parsed.hooks.UserPromptSubmit[0].hooks[0].command, new RegExp(`--surface=${surface}`));
  }
  assert.match(second.stdout, /trust.*not verified/i);
  const failed = run([], { MYOS_TEST_FAIL_SMOKE: "1" });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr + failed.stdout, /Smoke test failed/);
  assert.deepEqual([settings, codexSettings].map(p => fs.readFileSync(p, "utf8")), bytes);
  fs.writeFileSync(codexSettings, "{broken");
  assert.notEqual(run().status, 0);
  assert.equal(fs.readFileSync(codexSettings, "utf8"), "{broken");
  assert.equal(fs.readFileSync(settings, "utf8"), bytes[0]);
});

test("PowerShell installer exposes explicit runtime selection and checks native exit codes", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "bin", "install.ps1"), "utf8");
  assert.match(source, /ValidateSet\("claude", "codex", "both"\)/);
  assert.match(source, /CODEX_HOME/);
  assert.match(source, /hooks\.json/);
  assert.match(source, /LASTEXITCODE/);
  assert.doesNotMatch(source, /--surface=claude/);
});

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..");
const INSTALL_SH = path.join(REPO_ROOT, "bin", "install.sh");

test("failure after optional registration restores exact settings and shell rc bytes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-optional-rollback-"));
  try {
    const settings = path.join(home, ".claude", "settings.json");
    const rc = path.join(home, ".zshrc");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const original = JSON.stringify({ model: "custom", hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: 'node "/old/myos-title-hook"', timeout: 19 }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: 'node "/old/myos-rabbithole-hook"', timeout: 23 }] }],
      Stop: [{ hooks: [{ type: "command", command: "foreign" }] }],
    } });
    fs.writeFileSync(settings, original);
    fs.writeFileSync(rc, "# custom rc without trailing newline");
    // Inject at the real boundary after BOTH optional registrars have written.
    // Record evidence before failing so moving validation earlier cannot pass.
    const marker = "# 7. Local model catalog report";
    const installer = fs.readFileSync(INSTALL_SH, "utf8");
    assert.ok(installer.includes(marker));
    const injected = path.join(home, "install-injected.sh");
    fs.writeFileSync(injected, installer.replace(marker, 'cp "$SETTINGS" "$HOME/after-optional.json"\nfail "Injected post-optional validation failure"\n' + marker));
    const result = require("node:child_process").spawnSync("bash", [injected, "--yes", "--with-shell-title", "--with-rabbit-hole"], {
      env: { HOME: home, PATH: process.env.PATH, SHELL: "/bin/zsh", MYOS_DISPATCH_DIR: REPO_ROOT, MYOS_HOME_ROOT: path.join(home, "data"), MYOS_BACKGROUND_AGENTS_ENABLED: "0", MYOS_AUTO_FANOUT: "0", MYOS_BACKGROUND_BACKPRESSURE_ENABLED: "0" },
      encoding: "utf8", timeout: 30000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Injected post-optional validation failure/);
    const changed = fs.readFileSync(path.join(home, "after-optional.json"), "utf8");
    for (const hook of ["myos-dispatch-hook", "myos-title-hook", "myos-rabbithole-hook"]) assert.ok(changed.includes(path.join(REPO_ROOT, "bin", hook)));
    assert.notEqual(changed, original);
    assert.equal(fs.readFileSync(settings, "utf8"), original, result.stderr);
    assert.equal(fs.readFileSync(rc, "utf8"), "# custom rc without trailing newline");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

for (const scenario of ["optional-two-failure", "foreign-settings", "foreign-shell-rc", "nonzero-smoke"]) {
  test(`selected runtime transaction handles ${scenario}`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-transaction-"));
    try {
      const settings = path.join(home, ".claude", "settings.json");
      const codex = path.join(home, ".codex", "hooks.json");
      const rc = path.join(home, ".zshrc");
      const original = '{ "model": "keep", "hooks": {} }\n';
      for (const target of [settings, codex]) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, original);
      }
      const rcBytes = "# original rc\n";
      fs.writeFileSync(rc, rcBytes);
      let installer = fs.readFileSync(INSTALL_SH, "utf8");
      const marker = scenario === "optional-two-failure" ? "# 7. Optional: rabbit-hole self-check nudge" : "# 8. Smoke test";
      assert.ok(installer.includes(marker));
      let injection = 'cp "$SETTINGS" "$HOME/modified.json"\n';
      if (scenario === "foreign-settings") injection += 'printf \'%s\' \'{"foreignConcurrent":true}\' > "$SETTINGS"\n';
      if (scenario === "foreign-shell-rc") injection += 'printf \'%s\' \'foreign rc edit\' > "$RC_FILE"\n';
      if (scenario === "nonzero-smoke") {
        // A real child prints apparently valid output but fails. The installer
        // must use its exit code as well as its output, after optional writes.
        fs.writeFileSync(path.join(home, "failing-hook.js"), 'process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:"test"}})); process.exitCode=7;\n');
        injection += 'HOOK_PATH="$HOME/failing-hook.js"\n';
      } else injection += 'fail "Injected transaction failure"\n';
      installer = installer.replace(marker, injection + marker);
      const injected = path.join(home, "install.sh");
      fs.writeFileSync(injected, installer);
      const result = require("node:child_process").spawnSync("bash", [injected, "--yes", "--runtime", "both", "--with-shell-title", "--with-rabbit-hole"], {
        env: { HOME: home, CODEX_HOME: path.dirname(codex), PATH: process.env.PATH, SHELL: "/bin/zsh", MYOS_DISPATCH_DIR: REPO_ROOT, MYOS_HOME_ROOT: path.join(home, "data"), MYOS_BACKGROUND_AGENTS_ENABLED: "0", MYOS_AUTO_FANOUT: "0", MYOS_BACKGROUND_BACKPRESSURE_ENABLED: "0" },
        encoding: "utf8", timeout: 30000,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, scenario === "nonzero-smoke" ? /Smoke test failed/ : /Injected transaction failure/);
      const modified = fs.readFileSync(path.join(home, "modified.json"), "utf8");
      assert.ok(modified.includes("myos-title-hook"), "title must have changed before failure");
      assert.equal(modified.includes("myos-rabbithole-hook"), scenario !== "optional-two-failure");
      assert.equal(fs.readFileSync(settings, "utf8"), scenario === "foreign-settings" ? '{"foreignConcurrent":true}' : original);
      assert.equal(fs.readFileSync(codex, "utf8"), original);
      assert.equal(fs.readFileSync(rc, "utf8"), scenario === "foreign-shell-rc" ? "foreign rc edit" : rcBytes);
      if (scenario.startsWith("foreign-")) assert.match(result.stderr, /Rollback refused/);
      else assert.doesNotMatch(result.stderr, /Rollback refused/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
}

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

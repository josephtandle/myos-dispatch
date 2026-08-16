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
            SHELL: "/bin/zsh",
            MYOS_HOME_ROOT: path.join(tmpHome, ".myos-dispatch"),
            MYOS_TEST_FAIL_SMOKE: "1",
          },
          stdio: "pipe",
        });
      },
      (err) => err.status !== 0,
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
            SHELL: "/bin/zsh",
            MYOS_HOME_ROOT: path.join(tmpHome, ".myos-dispatch"),
            MYOS_TEST_FAIL_SMOKE: "1",
          },
          stdio: "pipe",
        });
      },
      (err) => err.status !== 0,
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

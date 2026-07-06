const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const compat = require("../src/myos-compat");
const LEGACY_SERVICE_ENV = ["OPEN", "CLAW", "_SERVICE_NAMESPACE"].join("");
const LEGACY_HOME_ENV = ["OPEN", "CLAW", "_HOME_ROOT"].join("");
const LEGACY_BRAND = ["open", "claw"].join("");
const LEGACY_HOME_DIRNAME = [".open", "claw"].join("");

test("service label helpers prefer MyOS namespace and keep legacy alias", () => {
  const originalMyosNs = process.env.MYOS_SERVICE_NAMESPACE;
  const originalLegacyNs = process.env[LEGACY_SERVICE_ENV];

  process.env.MYOS_SERVICE_NAMESPACE = "myos";
  process.env[LEGACY_SERVICE_ENV] = LEGACY_BRAND;

  try {
    assert.equal(compat.serviceLabel("git-autocommit"), "ai.myos.git-autocommit");
    assert.equal(compat.legacyServiceLabel("git-autocommit"), `ai.${LEGACY_BRAND}.git-autocommit`);
    assert.deepEqual(compat.serviceLabelCandidates("git-autocommit"), [
      "ai.myos.git-autocommit",
      `ai.${LEGACY_BRAND}.git-autocommit`,
    ]);
  } finally {
    if (originalMyosNs === undefined) delete process.env.MYOS_SERVICE_NAMESPACE;
    else process.env.MYOS_SERVICE_NAMESPACE = originalMyosNs;
    if (originalLegacyNs === undefined) delete process.env[LEGACY_SERVICE_ENV];
    else process.env[LEGACY_SERVICE_ENV] = originalLegacyNs;
  }
});

test("workspace path helpers fall back to legacy root when .myos does not exist", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "myos-compat-home-"));
  const legacyRoot = path.join(tempHome, LEGACY_HOME_DIRNAME);
  const legacyWorkspace = path.join(legacyRoot, "workspace");
  fs.mkdirSync(legacyWorkspace, { recursive: true });

  const originalHome = process.env.HOME;
  const originalMyosHomeRoot = process.env.MYOS_HOME_ROOT;
  const originalLegacyHomeRoot = process.env[LEGACY_HOME_ENV];

  process.env.HOME = tempHome;
  delete process.env.MYOS_HOME_ROOT;
  delete process.env[LEGACY_HOME_ENV];

  try {
    assert.equal(compat.resolveWorkspaceRoot(), legacyWorkspace);
    assert.equal(compat.resolveWorkspacePath(".env"), path.join(legacyWorkspace, ".env"));
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalMyosHomeRoot === undefined) delete process.env.MYOS_HOME_ROOT;
    else process.env.MYOS_HOME_ROOT = originalMyosHomeRoot;
    if (originalLegacyHomeRoot === undefined) delete process.env[LEGACY_HOME_ENV];
    else process.env[LEGACY_HOME_ENV] = originalLegacyHomeRoot;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

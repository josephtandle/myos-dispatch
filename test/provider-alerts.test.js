"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

function loadProviderAlerts() {
  const modulePath = require.resolve("../src/runtime/provider-alerts");
  delete require.cache[modulePath];
  return require("../src/runtime/provider-alerts");
}

test("provider alerts do not require notifier modules by default", async () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "provider-alerts-home-"));
  const previousHomeRoot = process.env.MYOS_HOME_ROOT;
  process.env.MYOS_HOME_ROOT = homeRoot;
  const { maybeNotifyProviderIssue, notifierSpecs } = loadProviderAlerts();
  try {
    assert.deepEqual(notifierSpecs({}), []);
    const notified = await maybeNotifyProviderIssue({
      provider: "example",
      error: new Error("quota exceeded"),
      taskClass: "default_automation",
    });
    assert.equal(notified, false);
  } finally {
    if (previousHomeRoot === undefined) delete process.env.MYOS_HOME_ROOT;
    else process.env.MYOS_HOME_ROOT = previousHomeRoot;
  }
});

test("provider alerts load optional notifier modules from config", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-alerts-"));
  const notifierPath = path.join(tmpDir, "notifier.cjs");
  const outputPath = path.join(tmpDir, "alert.json");
  fs.writeFileSync(
    notifierPath,
    `
exports.sendProviderAlert = async function sendProviderAlert(alert) {
  require("node:fs").writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(alert));
  return true;
};
`,
    "utf8",
  );

  const previous = process.env.MYOS_PROVIDER_ALERT_NOTIFIER_MODULES;
  const previousHomeRoot = process.env.MYOS_HOME_ROOT;
  process.env.MYOS_HOME_ROOT = path.join(tmpDir, "home-root");
  process.env.MYOS_PROVIDER_ALERT_NOTIFIER_MODULES = notifierPath;
  try {
    const { maybeNotifyProviderIssue } = loadProviderAlerts();
    const notified = await maybeNotifyProviderIssue({
      provider: "example",
      error: new Error("quota exceeded"),
      taskClass: "default_automation",
    });
    assert.equal(notified, true);
    assert.match(JSON.parse(fs.readFileSync(outputPath, "utf8")).plainText, /Provider: example/);
  } finally {
    if (previous === undefined) delete process.env.MYOS_PROVIDER_ALERT_NOTIFIER_MODULES;
    else process.env.MYOS_PROVIDER_ALERT_NOTIFIER_MODULES = previous;
    if (previousHomeRoot === undefined) delete process.env.MYOS_HOME_ROOT;
    else process.env.MYOS_HOME_ROOT = previousHomeRoot;
  }
});

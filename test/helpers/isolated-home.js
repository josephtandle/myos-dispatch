"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function preserveEnv(t, keys) {
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function isolateHookHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-hook-test-"));
  preserveEnv(t, ["MYOS_HOME_ROOT", "OPENCLAW_HOME_ROOT", "MYOS_DISPATCH_HOOK_LOG_DIR", "MYOS_DATA_SOURCES_CONFIG", "MYOS_AUTO_FANOUT"]);
  Object.assign(process.env, {
    MYOS_HOME_ROOT: home,
    OPENCLAW_HOME_ROOT: home,
    MYOS_DISPATCH_HOOK_LOG_DIR: path.join(home, "logs"),
    MYOS_DATA_SOURCES_CONFIG: "none",
    MYOS_AUTO_FANOUT: "0",
  });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
}

module.exports = { preserveEnv, isolateHookHome };

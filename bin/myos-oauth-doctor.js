#!/usr/bin/env node
"use strict";
const { refreshRegistry, registryPath } = require("../src/runtime/oauth-doctor");
const { readState } = require("../src/runtime/oauth-state");

async function main(args) {
  if (args.length !== 1 || !["scan", "status"].includes(args[0])) {
    console.error("Usage: myos-oauth-doctor <scan|status>\nScans installed model metadata and auth status without inference, login or purchases. No scheduled job.");
    process.exitCode = 2;
    return;
  }
  const file = registryPath();
  const state = args[0] === "scan" ? await refreshRegistry(file, { force: true }) : readState(file);
  if (args[0] === "status") {
    const { createJevClient, DEFAULT_MODEL } = require("../src/runtime/jev-client");
    const path = require("node:path");
    const home = process.env.MYOS_HOME_ROOT || path.join(require("node:os").homedir(), ".myos-dispatch");
    let saved = {};
    try { saved = JSON.parse(require("node:fs").readFileSync(path.join(home, "state/jev-shadow-state.json"), "utf8")); } catch {}
    const requested = process.env.MYOS_JEV_STAGE || saved.stage;
    const stage = ["shadow", "canary", "authoritative"].includes(requested) ? requested : "shadow";
    console.log(createJevClient().isConfigured()
      ? `jev: configured (model ${DEFAULT_MODEL}, stage ${stage})`
      : "jev: not configured (optional; add TYPESAFE_API_KEY for calibrated routing)");
  }
  console.log(JSON.stringify({ taskClass: "cheap_routing", registry: file, state }, null, 2));
}
main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });

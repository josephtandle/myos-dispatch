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
  console.log(JSON.stringify({ taskClass: "cheap_routing", registry: file, state }, null, 2));
}
main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });

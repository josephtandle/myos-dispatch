"use strict";

// Pure env predicates shared by the routing hook chain and the sidecar
// runner. Keeping them here means the hook's require chain never has to
// load src/background or src/runtime: a privacy-trimmed install can
// delete both directories and the router keeps working.

function isUnattendedContext(env = process.env) {
  if (String(env?.MYOS_INITIATOR_OAUTH_DISABLED || "") === "1") return true;
  return String(env?.MYOS_INITIATOR || "").trim().toLowerCase() === "unattended";
}

function backgroundAgentsDisabled(env = process.env) {
  return String(env?.MYOS_BACKGROUND_AGENTS_ENABLED ?? "").trim() === "0";
}

module.exports = {
  backgroundAgentsDisabled,
  isUnattendedContext,
};

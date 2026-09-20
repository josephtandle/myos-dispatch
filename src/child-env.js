"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const debug = require("node:util").debuglog("myos-dispatch");
const loggedPaths = new Set();

// Deliberately does not expand variables or execute shell expressions.
function buildChildEnv(overrides = {}, parentEnv = process.env) {
  const env = { ...parentEnv, ...overrides };
  const homeRoot = env.MYOS_HOME_ROOT || path.join(env.HOME || os.homedir(), ".myos");
  const envPath = path.join(homeRoot, ".env");
  let source = "";
  try {
    source = fs.readFileSync(envPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let count = 0;
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(env, match[1])) continue;
    let value = match[2];
    if (value.startsWith('"') || value.startsWith("'")) {
      const quoted = value.match(/^("(?:\\.|[^"\\])*"|'[^']*')\s*(?:#.*)?$/);
      if (!quoted) continue;
      value = quoted[1].slice(1, -1);
      if (match[2].startsWith('"')) value = value.replace(/\\([nr"\\])/g, (_, char) => ({ n: "\n", r: "\r", '"': '"', "\\": "\\" })[char]);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    Object.defineProperty(env, match[1], { value, enumerable: true, writable: true, configurable: true });
    count += 1;
  }
  if (!loggedPaths.has(envPath)) {
    debug("dotenv %s: loaded %d keys", envPath, count);
    loggedPaths.add(envPath);
  }
  return env;
}

module.exports = { buildChildEnv };

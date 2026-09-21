"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readState, updateState } = require("./oauth-state");
const { mergeDiscovery } = require("./oauth-registry");
const { discoverInventory } = require("./oauth-discovery");
const { acquireLock } = require("./oauth-lock");
const pending = new Map();

async function boundedWait(scan, file, timeoutMs) {
  let timer;
  try {
    return await Promise.race([scan, new Promise(resolve => {
      timer = setTimeout(() => resolve(readState(file)), timeoutMs || 10000);
    })]);
  } finally { clearTimeout(timer); }
}

function registryPath(env = process.env) {
  if (env.MYOS_OAUTH_RECOVERY === "0") return null;
  return env.MYOS_OAUTH_REGISTRY || path.join(env.HOME || os.homedir(), ".myos-dispatch", "oauth-models.json");
}

async function refreshRegistry(file, options = {}) {
  if (pending.has(file)) return boundedWait(pending.get(file), file, options.timeoutMs);
  const previous = readState(file);
  if (!options.force && Date.now() - Date.parse(previous?.scannedAt) < 60000) return previous;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = file + ".scan-lock";
  let release;
  try { release = acquireLock(lock); } catch (error) {
    if (error.code === "EEXIST") return previous;
    throw error;
  }
  const scan = (async () => {
    try {
      const inventory = await (options.discover || discoverInventory)(options);
      return updateState(file, state => {
        const merged = mergeDiscovery(state, inventory.models);
        const auth = new Map(inventory.providers.map(provider => [provider.provider, provider.auth]));
        const complete = new Set(inventory.providers.filter(provider => provider.completeInventory).map(provider => provider.provider));
        const observed = new Set(inventory.models.map(model => `${model.provider}:${model.model}`));
        return { ...merged, scannedAt: new Date().toISOString(), providers: inventory.providers,
          models: merged.models.map(model => ({ ...model, auth: auth.get(model.provider) || "unknown",
            visible: complete.has(model.provider) && !observed.has(`${model.provider}:${model.model}`) ? false : model.visible })) };
      });
    } finally {
      release();
      pending.delete(file);
    }
  })();
  pending.set(file, scan);
  return boundedWait(scan, file, options.timeoutMs);
}
module.exports = { refreshRegistry, registryPath };

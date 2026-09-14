"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { ensureState } = require("./catalogue");
const { runMaintenanceWorker } = require("./qmd");
const { evaluateBackground } = require("./resources");

function validateLockFile(lockPath) {
  const stat = fs.lstatSync(lockPath);
  const ownerMismatch = typeof process.getuid === "function" && stat.uid !== process.getuid();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || ownerMismatch || (stat.mode & 0o077) !== 0) {
    throw Object.assign(new Error("maintenance lock database is unsafe"), { code: "UNSAFE_STATE" });
  }
}

function acquire(config) {
  ensureState(config);
  const lockPath = path.join(config.stateDirectory, "maintenance-lock.sqlite");
  let created = false;
  if (fs.existsSync(lockPath)) validateLockFile(lockPath);
  else {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    fs.closeSync(fd);
    created = true;
  }
  validateLockFile(lockPath);
  let database;
  try {
    database = new DatabaseSync(lockPath);
    database.exec("PRAGMA busy_timeout=0");
    if (created || fs.statSync(lockPath).size === 0) database.exec("CREATE TABLE IF NOT EXISTS maintenance_mutex (id INTEGER PRIMARY KEY CHECK (id = 1))");
    database.exec("BEGIN IMMEDIATE");
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        try { database.exec("COMMIT"); } finally { database.close(); }
      },
    };
  } catch (error) {
    try { if (database) database.close(); } catch {}
    if (error.code === "ERR_SQLITE_ERROR" && /locked|busy/i.test(error.message)) {
      throw Object.assign(new Error("maintenance already in progress"), { code: "MAINTENANCE_BUSY" });
    }
    throw error;
  }
}

async function watch(config, options = {}) {
  if (!config.enabled) return { ok: false, status: "disabled" };
  const signal = options.signal;
  const watchers = [];
  let timer;
  let running = false;
  let queued = false;
  let stopped = false;
  let runs = 0;
  let last;
  let drainResolve;
  let stopPromise;
  let activeAbort;
  let resourceState;
  let paused = false;
  // Loaded here rather than at module evaluation time: metadata-refresh obtains this
  // module's mutex, so a top-level import would create a circular initialization path.
  const metadata = require("./metadata-refresh");
  const metadataCursor = metadata.createMetadataCursor(config);
  const resourceSession = {};
  const resourceChecksEnabled = Boolean(options.resourceReadings || options.resourcePlatform !== undefined || (!options.testOnlyInProcess && !options.adapters));
  const hardPauseReasons = new Set(["backgroundProbeUnavailable", "onBattery", "thermalPressure"]);
  const healthErrors = [];
  const recordError = (reason, error) => {
    const value = error && (error.code || error.message);
    const previous = healthErrors.at(-1);
    if (previous && previous.reason === reason && previous.error === value) previous.occurrences = (previous.occurrences || 1) + 1;
    else healthErrors.push({ reason, error: value });
    if (healthErrors.length > 32) healthErrors.splice(0, healthErrors.length - 32);
  };
  const notifyError = (error) => {
    try { if (options.onError) options.onError(error); }
    catch (callbackError) { recordError("onErrorCallback", callbackError); }
  };
  const checkResources = () => {
    if (!resourceChecksEnabled) return true;
    try {
      resourceState = evaluateBackground(config, {
        readings: options.resourceReadings,
        platform: options.resourcePlatform,
        readCommand: options.resourceReadCommand,
        now: options.resourceClock,
        session: resourceSession,
      });
    } catch (error) {
      recordError("resourceStatusPublication", error);
      notifyError(error);
      resourceSession.healthySince = null;
      resourceState = {
        background: "paused",
        pausedReason: "resourceStatusUnavailable",
        probeAvailable: false,
        persistenceAvailable: false,
      };
    }
    paused = resourceState.background === "paused";
    if (paused) queued = true;
    if (running && (hardPauseReasons.has(resourceState.pausedReason) || resourceState.persistenceAvailable === false)) activeAbort?.abort();
    return !paused;
  };
  const metadataMayRun = () => !resourceState || !hardPauseReasons.has(resourceState.pausedReason)
    && resourceState.pausedReason !== "resourceStatusUnavailable";
  const runMetadata = async () => {
    if (!metadataMayRun() || stopped) return;
    const result = await metadata.refreshMetadata(config, {
      cursor: metadataCursor, signal: activeAbort?.signal, maxEntries: 32, deadline: Date.now() + 100,
    });
    if (["failed", "storageRejected", "catalogueCorrupt"].includes(result.status)) recordError("metadata", { code: "metadataRefreshFailed" });
  };
  const run = async (reason) => {
    if (stopped) return;
    if (paused && hardPauseReasons.has(resourceState?.pausedReason) && reason !== "periodic" && reason !== "startup") { queued = true; return; }
    if (running) { queued = true; return; }
    running = true;
    try {
      const ready = checkResources();
      queued = false;
      activeAbort = new AbortController();
      await runMetadata();
      // Metadata is safe during the idle/healthy dwell, but the heavyweight pass is not.
      if (!ready) return;
      if (options.testOnlyInProcess === true || options.adapters) {
        const lock = acquire(config);
        try {
          const { _performIndex } = require("./index");
          last = await _performIndex(config, options.adapters ? { ...options.adapters, signal: activeAbort.signal } : { signal: activeAbort.signal }, true);
        } finally { lock.release(); }
      } else {
        last = await runMaintenanceWorker(config, { signal: activeAbort.signal });
      }
      runs += 1;
      if (options.onReconcile) options.onReconcile({
        reason, runs, result: last,
        metadataRefreshedAt: metadataCursor.metadataRefreshedAt,
        metadataSweepCompletedAt: metadataCursor.metadataSweepCompletedAt,
        metadataPending: metadataCursor.metadataPending,
      });
    } catch (error) {
      last = { complete: false, error: error.code || error.message };
      recordError("maintenance", error);
      notifyError(error);
    } finally {
      activeAbort = null;
      running = false;
      if (queued && !paused && !stopped) { queued = false; queueMicrotask(() => run("queued")); }
      else if (drainResolve) { drainResolve(); drainResolve = null; }
    }
  };
  const abortListener = () => { void stop(); };
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopped = true;
      queued = false;
      if (timer) { clearInterval(timer); timer = undefined; }
      for (const watcher of watchers.splice(0)) watcher.close();
      metadata.closeMetadataCursor(metadataCursor);
      if (signal) signal.removeEventListener("abort", abortListener);
      if (activeAbort) activeAbort.abort();
      if (running) await new Promise((resolve) => { drainResolve = resolve; });
    })();
    return stopPromise;
  };
  const controller = {
    ok: true,
    status: "watchingForeground",
    stop,
    reconcileNow: () => run("explicitSignal"),
    getState: () => ({
      stopped, running, runs, last, healthErrors: [...healthErrors],
      ...(metadataCursor.metadataRefreshedAt !== null || metadataCursor.metadataSweepCompletedAt !== null
        ? { metadataRefreshedAt: metadataCursor.metadataRefreshedAt, metadataSweepCompletedAt: metadataCursor.metadataSweepCompletedAt, metadataPending: metadataCursor.metadataPending }
        : {}),
      ...(resourceState ? { resources: resourceState, queued } : {}),
    }),
  };
  if (signal) {
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) { await stop(); return controller; }
  }
  timer = setInterval(() => {
    checkResources();
    if (!running && !stopped) void run("periodic");
  }, config.budgets.pollIntervalMs);
  await run("startup");
  if (stopped || (signal && signal.aborted)) { await stop(); return controller; }
  if (options.watchEvents !== false) for (const root of config.roots) {
    try {
      const watcher = fs.watch(root.path, () => run("event"));
      watcher.on("error", (error) => { recordError("watcherError", error); notifyError(error); });
      watchers.push(watcher);
    } catch (error) {
      recordError("watcherUnavailable", error);
      notifyError(error);
    }
  }
  return controller;
}

module.exports = { acquire, watch };

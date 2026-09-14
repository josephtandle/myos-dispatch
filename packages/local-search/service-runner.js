"use strict";

const path = require("node:path");
const api = require(".");
const { loadConfig } = require("./config");
const { acknowledgeLaunch, deriveIdentity, operationError, projection, safeErrorCode, validateReceipt, writeStatus } = require("./service");

function coded(message, code) { return Object.assign(new Error(message), { code }); }
function parse(argv) {
  if (argv.length !== 2 || argv[0] !== "--config" || !path.isAbsolute(argv[1])) throw coded("service runner requires --config /absolute/path", "INVALID_ARGUMENT");
  return { configPath: argv[1] };
}

function resultStatus(result) {
  const value = result && result.status;
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : result && result.ok === true ? "ok" : result ? "failed" : null;
}

function projectWatcherState(state) {
  if (!state || typeof state !== "object") return { phase: "degraded", errorCode: "watchError", runCount: null, completed: false, lastStatus: null };
  const runCount = Number.isSafeInteger(state.runs) && state.runs >= 0 ? state.runs : null;
  const completed = runCount > 0 && state.last && state.last.complete === true;
  const lastStatus = resultStatus(state.last);
  if (state.stopped) return { phase: "degraded", errorCode: "watchStopped", runCount, completed, lastStatus };
  if (Array.isArray(state.healthErrors) && state.healthErrors.length > 0) return { phase: "degraded", errorCode: "watchError", runCount, completed, lastStatus };
  if (state.resources && state.resources.background === "paused") return { phase: "paused", errorCode: "resourcePaused", runCount, completed, lastStatus };
  if (!Number.isSafeInteger(state.runs) || state.runs < 1 || !state.last || state.last.ok !== true || state.last.complete !== true) {
    if (state.last && (state.last.ok === false || state.last.complete === false)) return { phase: "degraded", errorCode: "reconcileFailed", runCount, completed, lastStatus };
    return { phase: "degraded", errorCode: "indexNotReady", runCount, completed, lastStatus };
  }
  return { phase: "watching", errorCode: null, runCount, completed, lastStatus };
}

async function runService(options, dependencies = {}) {
  const config = loadConfig(options.configPath);
  if (!config.enabled) throw coded("configuration is disabled", "configurationDisabled");
  const identity = dependencies.identity || deriveIdentity(options.configPath, config, dependencies);
  const now = dependencies.now || Date.now;
  const signals = dependencies.signals || process;
  const setRecurring = dependencies.setInterval || setInterval;
  const clearRecurring = dependencies.clearInterval || clearInterval;
  const watch = dependencies.watch || api.watch;
  const intervalMs = config.budgets.pollIntervalMs;
  const gapMs = Math.max(intervalMs * 3, 60_000);
  const abortController = new AbortController();
  let phase = "starting";
  let errorCode = null;
  let lastRun = null;
  let observedRuns = null;
  let lastStatus = null;
  let lastTick = now();
  let timer;
  let watcher;
  let tickPromise;
  let stopRequested = false;
  let publicationFailed = false;
  let resolveStop;
  const stopSignal = new Promise((resolve) => { resolveStop = resolve; });
  const snapshot = () => projection(identity, {
    enabled: true, taskClass: "default_automation", phase,
    lastHeartbeat: new Date(now()).toISOString(), lastRun, lastStatus,
    nextReconciliationAt: stopRequested ? null : new Date(now() + intervalMs).toISOString(), errorCode,
  });
  const heartbeat = () => {
    if (publicationFailed) return snapshot();
    try { return writeStatus(identity, snapshot()); }
    catch {
      publicationFailed = true;
      phase = "degraded";
      errorCode = "heartbeatPublicationFailed";
      requestStop();
      return snapshot();
    }
  };
  const requestStop = () => {
    if (stopRequested) return;
    stopRequested = true;
    abortController.abort();
    resolveStop();
  };
  const refreshFromWatcher = (event) => {
    const eventState = event && Number.isSafeInteger(event.runs)
      ? { stopped: false, running: false, runs: event.runs, last: event.result, healthErrors: [] }
      : null;
    const state = eventState || (watcher && typeof watcher.getState === "function" ? watcher.getState() : null);
    const observed = projectWatcherState(state);
    phase = observed.phase;
    errorCode = observed.errorCode;
    if (Number.isSafeInteger(observed.runCount)) {
      const advanced = observedRuns !== null && observed.runCount > observedRuns;
      if (observed.completed && (advanced || (observedRuns === null && eventState))) lastRun = new Date(now()).toISOString();
      observedRuns = observedRuns === null ? observed.runCount : Math.max(observedRuns, observed.runCount);
    }
    if (observed.lastStatus) lastStatus = observed.lastStatus;
  };
  const callbackHeartbeat = () => { if (!stopRequested) heartbeat(); };
  const signalNames = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signalNames) signals.once(signal, requestStop);

  try {
    const receipt = validateReceipt(identity, { configPath: options.configPath }, { requireMarker: true, requireReadiness: true });
    heartbeat();
    if (stopRequested) return snapshot();
    acknowledgeLaunch(identity, receipt);
    watcher = await watch(options.configPath, {
      signal: abortController.signal,
      onReconcile(event) { refreshFromWatcher(event); callbackHeartbeat(); },
      onError() { phase = "degraded"; errorCode = "watchError"; callbackHeartbeat(); },
    });
    if (stopRequested) {
      if (watcher && typeof watcher.stop === "function") await watcher.stop();
      phase = "stopped"; errorCode = null;
      return heartbeat();
    }
    if (!watcher || watcher.ok !== true || typeof watcher.stop !== "function" || typeof watcher.reconcileNow !== "function" || typeof watcher.getState !== "function") {
      phase = "degraded"; errorCode = "watchStartupFailed";
      return heartbeat();
    }
    refreshFromWatcher();
    heartbeat();

    const runTick = async () => {
      if (stopRequested) return;
      const tick = now();
      if (tick - lastTick > gapMs) {
        phase = "recovering"; errorCode = "clockGap"; heartbeat();
        if (stopRequested) return;
        const before = watcher.getState();
        const runsBefore = Number.isSafeInteger(before && before.runs) ? before.runs : 0;
        try {
          await watcher.reconcileNow();
          if (stopRequested) return;
          const after = watcher.getState();
          refreshFromWatcher();
          if (after && after.resources && after.resources.background === "paused") {
            phase = "paused"; errorCode = "resourcePaused";
          } else if (!Number.isSafeInteger(after && after.runs) || after.runs <= runsBefore) {
            phase = "degraded"; errorCode = "wakeNoop";
          }
        } catch {
          if (stopRequested) return;
          phase = "degraded"; errorCode = "wakeFailed";
        }
      } else refreshFromWatcher();
      if (stopRequested) return;
      lastTick = tick;
      heartbeat();
    };
    const requestTick = () => {
      if (tickPromise) return tickPromise;
      tickPromise = runTick().finally(() => { tickPromise = undefined; });
      return tickPromise;
    };
    timer = setRecurring(() => { void requestTick().catch(() => { phase = "degraded"; errorCode = "serviceFailed"; requestStop(); }); }, intervalMs);
    await stopSignal;
    if (timer !== undefined) { clearRecurring(timer); timer = undefined; }
    if (tickPromise) await tickPromise;
    if (watcher && typeof watcher.stop === "function") await watcher.stop();
    if (tickPromise) await tickPromise;
    phase = "stopped"; errorCode = null;
    return heartbeat();
  } catch (error) {
    requestStop();
    if (tickPromise) try { await tickPromise; } catch {}
    if (watcher && typeof watcher.stop === "function") try { await watcher.stop(); } catch {}
    phase = publicationFailed ? "degraded" : stopRequested && error && error.name === "AbortError" ? "stopped" : "degraded";
    errorCode = publicationFailed ? "heartbeatPublicationFailed" : safeErrorCode(error && error.code);
    return heartbeat();
  } finally {
    if (timer !== undefined) clearRecurring(timer);
    for (const signal of signalNames) signals.removeListener(signal, requestStop);
  }
}

async function main(argv = process.argv.slice(2)) {
  try { return await runService(parse(argv)); }
  catch (error) { return operationError(error); }
}

if (require.main === module) {
  main().then((result) => { process.stdout.write(`${JSON.stringify(result)}\n`); if (result && result.ok === false) process.exitCode = 1; });
}

module.exports = { main, parse, projectWatcherState, runService };

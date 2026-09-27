'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readAtelierSource, sourceManifest } = require('./atelier-source');
const { syncAtelier } = require('./atelier-sync');

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '..', 'config', 'atelier-refresh.json');
const TASK_CLASS = 'maintenance';
const RETRY_REASONS = new Set(['graph_missing', 'graph_invalid', 'graph_stale', 'snapshot_missing', 'graph_unavailable']);
const ORIGIN_REASONS = new Set(['origin_changed', 'origin_invalid']);

function readConfig(configPath = DEFAULT_CONFIG_PATH) {
  if (!path.isAbsolute(configPath)) throw new Error('config_path_must_be_absolute');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  validateConfig(config);
  return config;
}

function validateConfig(config) {
  if (!config || config.schema !== 'myos.atelier-refresh@v1' || typeof config.owner !== 'string' || !config.owner.trim() || config.taskClass !== TASK_CLASS) throw new Error('invalid_config');
  if (!path.isAbsolute(config.statePath) || path.extname(config.statePath) !== '.json') throw new Error('invalid_state_path');
  if (!Array.isArray(config.sources) || !config.sources.length) throw new Error('invalid_sources');
  const ids = new Set();
  for (const source of config.sources) {
    if (!source || typeof source.id !== 'string' || !source.id || ids.has(source.id) || source.mode !== 'atelier' || !path.isAbsolute(source.path)) throw new Error('invalid_source');
    ids.add(source.id);
    if (source.sourceOrigin) {
      if (!path.isAbsolute(source.sourceOrigin.path) || !source.sourceOrigin.files || !Object.keys(source.sourceOrigin.files).length) throw new Error('invalid_source_origin');
      if (pathsOverlap(config.statePath, source.sourceOrigin.path)) throw new Error('state_must_be_outside_origin');
    } else if (source.canonicalDirect !== true) throw new Error('source_origin_required');
    if (source.canonicalDirect === true) {
      if (source.sourceOrigin || !isCanonicalDirectory(source.path)) throw new Error('invalid_canonical_direct');
    }
    if (pathsOverlap(config.statePath, source.path)) throw new Error('state_must_be_outside_sources');
  }
  const retry = config.retry || {};
  if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1 || !Number.isFinite(retry.baseDelayMs) || retry.baseDelayMs < 0 || !Number.isFinite(retry.maxDelayMs) || retry.maxDelayMs < retry.baseDelayMs) throw new Error('invalid_retry');
  if (config.maxRefreshes !== undefined && (!Number.isInteger(config.maxRefreshes) || config.maxRefreshes < 1)) throw new Error('invalid_refresh_budget');
}

function canonicalPath(value) {
  let current = path.resolve(value);
  const suffix = [];
  while (true) {
    try { return path.join(fs.realpathSync(current), ...suffix); } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(value);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function pathsOverlap(first, second) {
  const a = canonicalPath(first).replace(/[\\/]$/, '');
  const b = canonicalPath(second).replace(/[\\/]$/, '');
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

function isCanonicalDirectory(value) {
  try { return fs.statSync(value).isDirectory() && fs.realpathSync(value) === value; } catch { return false; }
}

function stateTemplate() {
  return { schema: 'myos.atelier-refresh-state@v1', sources: {} };
}

function loadState(statePath) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state.schema !== 'myos.atelier-refresh-state@v1' || !state.sources || typeof state.sources !== 'object' || Array.isArray(state.sources)) throw new Error('invalid_state');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return stateTemplate();
    if (error.message === 'invalid_state' || error instanceof SyntaxError) throw new Error('state_invalid');
    throw error;
  }
}

function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temp = `${statePath}.tmp-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, statePath);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function acquireLock(statePath) {
  const lockPath = `${statePath}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let fd;
  let identity;
  try { fd = fs.openSync(lockPath, 'wx', 0o600); identity = fs.fstatSync(fd); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let stat;
    try { stat = fs.lstatSync(lockPath); } catch { return null; }
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    let owner;
    try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { return null; }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return null;
    try { process.kill(owner.pid, 0); return null; } catch (check) {
      if (check.code !== 'ESRCH') return null;
      const guard = `${lockPath}.recovery`;
      let recovery;
      try { recovery = fs.openSync(guard, 'wx', 0o600); } catch { return null; }
      try {
        const current = fs.lstatSync(lockPath);
        if (current.ino !== stat.ino || current.dev !== stat.dev) return null;
        fs.renameSync(lockPath, `${lockPath}.stale-${crypto.randomUUID()}`);
        return acquireLock(statePath);
      } finally {
        fs.closeSync(recovery);
        try { fs.unlinkSync(guard); } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw cleanup; }
      }
    }
  }
  fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid })}\n`);
  return () => {
    fs.closeSync(fd);
    try {
      const current = fs.lstatSync(lockPath);
      if (current.ino === identity.ino && current.dev === identity.dev) fs.unlinkSync(lockPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}

function failureResult(source, status, reason, attempts = 0, nextRetryAt = null) {
  return { id: source.id, status, reason, attempts, ...(nextRetryAt === null ? {} : { nextRetryAt }) };
}

function retryAt(now, attempt, retry) {
  return now + Math.min(retry.maxDelayMs, retry.baseDelayMs * (2 ** Math.max(0, attempt - 1)));
}

function runRefresh(config, options = {}) {
  validateConfig(config);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const reportBase = { taskClass: TASK_CLASS, owner: config.owner, reportedAt: new Date(now).toISOString(), sourceCount: config.sources.length };
  const release = acquireLock(config.statePath);
  if (!release) return { ...reportBase, status: 'locked', sources: [] };
  const dependencies = { readAtelierSource, syncAtelier, ...(options.dependencies || {}) };
  const retry = config.retry;
  const maxRefreshes = config.maxRefreshes ?? 5;
  let refreshes = 0;
  const report = { ...reportBase, status: 'complete', sources: [] };
  try {
    let state;
    try { state = loadState(config.statePath); } catch { return { ...report, status: 'attention', reason: 'state_invalid' }; }
    for (const source of [...config.sources].sort((a, b) => a.id.localeCompare(b.id))) {
      const prior = state.sources[source.id] || { attempts: 0 };
      let fingerprint;
      try { fingerprint = JSON.stringify(sourceManifest(source.path)); } catch { fingerprint = null; }
      const changed = fingerprint !== null && prior.fingerprint && prior.fingerprint !== fingerprint;
      const attempts = changed ? 0 : prior.attempts;
      const nextRetryAt = changed ? null : prior.nextRetryAt;
      if (nextRetryAt && nextRetryAt > now) {
        report.sources.push(failureResult(source, 'retry_scheduled', 'backoff', attempts, nextRetryAt));
        if (report.status === 'complete') report.status = 'pending';
        continue;
      }
      let read;
      try { read = dependencies.readAtelierSource(source); } catch { read = { status: 'unavailable', reason: 'read_failed' }; }
      if (read.status === 'fresh') {
        state.sources[source.id] = { status: 'fresh', attempts: 0, fingerprint, updatedAt: now };
        report.sources.push({ id: source.id, status: 'skipped', reason: 'fresh', attempts: 0 });
        continue;
      }
      const reason = read.reason || 'read_failed';
      if (source.sourceOrigin && (ORIGIN_REASONS.has(reason) || reason === 'origin_invalid')) {
        state.sources[source.id] = { status: 'blocked', attempts, fingerprint, reason: reason === 'origin_invalid' ? reason : 'origin_changed', updatedAt: now };
        report.sources.push(failureResult(source, 'blocked', state.sources[source.id].reason, attempts));
        report.status = 'attention';
        continue;
      }
      if (!RETRY_REASONS.has(reason)) {
        state.sources[source.id] = { status: 'blocked', attempts, fingerprint, reason: 'refresh_failed', updatedAt: now };
        report.sources.push(failureResult(source, 'blocked', 'refresh_failed', attempts));
        report.status = 'attention';
        continue;
      }
      if (attempts >= retry.maxAttempts) {
        state.sources[source.id] = { status: 'blocked', attempts, fingerprint, reason: 'retry_exhausted', updatedAt: now };
        report.sources.push(failureResult(source, 'blocked', 'retry_exhausted', attempts));
        report.status = 'attention';
        continue;
      }
      if (refreshes >= maxRefreshes) {
        state.sources[source.id] = { status: 'deferred', attempts, fingerprint, reason: 'refresh_budget_exhausted', updatedAt: now };
        report.sources.push(failureResult(source, 'deferred', 'refresh_budget_exhausted', attempts));
        if (report.status === 'complete') report.status = 'pending';
        continue;
      }
      try {
        refreshes += 1;
        dependencies.syncAtelier(source.path);
        const refreshed = dependencies.readAtelierSource(source);
        if (refreshed.status !== 'fresh') throw new Error('post_refresh_not_fresh');
        state.sources[source.id] = { status: 'refreshed', attempts: 0, fingerprint, updatedAt: now };
        report.sources.push({ id: source.id, status: 'refreshed', reason: 'graph_rebuilt', attempts: 0 });
      } catch (error) {
        const failedAttempts = attempts + 1;
        const failure = error.message === 'post_refresh_not_fresh' ? 'post_refresh_not_fresh' : 'refresh_failed';
        const failedNextRetryAt = retryAt(now, failedAttempts, retry);
        state.sources[source.id] = { status: 'failed', attempts: failedAttempts, fingerprint, reason: failure, nextRetryAt: failedNextRetryAt, updatedAt: now };
        report.sources.push(failureResult(source, 'failed', failure, failedAttempts, failedNextRetryAt));
        report.status = 'attention';
      }
      saveState(config.statePath, state);
    }
    saveState(config.statePath, state);
    return report;
  } finally { release(); }
}

module.exports = { DEFAULT_CONFIG_PATH, readConfig, validateConfig, runRefresh };

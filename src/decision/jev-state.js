'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');

function locations(opts = {}, env = process.env) {
  const home = env.MYOS_HOME_ROOT || path.join(os.homedir(), '.myos-dispatch');
  return { stateFile: opts.stateFile || path.join(home, 'state/jev-shadow-state.json'),
    metricsFile: opts.metricsFile || path.join(home, 'state/jev-shadow-metrics.json'),
    ledgerFile: opts.ledgerFile || path.join(home, 'logs/jev-shadow.jsonl') };
}

function readObject(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object');
    return { value, unreadable: false, missing: false };
  } catch (error) {
    return { value: {}, unreadable: error.code !== 'ENOENT', missing: error.code === 'ENOENT' };
  }
}

function readState(file, metricsFile = path.join(path.dirname(file), 'jev-shadow-metrics.json')) {
  const saved = readObject(file);
  const storedMetrics = readObject(metricsFile);
  const state = saved.value;
  const config = { stage: state.stage, promotionNote: state.promotionNote,
    authoritativeFields: Array.isArray(state.authoritativeFields) ? state.authoritativeFields.filter(field => typeof field === 'string') : [],
    floors: state.floors && typeof state.floors === 'object' && !Array.isArray(state.floors) ? state.floors : {} };
  const legacyMetrics = state.metrics && typeof state.metrics === 'object' && !Array.isArray(state.metrics) ? state.metrics : {};
  return { config, metrics: storedMetrics.missing ? legacyMetrics : storedMetrics.value,
    configUnreadable: saved.unreadable, metricsUnreadable: storedMetrics.unreadable };
}

function effectiveStage(state, env = process.env) {
  if (state.configUnreadable) return 'shadow';
  const stage = env.MYOS_JEV_STAGE ?? state.config.stage;
  return ['shadow', 'canary', 'authoritative'].includes(stage) ? stage : 'shadow';
}

function writeMetrics(file, metrics) {
  const temp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(metrics)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
    return true;
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function appendLedger(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lock = `${file}.rotate-lock`;
    let locked = false;
    try {
      if (fs.statSync(file).size > 50 * 1024 * 1024) {
        fs.mkdirSync(lock);
        locked = true;
        // Recheck under the rotation lock so concurrent hooks cannot replace an archive.
        if (fs.statSync(file).size > 50 * 1024 * 1024) {
          let date = new Date();
          let rotated;
          do {
            const stamp = date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
            rotated = path.join(path.dirname(file), `jev-shadow.${stamp}.jsonl`);
            date = new Date(date.getTime() + 1000);
          } while (fs.existsSync(rotated));
          fs.renameSync(file, rotated);
        }
      }
    } catch {} finally {
      if (locked) { try { fs.rmdirSync(lock); } catch {} }
    }
    fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  } catch { /* Observation failures must not block dispatch. */ }
}

module.exports = { locations, readState, effectiveStage, writeMetrics, appendLedger };

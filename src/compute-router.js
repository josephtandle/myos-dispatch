/**
 * compute-router.js
 *
 * Compute routing for heavy tasks (Whisper transcription, Remotion renders,
 * video generation, etc.).
 *
 * Rule:
 *   - Default for all tasks: Mac Mini (local)
 *   - Heavy tasks: try configured remote compute first, fall back to local
 *
 * Heavy task categories:
 *   - 'transcription' — Whisper audio/video transcription
 *   - 'remotion'      — Remotion video renders
 *   - 'video'         — ffmpeg video generation / processing
 *
 * Usage:
 *   const { resolveComputeTarget } = require('./compute-router');
 *   const target = await resolveComputeTarget('transcription');
 *   // target: 'vps' | 'local'
 */

'use strict';

const { spawnSync } = require('child_process');
const http = require('http');

const VPS_HOST      = process.env.MYOS_VPS_HOST || '';
const QUEUE_URL     = process.env.QUEUE_API_URL  || '';
const QUEUE_API_KEY = process.env.QUEUE_API_KEY  || '';

const HEAVY_TASK_TYPES = new Set(['transcription', 'remotion', 'video']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd, timeoutMs = 8000) {
  return spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: timeoutMs });
}

function isVpsReachable() {
  if (!VPS_HOST) return false;
  const result = run(
    `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes ${VPS_HOST} "echo ok" 2>&1`,
    8000
  );
  return result.status === 0 && result.stdout.includes('ok');
}

async function isQueueHealthy() {
  if (!QUEUE_URL) return false;
  return new Promise((resolve) => {
    const options = { timeout: 4000 };
    if (QUEUE_API_KEY) options.headers = { Authorization: `Bearer ${QUEUE_API_KEY}` };
    const req = http.get(`${QUEUE_URL}/health`, options, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body).status === 'ok'); }
        catch (_) { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve where to run a task.
 *
 * @param {string} taskType  — one of: 'transcription' | 'remotion' | 'video' | any string
 * @param {object} opts
 *   opts.force — 'vps' | 'local' to override routing
 * @returns {Promise<'vps' | 'local'>}
 */
async function resolveComputeTarget(taskType = 'general', opts = {}) {
  if (opts.force === 'vps')   return 'vps';
  if (opts.force === 'local') return 'local';

  // Only route heavy tasks away from local
  if (!HEAVY_TASK_TYPES.has(taskType)) return 'local';

  // Try VPS — prefer job queue if available (managed concurrency + retries)
  if (await isQueueHealthy()) return 'vps';
  if (isVpsReachable())       return 'vps';

  // VPS unreachable — fall back to Mac Mini
  console.warn(`[compute-router] remote compute unavailable, falling back to local for task: ${taskType}`);
  return 'local';
}

module.exports = {
  resolveComputeTarget,
  isVpsReachable,
  isQueueHealthy,
  VPS_HOST,
  QUEUE_URL,
  QUEUE_API_KEY,
  HEAVY_TASK_TYPES,
};

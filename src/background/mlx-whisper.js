'use strict';

/**
 * mlx-whisper.js
 *
 * Whisper transcription with optional remote compute routing.
 * By default, transcription runs locally. Set MYOS_VPS_HOST to enable remote
 * SSH/SCP execution, with local MLX Whisper used as fallback unless disabled.
 *
 * Usage (module):
 *   const { transcribe, buildTimestampedMarkdown } = require('./mlx-whisper');
 *   const result = await transcribe('/path/to/recording.mp4');
 *   const markdown = buildTimestampedMarkdown(result);
 *
 * Env vars:
 *   MYOS_MLX_WHISPER_MODEL  — HuggingFace model ID (default: mlx-community/whisper-large-v3-mlx)
 *   MYOS_VPS_HOST — optional SSH target for remote transcription
 *   MYOS_WHISPER_VPS_MODEL — optional remote Whisper model name
 *   MYOS_WHISPER_FORCE_LOCAL — set to '1' to force local MLX Whisper
 *   MYOS_WHISPER_ALLOW_LOCAL_FALLBACK — set to '0' to disable local fallback when remote compute is unreachable
 */

const { spawnSync, execSync, spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const VPS_HOST = process.env.MYOS_VPS_HOST || '';
const VPS_WHISPER_MODEL = process.env.MYOS_WHISPER_VPS_MODEL || 'large-v3';
const SCRIPT_PATH = path.join(__dirname, 'mlx-whisper-transcribe.py');
const DEFAULT_MODEL = process.env.MYOS_MLX_WHISPER_MODEL || 'mlx-community/whisper-large-v3-mlx';
const TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours — handles long session recordings
const REMOTE_STALE_SECONDS = Number(process.env.MYOS_WHISPER_REMOTE_STALE_SECONDS || 8 * 60 * 60);
const REMOTE_TMP_RETENTION_HOURS = Number(process.env.MYOS_WHISPER_REMOTE_TMP_RETENTION_HOURS || 24);
const LOCAL_LOCK_DIR = path.join(os.tmpdir(), 'myos-mlx-whisper-locks');
const LOCAL_CACHE_DIR = path.join(os.tmpdir(), 'myos-mlx-whisper-cache');
const LOCAL_WAIT_POLL_MS = 5000;

function sshExec(args, timeout = 20000) {
  if (!VPS_HOST) {
    return { status: 1, stdout: '', stderr: 'remote compute host is not configured' };
  }
  return spawnSync('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',
    VPS_HOST,
    ...args,
  ], { encoding: 'utf8', timeout });
}

function isVpsReachable() {
  if (process.env.MYOS_WHISPER_FORCE_LOCAL === '1') return false;
  if (!VPS_HOST) return false;
  const r = spawnSync('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=5',
    '-o', 'BatchMode=yes',
    VPS_HOST, 'echo ok',
  ], { encoding: 'utf8', timeout: 8000 });
  return r.status === 0 && r.stdout.includes('ok');
}

function secondsToTimestamp(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
}

function convertOpenaiFmt(raw) {
  const d = JSON.parse(raw);
  const segments = (d.segments || []).map(seg => {
    const entry = {
      start_time:    secondsToTimestamp(seg.start),
      end_time:      secondsToTimestamp(seg.end),
      start_seconds: Math.round(seg.start * 1000) / 1000,
      end_seconds:   Math.round(seg.end   * 1000) / 1000,
      text:          seg.text,
    };
    if (seg.words && seg.words.length > 0) {
      entry.words = seg.words.map(w => ({
        word:  w.word.trim(),
        start: Math.round(w.start * 1000) / 1000,
        end:   Math.round(w.end   * 1000) / 1000,
      })).filter(w => w.word);
    }
    return entry;
  });
  return {
    text:     d.text || '',
    language: d.language || 'en',
    model:    VPS_WHISPER_MODEL,
    segments,
  };
}

function cleanupRemoteWhisperState() {
  const remoteScript = `
set -eu
STALE_SECONDS=${REMOTE_STALE_SECONDS}
TMP_HOURS=${REMOTE_TMP_RETENTION_HOURS}
ps -eo pid=,etimes=,args= | awk '
  /whisper\\.real \\/tmp\\/whisper-in-/ || /flock \\/var\\/lock\\/myos-whisper\\.lock/ || /mkdir -p \\/tmp\\/whisper-out-/ {
    if ($2 > ${REMOTE_STALE_SECONDS}) print $1
  }
' | xargs -r kill -TERM || true
sleep 1
ps -eo pid=,etimes=,args= | awk '
  /whisper\\.real \\/tmp\\/whisper-in-/ || /flock \\/var\\/lock\\/myos-whisper\\.lock/ || /mkdir -p \\/tmp\\/whisper-out-/ {
    if ($2 > ${REMOTE_STALE_SECONDS}) print $1
  }
' | xargs -r kill -KILL || true
find /tmp -maxdepth 1 \\( -name 'whisper-in-*' -o -name 'whisper-out-*' -o -name 'whisper-progress-*.log' \\) -mmin +$((TMP_HOURS * 60)) -exec rm -rf {} + || true
`;
  const result = sshExec(['bash', '-lc', remoteScript], 30000);
  if (result.status !== 0) {
    console.warn(`[mlx-whisper] Remote cleanup warning: ${result.stderr || result.stdout}`.trim());
    return;
  }
  if (result.stdout.trim()) {
    console.log(`[mlx-whisper] Remote cleanup: ${result.stdout.trim()}`);
  }
}

async function transcribeOnVps(filePath, opts = {}) {
  if (!VPS_HOST) throw new Error('Remote transcription host is not configured');
  const basename = path.basename(filePath);
  const testimonialId = opts.testimonialId;
  const uniqueId = testimonialId ? String(testimonialId) : String(Date.now());
  const remoteFile = `/tmp/whisper-in-${uniqueId}-${basename}`;
  const remoteOutDir = `/tmp/whisper-out-${uniqueId}`;
  const remoteLog = `/tmp/whisper-progress-${uniqueId}.log`;
  const localOut = path.join(os.tmpdir(), `vps-transcript-${uniqueId}.json`);
  const language = opts.language || 'en';

  console.log(`[mlx-whisper] Routing to configured remote compute — uploading ${(fs.statSync(filePath).size / 1024 / 1024).toFixed(0)}MB...`);
  cleanupRemoteWhisperState();

  const scp = spawnSync('scp', [
    '-o', 'StrictHostKeyChecking=no',
    filePath, `${VPS_HOST}:${remoteFile}`,
  ], { encoding: 'utf8', timeout: 30 * 60 * 1000 });
  if (scp.status !== 0) throw new Error(`SCP upload failed: ${scp.stderr}`);

  // Notify caller of the log path so it can be stored in DB for the progress API
  if (opts.onLogReady) opts.onLogReady(remoteLog);

  // Launch whisper as a background job so the SSH connection can close without killing it
  const launchCmd = [
    `remoteFile='${remoteFile}'`,
    `remoteOutDir='${remoteOutDir}'`,
    `remoteLog='${remoteLog}'`,
    `mkdir -p "$remoteOutDir"`,
    `&& nohup whisper "$remoteFile" --model ${VPS_WHISPER_MODEL} --language ${language}`,
    `--output_format json --word_timestamps True --verbose True --output_dir "$remoteOutDir"`,
    `> "$remoteLog" 2>&1 < /dev/null &`,
    `echo $!`,
    `exit 0`,
  ].join('; ');

  const launch = sshExec([launchCmd], 15000);
  if (launch.error) throw new Error(`VPS launch failed: ${launch.error.message}`);
  if (launch.signal) throw new Error(`VPS launch failed: terminated by signal ${launch.signal}`);
  if (launch.status !== 0) throw new Error(`VPS launch failed: ${launch.stderr || launch.stdout}`);
  const vpsPid = launch.stdout.trim();
  console.log(`[mlx-whisper] Whisper running remotely (PID ${vpsPid}). Polling every 30s...`);

  // Poll until done — short SSH checks every 30s instead of one long-held connection
  const MAX_WAIT_MS = 4 * 60 * 60 * 1000;
  const POLL_MS = 30 * 1000;
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_WAIT_MS) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const checkCmd = `if ls ${remoteOutDir}/*.json 2>/dev/null | grep -q .; then echo DONE; elif ps -p ${vpsPid} -o pid= 2>/dev/null | grep -q .; then echo RUNNING; else echo DEAD; fi`;
    const check = sshExec([checkCmd], 20000);
    const state = check.stdout.trim();
    console.log(`[mlx-whisper] Remote: ${state} (${Math.round((Date.now() - startTime) / 60000)}m elapsed)`);
    if (state === 'DONE') break;
    if (state === 'DEAD') throw new Error('VPS whisper process exited with no output — check ' + remoteLog);
  }

  // Determine output filename (whisper strips extension, adds .json)
  const remoteName = path.basename(filePath, path.extname(filePath)) + '.json';
  const remoteJson = `${remoteOutDir}/${remoteName}`;

  const scpGet = spawnSync('scp', [
    '-o', 'StrictHostKeyChecking=no',
    `${VPS_HOST}:${remoteJson}`, localOut,
  ], { encoding: 'utf8', timeout: 5 * 60 * 1000 });
  if (scpGet.status !== 0) throw new Error(`SCP download failed: ${scpGet.stderr}`);

  // Cleanup VPS
  spawnSync('ssh', [VPS_HOST, `rm -f '${remoteFile}' '${remoteJson}' && rmdir --ignore-fail-on-non-empty '${remoteOutDir}'`],
    { encoding: 'utf8', timeout: 10000 });

  const raw = fs.readFileSync(localOut, 'utf8');
  fs.unlinkSync(localOut);

  console.log(`[mlx-whisper] Remote transcription complete.`);
  return convertOpenaiFmt(raw);
}

function shouldAllowLocalFallback() {
  return process.env.MYOS_WHISPER_ALLOW_LOCAL_FALLBACK !== '0';
}

function buildLocalKey(filePath, options) {
  const normalized = path.resolve(filePath);
  return JSON.stringify({
    filePath: normalized,
    model: options.model || DEFAULT_MODEL,
    language: options.language || '',
    wordTimestamps: options.wordTimestamps !== false,
  });
}

function digestForKey(key) {
  return crypto.createHash('sha1').update(key).digest('hex');
}

function lockPathForKey(key) {
  const digest = digestForKey(key);
  return path.join(LOCAL_LOCK_DIR, `${digest}.json`);
}

function cachePathForKey(key) {
  const digest = digestForKey(key);
  return path.join(LOCAL_CACHE_DIR, `${digest}.json`);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function acquireLocalLock(key, metadata = {}) {
  fs.mkdirSync(LOCAL_LOCK_DIR, { recursive: true });
  const lockPath = lockPathForKey(key);
  const payload = {
    pid: process.pid,
    key,
    startedAt: new Date().toISOString(),
    childPid: null,
    cachePath: cachePathForKey(key),
    ...metadata,
  };

  try {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
    } finally {
      fs.closeSync(fd);
    }
    return { lockPath, payload };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const existing = readLock(lockPath);
  if (existing && isPidAlive(existing.pid)) {
    return { lockPath, payload: existing, waiting: true };
  }

  try { fs.unlinkSync(lockPath); } catch {}
  return acquireLocalLock(key, metadata);
}

function updateLocalLock(lockPath, patch) {
  const current = readLock(lockPath) || {};
  const next = { ...current, ...patch };
  fs.writeFileSync(lockPath, JSON.stringify(next, null, 2));
}

function releaseLocalLock(lockPath) {
  try {
    const current = readLock(lockPath);
    if (!current || current.pid !== process.pid) return;
    fs.unlinkSync(lockPath);
  } catch {
    // Best effort; stale lock recovery happens on next run.
  }
}

function killProcessGroup(pid, signal = 'SIGTERM') {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch {}
  }
}

async function waitForExistingLock(lockPath, cachePath) {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, LOCAL_WAIT_POLL_MS));
    if (fs.existsSync(cachePath)) {
      const raw = fs.readFileSync(cachePath, 'utf8');
      return JSON.parse(raw);
    }
    if (!fs.existsSync(lockPath)) {
      return null;
    }
    const current = readLock(lockPath);
    if (!current || !isPidAlive(current.pid)) {
      try { fs.unlinkSync(lockPath); } catch {}
      return null;
    }
  }
}

/**
 * Transcribe an audio or video file.
 * Default path is VPS-first to preserve local CPU.
 *
 * @param {string} filePath  — absolute path to audio/video file
 * @param {object} opts
 * @param {string}  [opts.model]            — override MLX Whisper model
 * @param {string}  [opts.language]         — language code, e.g. 'en'
 * @param {boolean} [opts.wordTimestamps=true]
 * @param {number}  [opts.testimonialId]    — used to name the progress log
 * @param {function} [opts.onLogReady]      — called with log path before transcription starts
 * @returns {Promise<{ text, language, model, segments }>}
 */
async function transcribe(filePath, opts = {}) {
  const {
    model = DEFAULT_MODEL,
    language,
    wordTimestamps = true,
    testimonialId,
    onLogReady,
  } = opts;

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const localKey = buildLocalKey(filePath, { model, language, wordTimestamps });
  const localLock = acquireLocalLock(localKey, {
    filePath: path.resolve(filePath),
    model,
    language: language || '',
    wordTimestamps,
  });
  if (localLock.waiting) {
    console.log(`[mlx-whisper] Waiting for existing transcription to finish for ${path.basename(filePath)}...`);
    const reused = await waitForExistingLock(localLock.lockPath, localLock.payload.cachePath || cachePathForKey(localKey));
    if (reused) return reused;
    return transcribe(filePath, opts);
  }
  let lockReleased = false;
  const releaseLock = () => {
    if (lockReleased) return;
    lockReleased = true;
    releaseLocalLock(localLock.lockPath);
  };

  try {
    if (process.env.MYOS_WHISPER_FORCE_LOCAL !== '1') {
      if (isVpsReachable()) {
        try {
          return await transcribeOnVps(filePath, opts);
        } catch (error) {
          if (!shouldAllowLocalFallback()) throw error;
          console.warn(`[mlx-whisper] Remote transcription failed — falling back to local MLX Whisper: ${error.message}`);
        }
      }
      if (!shouldAllowLocalFallback()) {
        throw new Error('Remote MLX Whisper is unreachable and local fallback is disabled. Set MYOS_WHISPER_ALLOW_LOCAL_FALLBACK=1 or unset it to permit local transcription.');
      }
      if (VPS_HOST) console.warn('[mlx-whisper] Remote compute unavailable for transcription — falling back to local MLX Whisper');
    }

    if (!fs.existsSync(SCRIPT_PATH)) {
      throw new Error(`MLX Whisper script not found: ${SCRIPT_PATH}`);
    }

    const uniqueId = testimonialId ? String(testimonialId) : String(Date.now());
    const logPath  = `/tmp/whisper-progress-${uniqueId}.log`;

    if (onLogReady) onLogReady(logPath);

    const args = [SCRIPT_PATH, filePath, '--model', model, '--format', 'json'];
    if (language) args.push('--language', language);
    if (!wordTimestamps) args.push('--no-word-timestamps');

    console.log(`[mlx-whisper] Running locally (MLX Whisper), progress → ${logPath}`);

    const logStream = fs.createWriteStream(logPath, { flags: 'w' });

    // Use the full path to python3 so this works from launchd/server environments
    // where PATH may not include /usr/bin
    const PYTHON3 = '/usr/bin/python3';

    const raw = await new Promise((resolve, reject) => {
      const child = spawn(PYTHON3, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      updateLocalLock(localLock.lockPath, { childPid: child.pid, logPath });

      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      const cleanupHandlers = [];
      const forceStop = (signal) => {
        killProcessGroup(child.pid, signal);
      };
      const onParentExit = () => forceStop('SIGTERM');
      const register = (event, handler) => {
        process.once(event, handler);
        cleanupHandlers.push([event, handler]);
      };
      const unregister = () => {
        for (const [event, handler] of cleanupHandlers) {
          process.removeListener(event, handler);
        }
      };

      register('exit', onParentExit);
      register('SIGINT', () => {
        forceStop('SIGTERM');
        process.exit(130);
      });
      register('SIGTERM', () => {
        forceStop('SIGTERM');
        process.exit(143);
      });

      // stderr → progress log (verbose segment lines from Python)
      child.stderr.pipe(logStream);

      let stdoutBuf = '';
      child.stdout.on('data', (d) => { stdoutBuf += d; });

      const timer = setTimeout(() => {
        forceStop('SIGTERM');
        setTimeout(() => forceStop('SIGKILL'), 3000).unref();
        settle(reject, new Error('MLX Whisper timed out'));
      }, TIMEOUT_MS);

      child.on('close', (code) => {
        clearTimeout(timer);
        unregister();
        logStream.end();
        if (code !== 0) {
          const preview = stdoutBuf.slice(-200);
          settle(reject, new Error(`MLX Whisper failed (exit ${code}): ${preview}`));
        } else {
          settle(resolve, stdoutBuf.trim());
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        unregister();
        logStream.end();
        settle(reject, err);
      });
    });

    if (!raw) throw new Error('MLX Whisper produced no output');

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`MLX Whisper output parse failed: ${err.message}\n${raw.slice(0, 300)}`);
    }

    if (parsed.error) throw new Error(`MLX Whisper error: ${parsed.error}`);
    fs.mkdirSync(LOCAL_CACHE_DIR, { recursive: true });
    fs.writeFileSync(localLock.payload.cachePath, JSON.stringify(parsed));
    return parsed;
  } finally {
    releaseLock();
  }
}

/**
 * Build a timestamped markdown transcript from MLX Whisper output.
 * Format: [HH:MM:SS] text
 */
function buildTimestampedMarkdown(mlxResult) {
  const segments = mlxResult.segments || [];
  return segments
    .filter(s => s.text && s.text.trim())
    .map(s => `[${s.start_time}] ${s.text.trim()}`)
    .join('\n');
}

/**
 * Build a VTT-like array of cues (compatible with the format find-best-clips.js uses).
 * MLX Whisper does not do speaker diarization, so all cues are 'Speaker'.
 *
 * @returns {Array<{ start: string, end: string, start_seconds: number, end_seconds: number, speaker: string, text: string }>}
 */
function buildCues(mlxResult) {
  return (mlxResult.segments || [])
    .filter(s => s.text && s.text.trim())
    .map(s => ({
      start: s.start_time,
      end: s.end_time,
      start_seconds: s.start_seconds,
      end_seconds: s.end_seconds,
      speaker: 'Speaker',
      text: s.text.trim(),
    }));
}

/**
 * Save MLX Whisper output to disk as JSON.
 * Returns the saved path.
 */
function saveTranscript(mlxResult, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(mlxResult, null, 2) + '\n', 'utf8');
  return outputPath;
}

/**
 * Check (without transcribing) whether a given file would route to VPS or run locally.
 * @returns {'vps' | 'local'}
 */
function resolveBackend(filePath) {
  if (process.env.MYOS_WHISPER_FORCE_LOCAL === '1') return 'local';
  if (isVpsReachable()) return 'vps';
  return shouldAllowLocalFallback() ? 'local' : 'vps';
}

module.exports = {
  transcribe,
  buildTimestampedMarkdown,
  buildCues,
  saveTranscript,
  resolveBackend,
  DEFAULT_MODEL,
};

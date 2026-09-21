"use strict";
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const os = require("node:os");

async function readCodexInventory(options = {}) {
  if (process.platform === "win32" && !options.spawnImpl) return null;
  return new Promise(resolve => {
    const child = (options.spawnImpl || spawn)("codex", ["app-server", "-c", 'forced_login_method="chatgpt"', "-c", 'model_provider="openai"'], {
      env: options.env, cwd: options.cwd || os.homedir(), detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = null, stopping = false, id = 0, bytes = 0, hardStop;
    const models = [], cursors = new Set();
    const signal = name => {
      try {
        if (options.spawnImpl) child.kill(name);
        else if (child.pid) process.kill(-child.pid, name);
      } catch { /* Already exited. */ }
    };
    const stop = value => {
      if (stopping) return;
      stopping = true; output = value;
      signal("SIGTERM");
      hardStop = setTimeout(() => { signal("SIGKILL"); child.stdout.destroy(); child.stderr.destroy(); resolve(null); }, 500);
    };
    const timer = setTimeout(() => stop(null), options.timeoutMs || 8000);
    const send = message => { if (!stopping) child.stdin.write(JSON.stringify(message) + "\n"); };
    child.once("error", () => stop(null));
    child.stdin.on("error", () => stop(null));
    child.stderr.on("data", chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) stop(null); });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", line => {
      bytes += Buffer.byteLength(line);
      if (bytes > 1024 * 1024 || stopping) return stop(null);
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== id) return;
      if (message.error) return stop(null);
      if (id === 0) {
        send({ method: "initialized", params: {} });
        send({ method: "model/list", id: ++id, params: { limit: 100, includeHidden: true } });
        return;
      }
      if (!Array.isArray(message.result?.data)) return stop(null);
      models.push(...message.result.data);
      const cursor = message.result.nextCursor;
      if (!cursor) return stop(models);
      if (cursors.has(cursor) || cursors.size >= 20) return stop(null);
      cursors.add(cursor);
      send({ method: "model/list", id: ++id, params: { limit: 100, includeHidden: true, cursor } });
    });
    child.once("close", () => { clearTimeout(timer); clearTimeout(hardStop); lines.close(); resolve(output); });
    send({ method: "initialize", id, params: { clientInfo: { name: "myos-dispatch-doctor", version: "1.0.0" } } });
  });
}
module.exports = { readCodexInventory };

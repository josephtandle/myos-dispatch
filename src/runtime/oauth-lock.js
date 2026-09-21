"use strict";
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

function acquireLock(file) {
  if (process.platform === "darwin") {
    // Native atomic dot locking validates the owning PID and reclaims dead
    // owners. PID reuse conservatively remains locked, never steals live work.
    const result = spawnSync("/usr/bin/shlock", ["-p", String(process.pid), "-f", file], { timeout: 1000, encoding: "utf8" });
    if (result.status !== 0) {
      const error = new Error(`OAuth registry lock is held or unavailable: ${result.error?.code || result.status}`);
      error.code = "EEXIST";
      throw error;
    }
    fs.chmodSync(file, 0o600);
  } else {
    // Other hosts fail closed on stale locks; operator recovery is required.
    // Never guess ownership from an age threshold.
    const fd = fs.openSync(file, "wx", 0o600);
    try { fs.writeFileSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
  }
  return () => {
    if (fs.readFileSync(file, "utf8").trim() !== String(process.pid)) throw new Error("OAuth registry lock ownership changed");
    fs.unlinkSync(file);
  };
}
module.exports = { acquireLock };

#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const AGENT_FILE_PATTERN = /^myos-[a-z0-9-]+\.toml$/;
const MANIFEST_FILE = ".myos-dispatch-agents.json";

function parseArgs(argv = []) {
  const args = { source: "", target: "", dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--source") args.source = argv[++index] || "";
    else if (arg.startsWith("--source=")) args.source = arg.slice("--source=".length);
    else if (arg === "--target") args.target = argv[++index] || "";
    else if (arg.startsWith("--target=")) args.target = arg.slice("--target=".length);
  }
  return args;
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function syncCodexAgents(options = {}) {
  const home = options.home || process.env.HOME || os.homedir();
  const source = path.resolve(options.source || path.join(home, ".myos", "workspace", ".codex", "agents"));
  const target = path.resolve(options.target || path.join(home, ".codex", "agents"));
  const files = fs.existsSync(source)
    ? fs.readdirSync(source).filter((file) => AGENT_FILE_PATTERN.test(file)).sort()
    : [];
  const manifest = {
    schemaVersion: 1,
    source,
    target,
    generatedAt: new Date().toISOString(),
    files: [],
  };
  for (const file of files) {
    const content = fs.readFileSync(path.join(source, file), "utf8");
    manifest.files.push({ file, sha256: sha256(content) });
    if (!options.dryRun) {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, file), content, "utf8");
    }
  }
  if (!options.dryRun) {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  return manifest;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = syncCodexAgents(args);
  process.stdout.write(
    `[sync-codex-agents] ${args.dryRun ? "would sync" : "synced"} ${manifest.files.length} MyOS agent profile(s) to ${manifest.target}\n`,
  );
}

if (require.main === module) main();

module.exports = {
  AGENT_FILE_PATTERN,
  MANIFEST_FILE,
  parseArgs,
  sha256,
  syncCodexAgents,
};

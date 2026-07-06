#!/usr/bin/env node
"use strict";

// generate-index.js — build a generic capabilities-index.json for MyOS Dispatch.
//
// Scans a target directory for the same routing sources the dispatcher's
// capability router understands, and writes an index in the schema that
// src/capability-router.js `loadCapabilityIndex` reads (a top-level
// `capabilities` array, plus `lanes` metadata).
//
// Sources scanned (all optional; missing sources are simply skipped):
//   - *.recipe.json           -> recipe_dispatcher lane
//   - */SKILL.md frontmatter  -> worker_skill lane
//   - *.workflow.json         -> workflow lane
//   - agent-registry.json     -> worker_skill lane (generic; no domain map)
//
// This is a GENERIC, self-contained adaptation of the private
// ops/gen-capabilities.js. It ships no personal data, hardcodes no user
// paths, and NEVER fails on an empty/absent target: it writes the empty
// example schema instead so a fresh install always has a valid index.
//
// Usage:
//   node scripts/generate-index.js [--dir <scanDir>] [--out <indexPath>] [--quiet]
//
// Defaults:
//   --dir : $MYOS_HOME_ROOT/workspace, else $MYOS_HOME_ROOT, else cwd
//   --out : <repo>/config/capabilities-index.json

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const REPO_ROOT = path.resolve(__dirname, "..");
const GENERATOR_VERSION = 1;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".gitnexus",
  ".understand-anything",
  "graphify-out",
  "dist",
  "build",
  ".next",
]);

function parseArgs(argv) {
  const args = { dir: "", out: "", quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--quiet") args.quiet = true;
    else if (arg === "--dir") args.dir = argv[++i] || "";
    else if (arg.startsWith("--dir=")) args.dir = arg.slice("--dir=".length);
    else if (arg === "--out") args.out = argv[++i] || "";
    else if (arg.startsWith("--out=")) args.out = arg.slice("--out=".length);
  }
  return args;
}

function homeDir() {
  return process.env.HOME || os.homedir();
}

function defaultScanDir() {
  const homeRoot = process.env.MYOS_HOME_ROOT || path.join(homeDir(), ".myos-dispatch");
  const workspace = path.join(homeRoot, "workspace");
  if (fs.existsSync(workspace)) return workspace;
  if (fs.existsSync(homeRoot)) return homeRoot;
  return process.cwd();
}

function defaultOutPath() {
  return path.join(REPO_ROOT, "config", "capabilities-index.json");
}

function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function normalizeList(values, limit = 6) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))].slice(0, limit);
}

// Minimal YAML-ish frontmatter parser (mirrors ops/gen-capabilities.js).
function parseFrontmatter(content) {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (!lines[0] || lines[0].trim() !== "---") return {};
  const result = {};
  let i = 1;
  let currentKey = null;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "---") break;
    const listMatch = line.match(/^[ \t]+-[ \t]+(.+)$/);
    const keyMatch = line.match(/^([\w][\w_-]*):\s*(.*)$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      result[currentKey].push(listMatch[1].trim());
    } else if (keyMatch) {
      currentKey = keyMatch[1];
      const val = keyMatch[2].trim();
      result[currentKey] = val.replace(/^["']|["']$/g, "") || null;
    }
    i += 1;
  }
  return result;
}

// Recursively collect files, skipping vendored / generated dirs.
function walk(dir) {
  const found = { recipes: [], workflows: [], skills: [], registries: [] };
  if (!dir || !fs.existsSync(dir)) return found;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".recipe.json")) found.recipes.push(full);
      else if (entry.name.endsWith(".workflow.json")) found.workflows.push(full);
      else if (entry.name === "SKILL.md") found.skills.push(full);
      else if (entry.name === "agent-registry.json") found.registries.push(full);
    }
  }
  found.recipes.sort();
  found.workflows.sort();
  found.skills.sort();
  found.registries.sort();
  return found;
}

function relTo(root, filePath) {
  const rel = path.relative(root, filePath);
  return rel.startsWith("..") ? filePath : rel;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function buildCapabilities(scanDir, found, warnings) {
  const capabilities = [];
  const seenIds = new Set();

  const push = (record) => {
    if (!record || !record.id) return;
    if (seenIds.has(record.id)) return;
    seenIds.add(record.id);
    capabilities.push(record);
  };

  // Recipes -> recipe_dispatcher lane
  for (const filePath of found.recipes) {
    let m;
    try {
      m = readJson(filePath);
    } catch {
      warnings.push(`Could not parse recipe: ${relTo(scanDir, filePath)}`);
      continue;
    }
    const id = String(m.id || path.basename(filePath, ".recipe.json")).trim();
    push({
      id: `recipe:${id}`,
      type: "recipe",
      execution_lane: "recipe_dispatcher",
      source_path: relTo(scanDir, filePath),
      description: truncate(String(m.title || m.id || "Recipe").trim(), 180),
      aliases: normalizeList([m.title, m.id, ...(m.phrases || []), ...(m.tags || [])], 5),
      use_when: normalizeList(m.phrases || m.tags || [], 6),
      avoid_when: normalizeList(m.avoid_when || [], 6),
      runtime_requirements: {
        handler: m.handler ? relTo(scanDir, path.resolve(path.dirname(filePath), m.handler)) : null,
        layer: m.layer || null,
        owner: m.owner || null,
      },
      priority: m.layer === "project" ? 90 : m.layer === "agent" ? 75 : 60,
      version: Number(m.version || 1),
    });
  }

  // Skills -> worker_skill lane
  for (const filePath of found.skills) {
    const skillName = path.basename(path.dirname(filePath));
    let fm = {};
    try {
      fm = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
    } catch {
      warnings.push(`Could not parse SKILL.md: ${relTo(scanDir, filePath)}`);
    }
    const desc = truncate(fm.description || "", 140);
    const readWhen = Array.isArray(fm.read_when) ? fm.read_when : null;
    push({
      id: `skill:${fm.name || skillName}`,
      type: "skill",
      execution_lane: "worker_skill",
      source_path: relTo(scanDir, filePath),
      description: desc || `Skill ${skillName}`,
      aliases: normalizeList([fm.name, skillName], 3),
      use_when: normalizeList(readWhen || (desc ? [desc] : []), 6),
      avoid_when: [],
      runtime_requirements: { skill_markdown: relTo(scanDir, filePath) },
      priority: 40,
      version: 1,
    });
  }

  // Workflows -> workflow lane
  for (const filePath of found.workflows) {
    let m;
    try {
      m = readJson(filePath);
    } catch {
      warnings.push(`Could not parse workflow: ${relTo(scanDir, filePath)}`);
      continue;
    }
    const id = String(m.id || `workflow:${path.basename(filePath, ".workflow.json")}`);
    push({
      id: id.startsWith("workflow:") ? id : `workflow:${id}`,
      type: "workflow",
      execution_lane: "workflow",
      source_path: relTo(scanDir, filePath),
      description: truncate(String(m.description || m.id || "Workflow").trim(), 180),
      aliases: normalizeList(m.aliases || [], 8),
      use_when: normalizeList(m.use_when || [], 8),
      avoid_when: normalizeList(m.avoid_when || [], 8),
      runtime_requirements: m.runtime_requirements || {},
      priority: Number(m.priority || 80),
      version: Number(m.version || 1),
    });
  }

  // Agent registries -> worker_skill lane (generic: array of {id,name,description,tags,commands})
  for (const filePath of found.registries) {
    let registry;
    try {
      registry = readJson(filePath);
    } catch {
      warnings.push(`Could not parse agent-registry.json: ${relTo(scanDir, filePath)}`);
      continue;
    }
    const list = Array.isArray(registry) ? registry : Array.isArray(registry.agents) ? registry.agents : [];
    for (const agent of list) {
      if (!agent || !agent.id) continue;
      push({
        id: `agent:${agent.id}`,
        type: "agent",
        execution_lane: "worker_skill",
        source_path: agent.path ? String(agent.path) : `agents/${agent.id}`,
        description: truncate(String(agent.description || "").trim(), 140) || `Agent ${agent.id}`,
        aliases: normalizeList([agent.name, agent.id, ...((agent.tags || []).slice(0, 2))], 4),
        use_when: normalizeList([
          agent.description ? truncate(agent.description, 140) : null,
          Array.isArray(agent.commands) && agent.commands.length ? `Direct command: ${agent.commands.slice(0, 3).join(", ")}` : null,
        ].filter(Boolean), 3),
        avoid_when: [],
        runtime_requirements: {
          api_keys_required: Boolean(agent.requiresApiKeys),
          commands: normalizeList(agent.commands || [], 8),
        },
        priority: 50,
        version: 1,
      });
    }
  }

  return capabilities.sort((a, b) => a.id.localeCompare(b.id));
}

function buildIndex(scanDir) {
  const warnings = [];
  const found = walk(scanDir);
  const capabilities = buildCapabilities(scanDir, found, warnings);
  return {
    index: {
      schema_version: 1,
      version: 1,
      generated_at: new Date().toISOString(),
      generator_version: GENERATOR_VERSION,
      scan_dir: scanDir,
      lanes: {
        recipe_dispatcher: {
          description: "Deterministic operational execution through the recipe dispatcher.",
        },
        worker_skill: {
          description: "Adaptive planning, composition, and general capability execution.",
        },
        workflow: {
          description: "Reusable orchestration patterns.",
        },
      },
      capabilities,
    },
    warnings,
    counts: {
      recipes: found.recipes.length,
      skills: found.skills.length,
      workflows: found.workflows.length,
      registries: found.registries.length,
      capabilities: capabilities.length,
    },
  };
}

function writeIndex(outPath, index) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function run(options = {}) {
  const scanDir = options.dir ? path.resolve(options.dir) : defaultScanDir();
  const outPath = options.out ? path.resolve(options.out) : defaultOutPath();
  const { index, warnings, counts } = buildIndex(scanDir);
  writeIndex(outPath, index);
  return { scanDir, outPath, warnings, counts, index };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let result;
  try {
    result = run({ dir: args.dir, out: args.out });
  } catch (error) {
    process.stderr.write(`[generate-index] failed: ${error.message}\n`);
    process.exit(1);
    return;
  }
  if (!args.quiet) {
    const c = result.counts;
    process.stdout.write(
      `[generate-index] ${c.capabilities} capabilities ` +
      `(${c.recipes} recipes, ${c.skills} skills, ${c.workflows} workflows, ${c.registries} registries)\n` +
      `[generate-index] scanned: ${result.scanDir}\n` +
      `[generate-index] wrote:   ${result.outPath}\n`
    );
    if (result.warnings.length) {
      process.stderr.write(`[generate-index] ${result.warnings.length} warning(s):\n`);
      for (const w of result.warnings) process.stderr.write(`  - ${w}\n`);
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildIndex, run, defaultScanDir, defaultOutPath, parseFrontmatter };

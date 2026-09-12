#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { CATALOG_PATHS } = require("../src/model-catalog");

function exactId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) || value.length > 200) {
    throw new Error("An exact model ID is required (no whitespace, aliases or wildcards).");
  }
  return value;
}

function validateCatalog(catalog, provider) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog) || catalog.provider !== provider
    || !Array.isArray(catalog.models) || !Array.isArray(catalog.routing_profiles)) throw new Error("Invalid provider catalog schema");
  const ids = new Set();
  const models = new Set();
  for (const model of catalog.models) {
    if (!model || typeof model !== "object") throw new Error("Invalid model entry");
    exactId(model.id); exactId(model.model);
    if (ids.has(model.id) || models.has(model.model)) throw new Error("Duplicate model ID");
    ids.add(model.id); models.add(model.model);
  }
  const profiles = new Set();
  for (const profile of catalog.routing_profiles) {
    if (!profile || typeof profile.id !== "string" || profiles.has(profile.id) || !Array.isArray(profile.preferred)
      || profile.preferred.some(id => !ids.has(id))) throw new Error("Invalid routing profile");
    profiles.add(profile.id);
  }
  return catalog;
}

// A catalog-only replacement: no auth/config/team files or provider calls.
function replaceCatalog(target, content) {
  const previous = fs.readFileSync(target, "utf8");
  if (previous === content) return { changed: false, backup: null };
  const backup = `${target}.bak-${Date.now()}-${randomUUID()}`;
  fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
  const tmp = `${target}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, content, { flag: "wx", mode: fs.statSync(target).mode & 0o777 });
    fs.renameSync(tmp, target);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return { changed: true, backup };
}

function main(argv = process.argv.slice(2)) {
  const [action, ...rest] = argv;
  if (action === "--help" || action === "help") {
    process.stdout.write("Usage: node scripts/manage-model.js show|add|select|undo --provider openai|anthropic|google|openrouter [--catalog PATH] [--model EXACT_ID] [--profile PROFILE] [--backup PATH]\nSelect changes only that provider catalog routing profile. Add does not select or test a model.\n");
    return;
  }
  if (!["show", "add", "select", "undo"].includes(action)) throw new Error("Unknown action; use --help");
  const args = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!["--provider", "--catalog", "--model", "--profile", "--backup"].includes(key) || args[key] !== undefined || !rest[i + 1] || rest[i + 1].startsWith("--")) throw new Error(`Invalid or duplicate option: ${key}`);
    args[key] = rest[i + 1];
  }
  const provider = args["--provider"];
  if (!Object.hasOwn(CATALOG_PATHS, provider)) throw new Error("Unsupported provider; use openai, anthropic, google or openrouter");
  const target = path.resolve(args["--catalog"] || CATALOG_PATHS[provider]);
  if (fs.lstatSync(target).isSymbolicLink()) throw new Error("Refusing a symlink catalog");
  const original = fs.readFileSync(target, "utf8");
  const catalog = validateCatalog(JSON.parse(original), provider);
  if (action === "show") {
    const value = args["--model"] ? catalog.models.find(m => m.model === exactId(args["--model"])) : catalog;
    if (!value) throw new Error("Unknown exact model ID");
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  let content;
  if (action === "undo") {
    if (!args["--backup"]) throw new Error("undo requires --backup from the operation to undo");
    const backup = path.resolve(args["--backup"]);
    if (path.dirname(backup) !== path.dirname(target) || !path.basename(backup).startsWith(`${path.basename(target)}.bak-`) || fs.lstatSync(backup).isSymbolicLink()) throw new Error("Backup must belong to this catalog");
    content = fs.readFileSync(backup, "utf8");
    validateCatalog(JSON.parse(content), provider);
  } else {
    const modelId = exactId(args["--model"]);
    let model = catalog.models.find(m => m.model === modelId);
    if (action === "add") {
      if (!model) {
        model = { id: `${provider}.${modelId}`, model: modelId, verification: { status: "unverified" } };
        catalog.models.push(model);
      } else { process.stdout.write(`${JSON.stringify({ changed: false, backup: null })}\n`); return; }
    } else {
      if (!model) throw new Error(`Unknown exact model ID: ${modelId}`);
      const profile = catalog.routing_profiles.find(p => p.id === args["--profile"]);
      if (!profile) throw new Error("Unknown profile; use show and pass --profile");
      profile.preferred = [model.id, ...profile.preferred.filter(id => id !== model.id)];
    }
    validateCatalog(catalog, provider);
    content = `${JSON.stringify(catalog, null, 2)}\n`;
  }
  process.stdout.write(`${JSON.stringify(replaceCatalog(target, content))}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { main, exactId, validateCatalog, replaceCatalog };

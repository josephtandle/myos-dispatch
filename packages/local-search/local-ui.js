#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { verifyMetadata } = require("./scope");

const SESSION_CLOSED = Object.assign(new Error("session closed"), { code: "SESSION_CLOSED" });
const SESSION_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);

function terminalText(value) {
  return String(value)
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)?/gu, "")
    .replace(/\u009d[^\u0007\u009c]*(?:\u0007|\u009c)?/gu, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
}

function parseConfigPath(argv) {
  if (argv.length !== 2 || argv[0] !== "--config") return null;
  const value = argv[1];
  return typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value ? value : null;
}

function normalizedAbsolute(value) {
  return typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value;
}

async function askAbsolute(ask, output, label) {
  for (;;) {
    const value = (await ask(`${label}: `)).trim();
    if (normalizedAbsolute(value)) return value;
    output.write(`${label} must be a normalized absolute path.\n`);
  }
}

function extensions(value) {
  const parsed = value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (!parsed.length || parsed.some((item) => !/^\.[a-z0-9]+$/.test(item))) return null;
  return [...new Set(parsed)];
}

async function collectSetup(ask, output) {
  const roots = [];
  while (true) {
    const rootPath = (await ask("Exact root path, blank when finished: ")).trim();
    if (!rootPath) {
      if (roots.length) break;
      output.write("At least one explicit root is required.\n");
      continue;
    }
    if (!normalizedAbsolute(rootPath)) {
      output.write("Root path must be a normalized absolute path.\n");
      continue;
    }
    if ((await ask("Allow metadata catalogue for this root? Type yes: ")).trim().toLowerCase() !== "yes") continue;
    const contentEnabled = (await ask("Allow content indexing for this root? Type yes: ")).trim().toLowerCase() === "yes";
    let allowedExtensions;
    while (!allowedExtensions) {
      allowedExtensions = extensions(await ask("Exact comma-separated extensions, including dots: "));
      if (!allowedExtensions) output.write("Enter one or more extensions such as .md,.txt.\n");
    }
    roots.push({ id: `root${roots.length + 1}`, path: rootPath, contentEnabled, extensions: allowedExtensions });
  }
  const stateDirectory = await askAbsolute(ask, output, "Separate state directory");
  let qmd = null;
  const useQmd = (await ask("Use existing local QMD models? Type yes, or no for lexical-only: ")).trim().toLowerCase() === "yes";
  if (useQmd) {
    const nodePath = await askAbsolute(ask, output, "QMD Node 24 path");
    const packageRoot = await askAbsolute(ask, output, "QMD package root");
    const embed = await askAbsolute(ask, output, "Embedding model path");
    qmd = { nodePath, packageRoot, modelPaths: { embed } };
  } else {
    output.write("Mode: lexical-only. No model is required.\n");
  }
  return { version: 1, enabled: true, stateDirectory, roots, qmd };
}

function selectedSource(api, configPath, hit) {
  if (!hit || typeof hit.relative !== "string" || !hit.relative || path.isAbsolute(hit.relative)
    || path.normalize(hit.relative) !== hit.relative) return null;
  const config = api._internals.resolveConfig(configPath);
  const root = config.roots.find((item) => item.id === hit.rootId);
  if (!root) return null;
  const resolved = path.resolve(root.path, hit.relative);
  const relative = path.relative(root.path, resolved);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? { resolved, root } : null;
}

function sourcePath(api, configPath, hit, fresh) {
  if (!fresh || !fresh.ok || fresh.rootId !== hit.rootId || fresh.relative !== hit.relative) return null;
  const selected = selectedSource(api, configPath, hit);
  return selected && selected.resolved;
}

function printSearchStatus(output, packet) {
  const unavailable = Array.isArray(packet && packet.sourceUnavailable) ? packet.sourceUnavailable : [];
  const scan = packet && packet.contentScan && typeof packet.contentScan === "object" ? packet.contentScan : {};
  const reason = packet && typeof packet.semanticStatus === "string" ? packet.semanticStatus : "unavailable";
  const semantic = packet && packet.semanticPending === true ? "pending"
    : reason === "available" ? "ready"
      : reason === "notRequested" ? "notRequested" : "unavailable";
  output.write(
    `Search: status=${packet && packet.status ? packet.status : "unavailable"}; ` +
    `negative=${packet && packet.negativeIsComplete === true ? "complete" : "unknown"}; ` +
    `semantic=${semantic}; reason=${reason}; unavailable=${unavailable.length}; ` +
    `scan=${Number.isSafeInteger(scan.bytes) ? scan.bytes : "unknown"}/${Number.isSafeInteger(scan.limit) ? scan.limit : "unknown"}; ` +
    `scanExceeded=${scan.exceeded === true}.\n`,
  );
  if (unavailable.length) {
    const reasons = [...new Set(unavailable.map((item) => item && (item.reason || item.status)).filter(Boolean))];
    output.write(`Unavailable reasons: ${reasons.join(", ") || "not reported"}.\n`);
  }
}

async function searchAndMaybeOpen(context) {
  const { ask, output, api, configPath, adapters, controllers } = context;
  const query = (await ask("Search text: ")).trim();
  const mode = (await ask("Mode (native, filename, keyword, semantic, auto): ")).trim().toLowerCase();
  if (!query || !new Set(["native", "filename", "keyword", "semantic", "auto"]).has(mode)) {
    output.write("Search needs text and an explicit valid mode.\n");
    return;
  }
  const controller = new AbortController();
  controllers.add(controller);
  let packet;
  try {
    packet = await api.search(configPath, { query, mode }, { signal: controller.signal });
  } finally {
    controllers.delete(controller);
  }
  printSearchStatus(output, packet);
  const hits = Array.isArray(packet && packet.results) ? packet.results : [];
  hits.forEach((hit, index) => {
    const line = hit.locator && Number.isSafeInteger(hit.locator.line) ? `, line ${hit.locator.line}` : "";
    const fresh = hit.sourceReadAt ? `, checked ${hit.sourceReadAt}` : "";
    output.write(`${index + 1}. ${hit.relative}${line}${fresh}\n`);
    if (typeof hit.snippet === "string") output.write(`${hit.snippet}\n`);
  });
  if (!hits.length) {
    output.write(packet && packet.negativeIsComplete === true
      ? "No matching files were found in the completed snapshot.\n"
      : "No matching files were returned. The available evidence does not prove absence.\n");
    return;
  }
  const selection = Number((await ask("Open result number, blank to keep searching: ")).trim());
  if (!Number.isSafeInteger(selection) || selection < 1 || selection > hits.length) return;
  const hit = hits[selection - 1];
  let resolved;
  if (typeof hit.hash === "string") {
    const fresh = await api.read(configPath, { sourceId: hit.sourceId });
    if (!fresh || fresh.hash !== hit.hash) {
      output.write("Open refused: changedSource=true; reselectionRequired=true. Run a fresh search and select the result again.\n");
      return;
    }
    resolved = sourcePath(api, configPath, hit, fresh);
  } else {
    const selected = selectedSource(api, configPath, hit);
    const current = selected && (adapters.verifyMetadata || verifyMetadata)(selected.root, selected.resolved);
    resolved = current && current.ok && current.path === selected.resolved && current.relative === hit.relative
      ? selected.resolved : null;
  }
  if (!resolved) {
    output.write("Source changed or is no longer available.\n");
    return;
  }
  if ((adapters.platform || process.platform) !== "darwin") {
    output.write("Source opening is available on macOS.\n");
    return;
  }
  const run = adapters.runProcess || require("node:child_process").spawnSync;
  const opened = run("/usr/bin/open", [resolved], { shell: false, stdio: "ignore" });
  output.write(opened && opened.status === 0 ? "Open requested.\n" : "Source open failed.\n");
}

async function stopWatcher(context) {
  if (!context.watcher) return;
  const watcher = context.watcher;
  context.watcher = null;
  if (context.watchController) context.watchController.abort();
  context.watchController = null;
  await watcher.stop();
}

async function stopOwned(context) {
  for (const controller of context.controllers) controller.abort();
  await stopWatcher(context);
}

async function runCommands(context) {
  const { ask, output, api, configPath, controllers } = context;
  try {
    for (;;) {
      const command = (await ask("local-search> ")).trim().toLowerCase();
      if (command === "quit") return { ok: true, status: "closed" };
      if (command === "search") {
        await searchAndMaybeOpen(context);
        continue;
      }
      if (command === "status") {
        const current = await api.status(configPath);
        output.write(`${JSON.stringify(current, null, 2)}\n`);
        continue;
      }
      if (command === "index") {
        const controller = new AbortController();
        controllers.add(controller);
        try {
          const indexed = await api.index(configPath, { signal: controller.signal });
          output.write(`Index: ${indexed.status}.\n`);
        } finally {
          controllers.delete(controller);
        }
        continue;
      }
      if (command === "watchstart") {
        if (context.watcher) {
          output.write("Watcher is already running.\n");
          continue;
        }
        const controller = new AbortController();
        controllers.add(controller);
        let watcher;
        try {
          watcher = await api.watch(configPath, { signal: controller.signal });
        } finally {
          controllers.delete(controller);
        }
        if (watcher && watcher.ok) {
          context.watcher = watcher;
          context.watchController = controller;
          output.write("Manual foreground watcher started for this Terminal session. It is not a persistent daemon.\n");
        } else {
          controller.abort();
          output.write(`Watcher did not start (${watcher && watcher.status ? watcher.status : "unavailable"}).\n`);
        }
        continue;
      }
      if (command === "watchstop") {
        await stopWatcher(context);
        output.write("Watcher stopped.\n");
        continue;
      }
      if (command === "disable") {
        if ((await ask("Disable local search? Type yes: ")).trim().toLowerCase() !== "yes") continue;
        await stopWatcher(context);
        const current = api._internals.resolveConfig(configPath);
        await api.configure({ configPath, config: { ...current, enabled: false } });
        output.write("Local search disabled. Source files were not changed.\n");
        continue;
      }
      output.write("Commands: search, status, index, watchstart, watchstop, disable, quit.\n");
    }
  } finally {
    await stopOwned(context);
  }
}

async function main(argv = process.argv.slice(2), adapters = {}) {
  const input = adapters.input || process.stdin;
  const rawOutput = adapters.output || process.stdout;
  if (!input.isTTY || !rawOutput.isTTY) return { ok: false, status: "ttyRequired" };
  const output = { isTTY: true, write(value) { rawOutput.write(terminalText(value)); } };
  const configPath = parseConfigPath(argv);
  if (!configPath) return { ok: false, status: "invalidArguments" };
  const api = adapters.api || require(".");
  const exists = adapters.fileExists || fs.existsSync;
  let interfaceHandle;
  const rawAsk = adapters.ask || (() => {
    interfaceHandle = readline.createInterface({ input, output: rawOutput });
    return (question) => interfaceHandle.question(question);
  })();
  const signalSource = adapters.signalSource || process;
  let context;
  let stopping = false;
  let resolveStop;
  const stopped = new Promise((resolve) => { resolveStop = resolve; });
  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    if (context) {
      for (const controller of context.controllers) controller.abort();
      if (context.watchController) context.watchController.abort();
    }
    resolveStop();
  };
  const ask = (question) => Promise.race([
    Promise.resolve(rawAsk(question)),
    stopped.then(() => { throw SESSION_CLOSED; }),
  ]);
  for (const signal of SESSION_SIGNALS) signalSource.on(signal, requestStop);
  if (interfaceHandle) interfaceHandle.once("close", requestStop);
  else if (typeof input.once === "function") input.once("end", requestStop);
  try {
    if (!exists(configPath)) {
      output.write("No local-search configuration exists at the selected path.\n");
      const config = await collectSetup(ask, output);
      if (!config) return { ok: false, status: "setupCancelled" };
      output.write(`${JSON.stringify({ roots: config.roots, stateDirectory: config.stateDirectory, mode: config.qmd ? "local-qmd" : "lexical-only" }, null, 2)}\n`);
      if ((await ask("Save this exact configuration? Type yes: ")).trim().toLowerCase() !== "yes") {
        return { ok: false, status: "setupCancelled" };
      }
      await api.configure({ configPath, config });
    }
    context = { ask, output, api, configPath, adapters, controllers: new Set() };
    return await runCommands(context);
  } catch (error) {
    if (stopping || error === SESSION_CLOSED || error.code === "SESSION_CLOSED") return { ok: true, status: "closed" };
    throw error;
  } finally {
    for (const signal of SESSION_SIGNALS) signalSource.removeListener(signal, requestStop);
    if (!interfaceHandle && typeof input.removeListener === "function") input.removeListener("end", requestStop);
    if (interfaceHandle) interfaceHandle.close();
  }
}

if (require.main === module) {
  main().then((result) => {
    if (!result.ok) process.stderr.write(`Local search could not start (${result.status}).\n`);
    process.exitCode = result.ok ? 0 : 1;
  });
}

module.exports = { main };

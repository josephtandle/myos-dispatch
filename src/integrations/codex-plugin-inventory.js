"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_TIMEOUT_MS = 10_000;

function readManifest(pluginPath) {
  const manifestPath = path.join(pluginPath, ".codex-plugin", "plugin.json");
  try {
    return {
      path: manifestPath,
      value: JSON.parse(fs.readFileSync(manifestPath, "utf8")),
    };
  } catch (error) {
    return {
      path: manifestPath,
      value: null,
      error: error.message,
    };
  }
}

function componentFlags(manifest = {}) {
  return {
    skills: Boolean(manifest.skills),
    apps: Boolean(manifest.apps),
    mcpServers: Boolean(manifest.mcpServers),
    hooks: Boolean(manifest.hooks),
    commands: Boolean(manifest.commands),
  };
}

function routingPolicyForPlugin(plugin = {}) {
  const name = String(plugin.name || "").toLowerCase();
  if (name === "browser" || name === "computer-use") {
    return { authority: "myos", route: "browser_preflight_required", mutation: "interactive_only" };
  }
  if (["gmail", "google-calendar", "google-drive"].includes(name)) {
    return { authority: "myos", route: "local_google_route_first", mutation: "interactive_only" };
  }
  if (name === "github") {
    return { authority: "myos", route: "connector_or_cli", mutation: "approval_gated" };
  }
  return { authority: "myos", route: "worker_skill", mutation: "artifact_scoped" };
}

function normalizePlugin(plugin = {}) {
  const sourcePath = plugin.source?.path ? path.resolve(plugin.source.path) : null;
  const manifest = sourcePath ? readManifest(sourcePath) : { path: null, value: null, error: "missing_source_path" };
  const value = manifest.value || {};
  return {
    pluginId: String(plugin.pluginId || `${plugin.name || "unknown"}@${plugin.marketplaceName || "unknown"}`),
    name: String(plugin.name || value.name || ""),
    marketplaceName: String(plugin.marketplaceName || ""),
    version: String(plugin.version || value.version || ""),
    installed: Boolean(plugin.installed),
    enabled: Boolean(plugin.enabled),
    sourcePath,
    manifestPath: manifest.path,
    manifestValid: Boolean(manifest.value),
    manifestError: manifest.error || null,
    description: String(value.description || plugin.description || ""),
    keywords: Array.isArray(value.keywords) ? value.keywords.map(String) : [],
    defaultPrompts: Array.isArray(value.interface?.defaultPrompt)
      ? value.interface.defaultPrompt.map(String)
      : [],
    components: componentFlags(value),
    routingPolicy: routingPolicyForPlugin({ ...plugin, name: plugin.name || value.name }),
  };
}

function parsePluginList(stdout = "") {
  const parsed = JSON.parse(String(stdout || "{}"));
  const installed = Array.isArray(parsed.installed) ? parsed.installed : [];
  return installed
    .filter((plugin) => plugin && plugin.installed && plugin.enabled)
    .map(normalizePlugin)
    .sort((a, b) => a.pluginId.localeCompare(b.pluginId));
}

function inspectCodexPlugins(options = {}) {
  const command = options.command || "codex";
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const run = options.run || ((cmd, args) => spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    env: options.env || process.env,
  }));
  let result;
  try {
    result = run(command, ["plugin", "list", "--json"]);
  } catch (error) {
    return { status: "unavailable", plugins: [], error: error.message };
  }
  if (result?.error || result?.status !== 0) {
    return {
      status: "unavailable",
      plugins: [],
      error: result?.error?.message || String(result?.stderr || "codex plugin list failed").trim(),
    };
  }
  try {
    return {
      status: "ok",
      plugins: parsePluginList(result.stdout),
      error: null,
    };
  } catch (error) {
    return { status: "invalid", plugins: [], error: error.message };
  }
}

function pluginsToCapabilityRecords(plugins = []) {
  return plugins.map((plugin) => ({
    id: `plugin:${plugin.pluginId}`,
    type: "skill",
    execution_lane: "worker_skill",
    source_path: plugin.manifestPath || plugin.sourcePath || "",
    description: plugin.description || `Codex plugin ${plugin.name}`,
    aliases: [...new Set([plugin.name, plugin.pluginId, ...(plugin.keywords || [])].filter(Boolean))].slice(0, 6),
    use_when: (plugin.defaultPrompts || []).slice(0, 6),
    avoid_when: [],
    runtime_requirements: {
      codex_plugin: true,
      plugin_id: plugin.pluginId,
      components: plugin.components,
      routing_policy: plugin.routingPolicy,
      advisory_only: true,
    },
    priority: 35,
    version: 1,
  }));
}

module.exports = {
  componentFlags,
  inspectCodexPlugins,
  normalizePlugin,
  parsePluginList,
  pluginsToCapabilityRecords,
  routingPolicyForPlugin,
};

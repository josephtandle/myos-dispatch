"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

function loadRegistryWithEnv(env, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const modulePath = require.resolve("../src/data-source-registry");
  delete require.cache[modulePath];
  try {
    return fn(require("../src/data-source-registry"));
  } finally {
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    delete require.cache[modulePath];
  }
}

test("data source registry defaults to no configured sources", () => {
  loadRegistryWithEnv({ MYOS_DATA_SOURCES_CONFIG: undefined }, (registry) => {
    assert.deepEqual(registry.getConfiguredDataSources({ config: { version: 1, dataSources: [] } }), []);
    assert.equal(registry.getDataSearchScope(["entities"], { config: { version: 1, dataSources: [] } }), "");
  });
});

test("data source registry resolves configured workspace paths and reads content", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-source-registry-"));
  const workspaceRoot = path.join(homeDir, ".myos", "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "data"), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "data", "entities.md"), "# Entities\nExample Holdings LLC\n", "utf8");
  const configPath = path.join(workspaceRoot, "data-sources.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      dataSources: [
        { id: "entities", label: "entities.md", mode: "content", path: "data/entities.md" },
      ],
    }),
    "utf8",
  );

  loadRegistryWithEnv({ HOME: homeDir, MYOS_DATA_SOURCES_CONFIG: configPath }, (registry) => {
    const source = registry.getDataSource("entities");
    assert.equal(source.label, "entities.md");
    assert.equal(source.path, path.join(workspaceRoot, "data", "entities.md"));
    assert.match(registry.getDataSearchScope(["entities"]), /entities\.md$/);
    assert.match(registry.readConfiguredTextSource("entities"), /Example Holdings LLC/);
  });
});

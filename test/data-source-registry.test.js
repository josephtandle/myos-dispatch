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

test("data source registry resolves configured workspace paths and reads content", (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "data-source-registry-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
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

  loadRegistryWithEnv({ HOME: homeDir, MYOS_HOME_ROOT: path.join(homeDir, ".myos"), OPENCLAW_HOME_ROOT: path.join(homeDir, ".myos"), MYOS_DATA_SOURCES_CONFIG: configPath }, (registry) => {
    const source = registry.getDataSource("entities");
    assert.equal(source.label, "entities.md");
    assert.equal(source.path, path.join(workspaceRoot, "data", "entities.md"));
    assert.match(registry.getDataSearchScope(["entities"]), /entities\.md$/);
    assert.match(registry.readConfiguredTextSource("entities"), /Example Holdings LLC/);
  });
});

for (const override of ["none", "/missing/data-sources.json"]) {
  test(`data source override ${override} excludes repo-local config`, (t) => {
    const registry = require("../src/data-source-registry");
    const readFileSync = fs.readFileSync;
    const existsSync = fs.existsSync;
    const localConfig = { version: 1, dataSources: [{ id: "live-source" }] };
    t.mock.method(fs, "existsSync", (file) => file === registry.LOCAL_CONFIG_FILE || existsSync(file));
    t.mock.method(fs, "readFileSync", (file, ...args) => file === registry.LOCAL_CONFIG_FILE
      ? JSON.stringify(localConfig) : readFileSync(file, ...args));
    assert.deepEqual(registry.loadDataSourcesConfig({ env: { MYOS_DATA_SOURCES_CONFIG: override } }),
      JSON.parse(readFileSync(registry.DEFAULT_CONFIG_FILE, "utf8")));
  });
}

test("normalization preserves a trusted Atelier source origin", () => {
  const sourceOrigin = { path: "/tmp/canonical-origin", files: { "brain.md": "a".repeat(64) } };
  const [source] = require("../src/data-source-registry").getConfiguredDataSources({
    config: { version: 1, dataSources: [{ id: "atelier", mode: "atelier", path: "/tmp/view", sourceOrigin }] },
  });
  assert.deepEqual(source.sourceOrigin, sourceOrigin);
});

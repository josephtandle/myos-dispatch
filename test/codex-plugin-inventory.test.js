"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  inspectCodexPlugins,
  pluginsToCapabilityRecords,
  routingPolicyForPlugin,
} = require("../src/integrations/codex-plugin-inventory");

test("plugin inventory is read-only, filters disabled plugins, and keeps MyOS authoritative", () => {
  let received;
  const inventory = inspectCodexPlugins({
    run(command, args) {
      received = { command, args };
      return {
        status: 0,
        stdout: JSON.stringify({
          installed: [
            {
              pluginId: "browser@openai-bundled",
              name: "browser",
              marketplaceName: "openai-bundled",
              version: "1.0.0",
              installed: true,
              enabled: true,
            },
            {
              pluginId: "disabled@example",
              name: "disabled",
              installed: true,
              enabled: false,
            },
          ],
        }),
      };
    },
  });

  assert.deepEqual(received, { command: "codex", args: ["plugin", "list", "--json"] });
  assert.equal(inventory.status, "ok");
  assert.equal(inventory.plugins.length, 1);
  assert.equal(inventory.plugins[0].routingPolicy.route, "browser_preflight_required");
  assert.equal(inventory.plugins[0].routingPolicy.authority, "myos");
});

test("plugin capability records remain advisory and lower-priority", () => {
  const records = pluginsToCapabilityRecords([{
    pluginId: "google-drive@openai-curated",
    name: "google-drive",
    description: "Drive tools",
    keywords: [],
    defaultPrompts: [],
    components: {},
    routingPolicy: routingPolicyForPlugin({ name: "google-drive" }),
  }]);
  assert.equal(records[0].priority, 35);
  assert.equal(records[0].runtime_requirements.advisory_only, true);
  assert.equal(records[0].runtime_requirements.routing_policy.route, "local_google_route_first");
});

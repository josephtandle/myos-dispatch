"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { readCodexInventory } = require("../src/runtime/oauth-codex-inventory");

test("Codex metadata discovery initializes, follows pagination and never requests a model turn", async () => {
  const methods = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit("close", 0)); };
    child.stdin.on("data", data => {
      const message = JSON.parse(String(data)); methods.push(message.method);
      let result;
      if (message.method === "initialize") result = {};
      if (message.method === "model/list") result = message.params.cursor
        ? { data: [{ model: "fixture-b", hidden: true }], nextCursor: null }
        : { data: [{ model: "fixture-a", hidden: false }], nextCursor: "next" };
      if (result) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result }) + "\n"));
    });
    return child;
  };
  const result = await readCodexInventory({ spawnImpl, timeoutMs: 1000, env: {} });
  assert.deepEqual(result?.map(model => model.model), ["fixture-a", "fixture-b"]);
  assert.deepEqual(methods, ["initialize", "initialized", "model/list", "model/list"]);
});

"use strict";

const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const test = require("node:test");
const assert = require("node:assert/strict");

function loadComputeRouter() {
  const modulePath = require.resolve("../src/compute-router");
  delete require.cache[modulePath];
  return require("../src/compute-router");
}

function withEnv(env, fn) {
  const previous = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(env)) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
      delete require.cache[require.resolve("../src/compute-router")];
    });
}

function mockHttpHealth(t, { body, error, capture }) {
  t.mock.method(http, "get", (url, options, callback) => {
    capture?.({ url, options });
    const req = new EventEmitter();
    req.destroy = () => {};

    process.nextTick(() => {
      if (error) {
        req.emit("error", error);
        return;
      }

      const res = new EventEmitter();
      callback(res);
      process.nextTick(() => {
        if (body !== undefined) res.emit("data", body);
        res.emit("end");
      });
    });

    return req;
  });
}

test("resolveComputeTarget returns local for non-heavy task types without network checks", async (t) => {
  t.mock.method(childProcess, "spawnSync", () => {
    throw new Error("ssh should not be called for non-heavy tasks");
  });
  t.mock.method(http, "get", () => {
    throw new Error("queue health should not be called for non-heavy tasks");
  });

  const router = loadComputeRouter();
  assert.equal(await router.resolveComputeTarget("general"), "local");
  assert.equal(await router.resolveComputeTarget("image_resize"), "local");
});

test("resolveComputeTarget honors explicit force overrides", async (t) => {
  t.mock.method(childProcess, "spawnSync", () => {
    throw new Error("ssh should not be called when forced");
  });
  t.mock.method(http, "get", () => {
    throw new Error("queue health should not be called when forced");
  });

  const router = loadComputeRouter();
  assert.equal(await router.resolveComputeTarget("general", { force: "vps" }), "vps");
  assert.equal(await router.resolveComputeTarget("transcription", { force: "local" }), "local");
});

test("heavy task routes to vps when the queue is healthy", async (t) => {
  t.mock.method(childProcess, "spawnSync", () => {
    throw new Error("ssh should not be called when queue is healthy");
  });
  mockHttpHealth(t, { body: JSON.stringify({ status: "ok" }) });

  await withEnv({ QUEUE_API_URL: "http://queue.test:15000" }, async () => {
    const router = loadComputeRouter();
    assert.equal(await router.resolveComputeTarget("transcription"), "vps");
  });
});

test("heavy task routes to vps when queue is unhealthy but ssh reaches the VPS", async (t) => {
  t.mock.method(childProcess, "spawnSync", () => ({
    status: 0,
    stdout: "ok\n",
    stderr: "",
  }));
  mockHttpHealth(t, { body: JSON.stringify({ status: "down" }) });

  await withEnv({ QUEUE_API_URL: "http://queue.test:15000", MYOS_VPS_HOST: "remote.example" }, async () => {
    const router = loadComputeRouter();
    assert.equal(await router.resolveComputeTarget("remotion"), "vps");
    assert.equal(router.isVpsReachable(), true);
  });
});

test("heavy task gracefully falls back to local when queue and VPS are unreachable", async (t) => {
  const warnings = [];
  t.mock.method(childProcess, "spawnSync", () => ({
    status: 255,
    stdout: "",
    stderr: "connection timed out",
  }));
  t.mock.method(console, "warn", (message) => warnings.push(message));
  mockHttpHealth(t, { error: new Error("queue unreachable") });

  await withEnv({ QUEUE_API_URL: "http://queue.test:15000", MYOS_VPS_HOST: "remote.example" }, async () => {
    const router = loadComputeRouter();
    assert.equal(await router.resolveComputeTarget("video"), "local");
    assert.match(warnings[0], /falling back to local/);
    assert.equal(router.isVpsReachable(), false);
  });
});

test("queue helper treats malformed health responses as unhealthy", async (t) => {
  mockHttpHealth(t, { body: "not json" });

  await withEnv({ QUEUE_API_URL: "http://queue.test:15000" }, async () => {
    const router = loadComputeRouter();
    assert.equal(await router.isQueueHealthy(), false);
  });
});

test("queue helper destroys timed out requests and treats them as unhealthy", async (t) => {
  let destroyed = false;
  t.mock.method(http, "get", (url, options, callback) => {
    assert.equal(url, "http://queue.test:15000/health");
    assert.equal(options.timeout, 4000);
    assert.equal(typeof callback, "function");

    const req = new EventEmitter();
    req.destroy = () => {
      destroyed = true;
    };
    process.nextTick(() => req.emit("timeout"));
    return req;
  });

  const router = await withEnv({ QUEUE_API_URL: "http://queue.test:15000", QUEUE_API_KEY: undefined }, () => loadComputeRouter());
  assert.equal(await router.isQueueHealthy(), false);
  assert.equal(destroyed, true);
});

test("VPS reachability requires status 0 and stdout containing ok", async (t) => {
  t.mock.method(childProcess, "spawnSync", () => ({
    status: 0,
    stdout: "connected\n",
    stderr: "",
  }));

  await withEnv({ MYOS_VPS_HOST: "remote.example" }, async () => {
    const router = loadComputeRouter();
    assert.equal(router.isVpsReachable(), false);
  });
});

test("QUEUE_URL defaults empty and disables queue probing when QUEUE_API_URL is unset", async (t) => {
  const calls = [];
  mockHttpHealth(t, {
    body: JSON.stringify({ status: "ok" }),
    capture: (call) => calls.push(call),
  });

  await withEnv(
    {
      QUEUE_API_URL: undefined,
      QUEUE_API_KEY: undefined,
    },
    async () => {
      const router = loadComputeRouter();
      assert.equal(router.QUEUE_URL, "");
      assert.equal(router.QUEUE_API_KEY, "");
      assert.equal(await router.isQueueHealthy(), false);
      assert.equal(calls.length, 0);
    },
  );
});

test("QUEUE_API_URL and QUEUE_API_KEY env vars are captured at module load", async (t) => {
  const calls = [];
  mockHttpHealth(t, {
    body: JSON.stringify({ status: "ok" }),
    capture: (call) => calls.push(call),
  });

  await withEnv(
    {
      QUEUE_API_URL: "http://queue.test:15000",
      QUEUE_API_KEY: "test-key",
    },
    async () => {
      const router = loadComputeRouter();
      assert.equal(router.QUEUE_URL, "http://queue.test:15000");
      assert.equal(router.QUEUE_API_KEY, "test-key");
      assert.equal(await router.isQueueHealthy(), true);
      assert.equal(calls[0].url, "http://queue.test:15000/health");
      assert.equal(calls[0].options.timeout, 4000);
    },
  );
});

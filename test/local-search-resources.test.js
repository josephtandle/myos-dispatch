"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { normalizeConfig } = require("../packages/local-search/config");
const { acquireInference, acquireInferenceWithMemory, evaluateBackground, loadResourceStatus, maintenanceReservation, memoryAdmission, prepareEmbeddingPlan, publishResourceStatus, storageAdmission } = require("../packages/local-search/resources");
const api = require("../packages/local-search");

const RESOURCE_MODULE = path.resolve(__dirname, "../packages/local-search/resources.js");
const MAINTENANCE_WORKER = path.resolve(__dirname, "../packages/local-search/maintenance-worker.mjs");

function fixture(t, overrides = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "local-search-resources-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "root");
  fs.mkdirSync(root);
  const input = {
    enabled: true,
    stateDirectory: path.join(base, "state"),
    roots: [{ id: "docs", path: root, contentEnabled: true, extensions: [".md"], maxFiles: 10, maxFileBytes: 1024 }],
    budgets: { quotaBytes: 1024 ** 2, reserveBytes: 1, reserveFraction: 0.000001, writeScratchBytes: 1024 },
    resourcePolicy: {
      inferenceWaitMs: 321,
      background: { idleDwellMs: 300_000, healthyDwellMs: 120_000, sampleGapMs: 60_000, probeTimeoutMs: 700, probeOutputBytes: 4096 },
      memory: { minimumAvailableBytes: 1024, modelSizeMultiplier: 2, fixedOverheadBytes: 1024, probeTimeoutMs: 500, probeOutputBytes: 4096 },
    },
    ...overrides,
  };
  return { base, input };
}

test("resource policy round-trips through normalization", (t) => {
  const { input } = fixture(t);
  const first = normalizeConfig(input);
  const second = normalizeConfig(JSON.parse(JSON.stringify(first)));
  assert.deepEqual(second.resourcePolicy, {
    inferenceWaitMs: 321,
    background: { idleDwellMs: 300_000, healthyDwellMs: 120_000, sampleGapMs: 60_000, probeTimeoutMs: 700, probeOutputBytes: 4096 },
    memory: { minimumAvailableBytes: 1024, modelSizeMultiplier: 2, fixedOverheadBytes: 1024, probeTimeoutMs: 500, probeOutputBytes: 4096 },
  });
});

test("maintenance write reservation policy is explicit and bounded", (t) => {
  const { input } = fixture(t);
  input.budgets.maintenanceMaxFiles = 7;
  input.budgets.maintenanceMaxSourceBytes = 4096;
  input.budgets.writeAmplification = 5;
  input.budgets.embeddingDimensions = 384;
  input.budgets.embeddingBytesPerDimension = 8;
  input.budgets.writeScratchBytes = 8192;
  const config = normalizeConfig(input);
  assert.deepEqual({
    maintenanceMaxFiles: config.budgets.maintenanceMaxFiles,
    maintenanceMaxSourceBytes: config.budgets.maintenanceMaxSourceBytes,
    writeAmplification: config.budgets.writeAmplification,
    embeddingDimensions: config.budgets.embeddingDimensions,
    embeddingBytesPerDimension: config.budgets.embeddingBytesPerDimension,
    writeScratchBytes: config.budgets.writeScratchBytes,
  }, {
    maintenanceMaxFiles: 7,
    maintenanceMaxSourceBytes: 4096,
    writeAmplification: 5,
    embeddingDimensions: 384,
    embeddingBytesPerDimension: 8,
    writeScratchBytes: 8192,
  });
});

test("maintenance reserves amplified vector payload and rows per exact chunk", (t) => {
  const { base, input } = fixture(t);
  input.budgets.writeAmplification = 2;
  input.budgets.embeddingDimensions = 3;
  input.budgets.embeddingBytesPerDimension = 4;
  input.budgets.writeScratchBytes = 100;
  const model = path.join(base, "configured-model.gguf");
  fs.writeFileSync(model, "GGUFmodel", { mode: 0o600 });
  const config = normalizeConfig({
    ...input,
    qmd: { nodePath: process.execPath, packageRoot: base, modelPaths: { embed: model } },
  });
  const oneChunk = maintenanceReservation(config, 1, 10, 1);
  const fourChunks = maintenanceReservation(config, 1, 10, 4);
  assert.equal(oneChunk.vectorChunks, 1);
  assert.equal(oneChunk.vectorValueBytes, 12);
  assert.ok(oneChunk.vectorRowBytes > 0);
  assert.equal(
    fourChunks.embeddingRequestedBytes - config.budgets.writeScratchBytes,
    4 * (oneChunk.embeddingRequestedBytes - config.budgets.writeScratchBytes),
  );
  assert.equal(
    fourChunks.requestedBytes,
    fourChunks.stagedAndIndexBytes + fourChunks.amplifiedVectorBytes + fourChunks.walAndScratchBytesPerPhase,
  );
  assert.match(fourChunks.limitation, /not a hard quota promise/);
});

function childCode() {
  return `
    const fs=require('node:fs');
    const {acquireInference}=require(process.argv[1]);
    const stateDirectory=process.argv[2], trace=process.argv[3], hold=Number(process.argv[4]);
    const config={stateDirectory,resourcePolicy:{inferenceWaitMs:5000}};
    const abort=new AbortController();
    process.on('SIGTERM',()=>abort.abort());
    if(process.send)process.send('waiting');
    acquireInference(config,{signal:abort.signal}).then(async lock=>{
      fs.appendFileSync(trace,'START '+process.pid+'\\n');
      if(process.send)process.send('acquired');
      await new Promise(r=>setTimeout(r,hold));
      fs.appendFileSync(trace,'END '+process.pid+'\\n');
      lock.release();
    }).catch(error=>{if(process.send)process.send(error.code);process.exitCode=error.code==='ABORTED'?0:1});
  `;
}

function runContender(stateDirectory, trace, hold = 40) {
  return spawn(process.execPath, ["-e", childCode(), RESOURCE_MODULE, stateDirectory, trace, String(hold)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
}

function finished(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`child ${code}/${signal}: ${stderr}`)));
  });
}

function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function runJsonChild(program, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [program], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code !== 0) return reject(new Error(`child ${code}/${signal}: ${Buffer.concat(stderr)}`));
      try { resolve(JSON.parse(Buffer.concat(stdout).toString("utf8"))); }
      catch (error) { reject(new Error(`invalid child JSON: ${error.message}: ${Buffer.concat(stdout)}`)); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function syntheticQmd(base, marker) {
  const packageRoot = path.join(base, "qmd");
  const dist = path.join(packageRoot, "dist");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@tobilu/qmd", version: "2.8.3", type: "module" }));
  fs.writeFileSync(path.join(dist, "llm.js"), "export async function disposeDefaultLlamaCpp() {}\n");
  const modelLoadMarker = `${marker}.model`;
  const embedMarker = `${marker}.embed`;
  fs.writeFileSync(path.join(dist, "store.js"), `
    import fs from "node:fs";
    export async function chunkDocumentByTokens(content) {
      fs.writeFileSync(${JSON.stringify(modelLoadMarker)}, "loaded");
      return content.split("|").map((text, pos) => ({text, pos, tokens: 1}));
    }
  `);
  fs.writeFileSync(path.join(dist, "index.js"), `
    import fs from "node:fs";
    export async function createStore({dbPath}) { return {
      async update() { fs.appendFileSync(dbPath, Buffer.alloc(512 * 1024)); fs.writeFileSync(${JSON.stringify(marker)}, "wrote"); return {indexed: 1, updated: 0}; },
      async embed() { fs.writeFileSync(${JSON.stringify(embedMarker)}, "embedded"); return {embedded: 1, skipped: 0, failed: 0, errors: []}; },
      async close() {},
    }; }
  `);
  const model = path.join(base, "embed.gguf");
  fs.writeFileSync(model, "GGUFmodel", { mode: 0o600 });
  return { packageRoot, model, modelLoadMarker, embedMarker };
}

function message(child, expected = "acquired") {
  return new Promise((resolve, reject) => {
    const received = (value) => { if (value === expected) { cleanup(); resolve(value); } };
    const failed = (error) => { cleanup(); reject(error); };
    const exited = (code, signal) => { cleanup(); reject(new Error(`child exited before message: ${code}/${signal}`)); };
    const cleanup = () => { child.removeListener("message", received); child.removeListener("error", failed); child.removeListener("exit", exited); };
    child.on("message", received);
    child.once("error", failed);
    child.once("exit", exited);
  });
}

for (const count of [2, 4, 8]) test(`${count} processes admit at most one heavy operation`, async (t) => {
  const { base, input } = fixture(t);
  const config = normalizeConfig(input);
  fs.mkdirSync(config.stateDirectory, { mode: 0o700 });
  const trace = path.join(base, "trace");
  const children = Array.from({ length: count }, () => runContender(config.stateDirectory, trace));
  await Promise.all(children.map(finished));
  let active = 0;
  let maximum = 0;
  for (const line of fs.readFileSync(trace, "utf8").trim().split("\n")) {
    active += line.startsWith("START") ? 1 : -1;
    maximum = Math.max(maximum, active);
    assert.ok(active >= 0);
  }
  assert.equal(active, 0);
  assert.equal(maximum, 1);
});

test("a killed owner releases the SQLite inference transaction", async (t) => {
  const { base, input } = fixture(t);
  const config = normalizeConfig(input);
  fs.mkdirSync(config.stateDirectory, { mode: 0o700 });
  const trace = path.join(base, "trace");
  const owner = runContender(config.stateDirectory, trace, 60_000);
  assert.equal(await message(owner), "acquired");
  owner.kill("SIGKILL");
  await exited(owner);
  const successor = runContender(config.stateDirectory, trace, 1);
  assert.equal(await message(successor), "acquired");
  await finished(successor);
});

test("cancellation while waiting never reports an acquired slot", async (t) => {
  const { base, input } = fixture(t);
  const config = normalizeConfig(input);
  fs.mkdirSync(config.stateDirectory, { mode: 0o700 });
  const trace = path.join(base, "trace");
  const owner = runContender(config.stateDirectory, trace, 60_000);
  t.after(() => { if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL"); });
  assert.equal(await message(owner), "acquired");
  const waiter = runContender(config.stateDirectory, trace, 1);
  t.after(() => { if (waiter.exitCode === null && waiter.signalCode === null) waiter.kill("SIGKILL"); });
  const waiterMessage = message(waiter, "ABORTED");
  await message(waiter, "waiting");
  waiter.kill("SIGTERM");
  assert.equal(await waiterMessage, "ABORTED");
  await finished(waiter);
  owner.kill("SIGKILL");
  await exited(owner);
  assert.equal(fs.readFileSync(trace, "utf8").trim().split("\n").filter((line) => line.startsWith("START")).length, 1);
});

test("memory is resampled inside the held slot and a failed sample releases it", async (t) => {
  const { base, input } = fixture(t);
  const model = path.join(base, "resample-model.gguf");
  fs.writeFileSync(model, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(1024)]), { mode: 0o600 });
  const config = normalizeConfig({
    ...input,
    qmd: { nodePath: process.execPath, packageRoot: base, modelPaths: { embed: model } },
  });
  const readings = { availableBytes: 16 * 1024 ** 2, totalBytes: 32 * 1024 ** 2 };
  assert.equal(memoryAdmission(config, { readings }).ok, true);
  const owner = await acquireInference(config);
  const waiting = acquireInferenceWithMemory(config, { memoryOptions: { readings }, timeoutMs: 500 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  readings.availableBytes = 1;
  owner.release();
  const result = await waiting;
  assert.equal(result.ok, false);
  assert.equal(result.status, "memoryHeadroom");
  const successor = await acquireInference(config, { timeoutMs: 100 });
  successor.release();
});

test("storage admission counts state and unique external model bytes", (t) => {
  const { base, input } = fixture(t);
  const model = path.join(base, "model.gguf");
  fs.writeFileSync(model, "GGUFmodel", { mode: 0o600 });
  const config = normalizeConfig({ ...input, qmd: { nodePath: process.execPath, packageRoot: base, modelPaths: { embed: model } } });
  fs.mkdirSync(config.stateDirectory, { mode: 0o700 });
  fs.writeFileSync(path.join(config.stateDirectory, "owned"), "12345", { mode: 0o600 });
  const result = storageAdmission(config, 7);
  assert.equal(result.stateBytes, 5);
  assert.equal(result.externalModelBytes, 9);
  assert.equal(result.requestedBytes, 7);
  assert.match(result.limitation, /overshoot/);
});

test("memory admission uses bounded trusted probes and measured model bytes", (t) => {
  const { base, input } = fixture(t);
  input.resourcePolicy.memory = {
    minimumAvailableBytes: 1024,
    modelSizeMultiplier: 2,
    fixedOverheadBytes: 1024,
    probeTimeoutMs: 500,
    probeOutputBytes: 4096,
  };
  const model = path.join(base, "memory-model.gguf");
  fs.writeFileSync(model, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(1024)]), { mode: 0o600 });
  const config = normalizeConfig({ ...input, qmd: { nodePath: process.execPath, packageRoot: base, modelPaths: { embed: model } } });
  const calls = [];
  const result = memoryAdmission(config, {
    platform: "darwin",
    readCommand(command, args, timeout, outputBytes) {
      calls.push({ command, args, timeout, outputBytes });
      if (command === "/usr/sbin/sysctl") return "17179869184\n";
      return "Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 1000000.\nPages inactive: 1000000.\nPages speculative: 0.\n";
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.modelBytes, 1028);
  assert.equal(result.requiredBytes, 3080);
  assert.deepEqual(calls, [
    { command: "/usr/sbin/sysctl", args: ["-n", "hw.memsize"], timeout: 500, outputBytes: 4096 },
    { command: "/usr/bin/vm_stat", args: [], timeout: 500, outputBytes: 4096 },
  ]);
});

test("background admission requires idle and healthy dwell and persists no catalogue data", (t) => {
  const { input } = fixture(t);
  const config = normalizeConfig(input);
  let now = Date.parse("2026-09-13T00:00:00Z");
  const options = { now: () => now, session: {}, readings: { onBattery: false, thermalPressure: false, idleMs: 600_000 } };
  assert.equal(evaluateBackground(config, options).pausedReason, "healthyDwell");
  now += 60_000;
  assert.equal(evaluateBackground(config, options).pausedReason, "healthyDwell");
  now += 60_000;
  assert.equal(evaluateBackground(config, options).background, "ready");
  const status = loadResourceStatus(config);
  assert.equal(status.pausedReason, null);
  assert.equal(fs.statSync(path.join(config.stateDirectory, "resource-status.json")).mode & 0o077, 0);
  assert.equal(fs.existsSync(path.join(config.stateDirectory, "catalogue.json")), false);
});

test("resource-status publication removes only its own partial temporary files", (t) => {
  const { input } = fixture(t);
  const config = normalizeConfig(input);
  fs.mkdirSync(config.stateDirectory, { mode: 0o700 });
  const status = path.join(config.stateDirectory, "resource-status.json");
  const unrelated = `${status}.${process.pid}.preexisting.tmp`;
  fs.writeFileSync(unrelated, "preserve me", { mode: 0o600 });
  const originalWriteFileSync = fs.writeFileSync;
  const originalRandomUUID = crypto.randomUUID;
  const identifiers = ["partial-one", "partial-two", "partial-three", "preexisting"];
  crypto.randomUUID = () => identifiers.shift();
  fs.writeFileSync = (target, data, options) => {
    if (typeof target === "number" || String(target).startsWith(`${status}.`)) {
      originalWriteFileSync(target, String(data).slice(0, 8), options);
      throw Object.assign(new Error("synthetic partial write"), { code: "ENOSPC" });
    }
    return originalWriteFileSync(target, data, options);
  };
  t.after(() => {
    fs.writeFileSync = originalWriteFileSync;
    crypto.randomUUID = originalRandomUUID;
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.throws(() => publishResourceStatus(config, { attempt }), { code: "ENOSPC" });
  }
  assert.throws(() => publishResourceStatus(config, { attempt: 4 }), { code: "EEXIST" });
  assert.deepEqual(fs.readdirSync(config.stateDirectory), [path.basename(unrelated)]);
  assert.equal(fs.readFileSync(unrelated, "utf8"), "preserve me");
});

test("healthy dwell is process-session local and resets across stale or backward samples", (t) => {
  const { input } = fixture(t);
  const config = normalizeConfig(input);
  let now = Date.parse("2026-09-13T00:00:00Z");
  const readings = { onBattery: false, thermalPressure: false, idleMs: 600_000 };
  const first = { now: () => now, readings, session: {} };
  assert.equal(evaluateBackground(config, first).pausedReason, "healthyDwell");
  now += 60_000;
  evaluateBackground(config, first);
  now += 60_000;
  assert.equal(evaluateBackground(config, first).background, "ready");
  assert.equal(evaluateBackground(config, { now: () => now, readings, session: {} }).pausedReason, "healthyDwell");
  now += 60_001;
  assert.equal(evaluateBackground(config, first).pausedReason, "healthyDwell");
  now -= 1_000;
  assert.equal(evaluateBackground(config, first).pausedReason, "healthyDwell");
});

test("battery, thermal pressure, and unavailable probes fail background closed", (t) => {
  const { input } = fixture(t);
  const config = normalizeConfig(input);
  assert.equal(evaluateBackground(config, { readings: { onBattery: true, thermalPressure: false, idleMs: 600_000 } }).pausedReason, "onBattery");
  assert.equal(evaluateBackground(config, { readings: { onBattery: false, thermalPressure: true, idleMs: 600_000 } }).pausedReason, "thermalPressure");
  assert.equal(evaluateBackground(config, { platform: "linux" }).pausedReason, "backgroundProbeUnavailable");
});

test("background probes reject incomplete injected readings and unrecognized power output", (t) => {
  const { input } = fixture(t);
  const config = normalizeConfig(input);
  assert.equal(evaluateBackground(config, { readings: {} }).pausedReason, "backgroundProbeUnavailable");
  assert.equal(evaluateBackground(config, {
    platform: "darwin",
    readCommand(command) {
      if (command === "/usr/bin/pmset") return "unexpected power output";
      return '"HIDIdleTime" = 600000000000';
    },
  }).pausedReason, "backgroundProbeUnavailable");
});

test("macOS probes use only fixed absolute commands, argv, and configured timeouts", (t) => {
  const { input } = fixture(t);
  const config = normalizeConfig(input);
  const calls = [];
  const outputs = new Map([
    ["/usr/bin/pmset -g batt", "Now drawing from 'AC Power'"],
    ["/usr/bin/pmset -g therm", "CPU_Speed_Limit = 100"],
    ["/usr/sbin/ioreg -c IOHIDSystem -d 4", '"HIDIdleTime" = 600000000000'],
  ]);
  const value = evaluateBackground(config, {
    platform: "darwin",
    readCommand(command, args, timeout) { calls.push({ command, args, timeout }); return outputs.get(`${command} ${args.join(" ")}`); },
  });
  assert.equal(value.pausedReason, "healthyDwell");
  assert.deepEqual(calls, [
    { command: "/usr/bin/pmset", args: ["-g", "batt"], timeout: 700 },
    { command: "/usr/bin/pmset", args: ["-g", "therm"], timeout: 700 },
    { command: "/usr/sbin/ioreg", args: ["-c", "IOHIDSystem", "-d", "4"], timeout: 700 },
  ]);
});

test("paused watcher coalesces triggers until idle and healthy dwell pass", async (t) => {
  const { input } = fixture(t);
  input.budgets.pollIntervalMs = 20;
  const config = normalizeConfig(input);
  let now = Date.parse("2026-09-13T00:00:00Z");
  const readings = { onBattery: true, thermalPressure: false, idleMs: 600_000 };
  const events = [];
  const controller = await api.watch(config, {
    testOnlyInProcess: true,
    watchEvents: false,
    resourceReadings: readings,
    resourceClock: () => now,
    onReconcile: (event) => events.push(event),
  });
  t.after(() => controller.stop());
  assert.equal(controller.getState().resources.pausedReason, "onBattery");
  assert.equal(controller.getState().runs, 0);
  void controller.reconcileNow();
  void controller.reconcileNow();
  readings.onBattery = false;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(controller.getState().resources.pausedReason, "healthyDwell");
  now += 60_000;
  await new Promise((resolve) => setTimeout(resolve, 30));
  now += 60_000;
  const deadline = Date.now() + 1000;
  while (controller.getState().runs === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  await controller.stop();
  assert.equal(events.length, 1);
  assert.equal(controller.getState().resources.background, "ready");
});

test("periodic hard-resource probes abort and drain active injected maintenance", async (t) => {
  const { input } = fixture(t);
  input.budgets.pollIntervalMs = 10;
  input.resourcePolicy.background.healthyDwellMs = 1;
  input.resourcePolicy.background.sampleGapMs = 1_000;
  const config = normalizeConfig(input);
  fs.writeFileSync(path.join(config.roots[0].path, "active.md"), "active maintenance");
  const readings = { onBattery: false, thermalPressure: false, idleMs: 600_000 };
  let now = Date.parse("2026-09-13T00:00:00Z");
  let aborted = false;
  const controller = await api.watch(config, {
    watchEvents: false,
    resourceReadings: readings,
    resourceClock: () => (now += 2),
    adapters: {
      qmdStatus: () => ({ available: true, semanticAvailable: false }),
      updateIndex: (_staged, operation = {}) => new Promise((resolve) => {
        readings.onBattery = true;
        const timeout = setTimeout(() => resolve({ ok: false, status: "notAborted" }), 250);
        operation.signal?.addEventListener("abort", () => {
          aborted = true;
          clearTimeout(timeout);
          resolve({ ok: false, status: "aborted" });
        }, { once: true });
      }),
    },
  });
  t.after(() => controller.stop());
  const deadline = Date.now() + 500;
  while (!aborted && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  await controller.stop();
  assert.equal(aborted, true);
  assert.equal(controller.getState().resources.pausedReason, "onBattery");
  assert.equal(controller.getState().running, false);
});

test("periodic resource-status publication failure resets healthy dwell after recovery", async (t) => {
  const { input } = fixture(t);
  input.budgets.pollIntervalMs = 5;
  input.resourcePolicy.background.healthyDwellMs = 100;
  input.resourcePolicy.background.sampleGapMs = 1_000;
  const config = normalizeConfig(input);
  fs.writeFileSync(path.join(config.roots[0].path, "active.md"), "active maintenance");
  const readings = { onBattery: false, thermalPressure: false, idleMs: 600_000 };
  let now = Date.parse("2026-09-13T00:00:00Z");
  let aborted = false;
  let invocations = 0;
  const controller = await api.watch(config, {
    watchEvents: false,
    resourceReadings: readings,
    resourceClock: () => now,
    adapters: {
      qmdStatus: () => ({ available: true, semanticAvailable: false }),
      updateIndex: (_staged, operation = {}) => new Promise((resolve) => {
        invocations += 1;
        if (invocations > 1) return resolve({ ok: true, status: "recovered" });
        const status = path.join(config.stateDirectory, "resource-status.json");
        fs.unlinkSync(status);
        fs.mkdirSync(status);
        const timeout = setTimeout(() => resolve({ ok: false, status: "notAborted" }), 500);
        operation.signal?.addEventListener("abort", () => {
          aborted = true;
          clearTimeout(timeout);
          resolve({ ok: false, status: "aborted" });
        }, { once: true });
      }),
    },
  });
  t.after(() => controller.stop());
  now += 100;
  const deadline = Date.now() + 500;
  while ((!aborted || controller.getState().running) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const state = controller.getState();
  assert.equal(aborted, true);
  assert.equal(state.running, false);
  assert.equal(state.resources.background, "paused");
  assert.equal(state.resources.pausedReason, "resourceStatusUnavailable");
  assert.ok(state.healthErrors.length <= 32);
  assert.equal(fs.readdirSync(config.stateDirectory).some((name) => name.endsWith(".tmp")), false);

  fs.rmSync(path.join(config.stateDirectory, "resource-status.json"), { recursive: true });
  const recoveryDeadline = Date.now() + 500;
  while (controller.getState().resources.pausedReason !== "healthyDwell" && Date.now() < recoveryDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(controller.getState().resources.pausedReason, "healthyDwell");
  assert.equal(controller.getState().resources.healthySince, now);
  assert.equal(invocations, 1);
  now += 99;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(invocations, 1);
  now += 1;
  const resumedDeadline = Date.now() + 500;
  while (invocations === 1 && Date.now() < resumedDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
  // A 5 ms poll may complete another legitimate index before this waiter resumes.
  assert.ok(invocations >= 2);
  await controller.stop();
  const stoppedInvocations = invocations;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(invocations, stoppedInvocations);
});

test("free-space reserve has precedence and unsafe state links fail closed", (t) => {
  const { base, input } = fixture(t);
  const config = normalizeConfig({
    ...input,
    budgets: { ...input.budgets, quotaBytes: 1, reserveBytes: Number.MAX_SAFE_INTEGER },
  });
  fs.mkdirSync(config.stateDirectory, { mode: 0o700 });
  fs.writeFileSync(path.join(config.stateDirectory, "usage"), "more than quota", { mode: 0o600 });
  assert.equal(storageAdmission(config, 1).status, "freeSpaceReserve");
  const outside = path.join(base, "outside");
  fs.writeFileSync(outside, "outside");
  fs.symlinkSync(outside, path.join(config.stateDirectory, "unsafe"));
  assert.throws(() => storageAdmission(config, 0), { code: "UNSAFE_STATE" });
  assert.equal(fs.readFileSync(outside, "utf8"), "outside");
});

test("storage accounting rejects hardlinked ordinary files without mutating them", (t) => {
  const { base, input } = fixture(t);
  const config = normalizeConfig(input);
  fs.mkdirSync(config.stateDirectory, { mode: 0o700 });
  const outside = path.join(base, "hardlink-source");
  const inside = path.join(config.stateDirectory, "hardlink-state");
  fs.writeFileSync(outside, "preserve me", { mode: 0o640 });
  fs.linkSync(outside, inside);
  const before = fs.statSync(outside);
  assert.throws(() => storageAdmission(config, 0), { code: "UNSAFE_STATE" });
  const after = fs.statSync(outside);
  assert.equal(fs.readFileSync(outside, "utf8"), "preserve me");
  assert.equal(after.mode, before.mode);
  assert.equal(after.nlink, 2);
  assert.equal(fs.existsSync(inside), true);
});

test("near-floor admission prevents a synthetic SDK worker from growing the index", async (t) => {
  const { base, input } = fixture(t);
  const marker = path.join(base, "sdk-wrote");
  const { packageRoot, model } = syntheticQmd(base, marker);
  fs.writeFileSync(path.join(input.roots[0].path, "doc.md"), "bounded source");
  input.budgets.quotaBytes = 1024 ** 2;
  input.budgets.writeScratchBytes = 2 * 1024 ** 2;
  input.qmd = { nodePath: process.execPath, packageRoot, modelPaths: { embed: model } };
  const config = normalizeConfig(input);
  const result = await runJsonChild(MAINTENANCE_WORKER, {
    config,
    qmdStatus: { available: true, status: "available", semanticAvailable: false },
  });
  assert.equal(result.status, "storageReserveOrQuota");
  assert.equal(fs.existsSync(marker), false);
});

test("maintenance reserves vectors per exact pinned chunk before embed", async (t) => {
  const { base, input } = fixture(t);
  const marker = path.join(base, "chunked-sdk-wrote");
  const { packageRoot, model, modelLoadMarker, embedMarker } = syntheticQmd(base, marker);
  input.budgets.quotaBytes = 1536 * 1024;
  input.budgets.writeScratchBytes = 1024;
  input.qmd = { nodePath: process.execPath, packageRoot, modelPaths: { embed: model } };
  const config = normalizeConfig(input);
  fs.mkdirSync(config.stateDirectory, { mode: 0o700 });
  fs.writeFileSync(path.join(config.stateDirectory, "current-index"), Buffer.alloc(512 * 1024), { mode: 0o600 });
  const { chunkDocumentByTokens } = await import(pathToFileURL(path.join(packageRoot, "dist/store.js")).href);
  const plan = await prepareEmbeddingPlan({
    staged: [{
      root: { id: "docs" },
      current: { text: Array.from({ length: 200 }, () => "x").join("|") },
      directory: path.join(config.stateDirectory, "staging", "docs"),
      filename: "owned.md",
    }],
  }, chunkDocumentByTokens);
  const reservation = maintenanceReservation(config, 0, 0, plan.remainingChunks);
  const admission = storageAdmission(config, reservation.embeddingRequestedBytes);
  assert.equal(plan.byCollection.get("docs"), 200);
  assert.equal(plan.remainingChunks, 200);
  assert.equal(fs.existsSync(modelLoadMarker), true);
  assert.equal(admission.ok, false);
  assert.equal(admission.status, "quotaExceeded");
  assert.equal(fs.existsSync(embedMarker), false);
  assert.equal(reservation.vectorChunks, 200);
  assert.match(reservation.limitation, /not a hard quota promise/);
});

test("insufficient memory falls maintenance back to lexical-only before SDK model loading", async (t) => {
  const { base, input } = fixture(t);
  const marker = path.join(base, "memory-sdk-wrote");
  const { packageRoot, model, modelLoadMarker, embedMarker } = syntheticQmd(base, marker);
  fs.writeFileSync(path.join(input.roots[0].path, "doc.md"), "lexical fallback source");
  input.budgets.quotaBytes = 16 * 1024 ** 2;
  input.resourcePolicy.memory.minimumAvailableBytes = Number.MAX_SAFE_INTEGER;
  input.qmd = { nodePath: process.execPath, packageRoot, modelPaths: { embed: model } };
  const config = normalizeConfig(input);
  const result = await runJsonChild(MAINTENANCE_WORKER, {
    config,
    qmdStatus: { available: true, status: "available", semanticAvailable: true },
  });
  assert.equal(result.status, "lexicalOnly");
  assert.match(result.qmdStatus, /^memory(?:Headroom|ProbeUnavailable)$/);
  assert.equal(fs.existsSync(marker), true);
  assert.equal(fs.existsSync(modelLoadMarker), false);
  assert.equal(fs.existsSync(embedMarker), false);
  assert.equal(loadResourceStatus(config).memory, result.qmdStatus);
});

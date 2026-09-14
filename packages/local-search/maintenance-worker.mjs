#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { normalizeConfig } = require("./config");
const { acquire } = require("./maintenance");
const { _performIndex } = require("./index");
const { validateEmbedResult } = require("./embed-result");
const { acquireInferenceWithMemory, maintenanceReservation, prepareEmbeddingPlan, storageAdmission } = require("./resources");
process.umask(0o077);

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const config = normalizeConfig(request.config);
const lock = acquire(config);
let store;
let disposeDefaultLlamaCpp;
let initializePromise;
let finishPromise;
let admission;
let activeStaged;
let embeddingPlanPromise;
const finish = () => finishPromise ||= (async () => {
  try { if (initializePromise) await initializePromise; } catch {}
  try { if (store) await store.close(); }
  finally {
    try { if (disposeDefaultLlamaCpp) await disposeDefaultLlamaCpp(); }
    finally { if (admission) { admission.release(); admission = null; } }
  }
})();
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encodingOrCallback, callback) => {
  if (typeof encodingOrCallback === "function") return process.stderr.write(chunk, encodingOrCallback);
  return process.stderr.write(chunk, encodingOrCallback, callback);
};

try {
  let adapters = {};
  if (config.qmd) {
    process.env.QMD_EMBED_MODEL = config.qmd.modelPaths.embed;
    const initialize = () => initializePromise ||= (async () => {
      const storage = storageAdmission(config, 0);
      if (!storage.ok) throw Object.assign(new Error(storage.status), { code: storage.status });
      const databasePath = path.join(config.stateDirectory, "qmd-index.sqlite");
      if (!fs.existsSync(databasePath)) fs.closeSync(fs.openSync(databasePath, "wx", 0o600));
      const indexUrl = pathToFileURL(path.join(config.qmd.packageRoot, "dist/index.js")).href;
      const llmUrl = pathToFileURL(path.join(config.qmd.packageRoot, "dist/llm.js")).href;
      const llm = await import(llmUrl);
      disposeDefaultLlamaCpp = llm.disposeDefaultLlamaCpp;
      const { createStore } = await import(indexUrl);
      const collections = Object.fromEntries(config.roots.map((root) => [root.id, {
        path: path.join(config.stateDirectory, "staging", root.id),
        pattern: "**/*.md",
      }]));
      store = await createStore({
        dbPath: path.join(config.stateDirectory, "qmd-index.sqlite"),
        config: { collections, models: { embed: config.qmd.modelPaths.embed } },
      });
      return store;
    })();
    const prepareEmbedding = () => embeddingPlanPromise ||= (async () => {
      const admitted = await acquireInferenceWithMemory(config, { timeoutMs: config.resourcePolicy.inferenceWaitMs });
      if (!admitted.ok) return admitted;
      admission = admitted.admission;
      const storeUrl = pathToFileURL(path.join(config.qmd.packageRoot, "dist/store.js")).href;
      const { chunkDocumentByTokens } = await import(storeUrl);
      return { ok: true, ...await prepareEmbeddingPlan(activeStaged || { staged: [] }, chunkDocumentByTokens) };
    })();
    adapters = {
      qmdStatus: () => request.qmdStatus,
      updateIndex: async (staged) => {
        activeStaged = staged;
        const activeStore = await initialize();
        const result = await activeStore.update({ collections: Object.keys(staged.manifests) });
        return { ok: true, status: "indexed", indexed: result.indexed + result.updated };
      },
      embedCollection: async (collection) => {
        const activeStore = await initialize();
        const plan = await prepareEmbedding();
        if (!plan.ok) return plan;
        const reservation = maintenanceReservation(config, 0, 0, plan.remainingChunks);
        if (!reservation.ok) return reservation;
        const storage = storageAdmission(config, reservation.embeddingRequestedBytes);
        if (!storage.ok) return { ok: false, status: storage.status, storage, reservation };
        const result = await activeStore.embed({ collection, model: config.qmd.modelPaths.embed, maxDocsPerBatch: 8, maxBatchBytes: 8 * 1024 * 1024 });
        if (!validateEmbedResult(result)) return { ok: false, status: "embeddingFailed", result };
        plan.remainingChunks -= plan.byCollection.get(collection) || 0;
        return { ok: true, ...result, reservation };
      },
      finish,
    };
  }
  const result = await _performIndex(config, adapters, true);
  if (adapters.finish) await adapters.finish();
  originalStdoutWrite(`${JSON.stringify(result)}\n`);
} catch (error) {
  originalStdoutWrite(`${JSON.stringify({ ok: false, status: error.code || "maintenanceFailed", error: error.message })}\n`);
} finally {
  try { if (config.qmd) await finish(); }
  catch {}
  finally { lock.release(); }
}

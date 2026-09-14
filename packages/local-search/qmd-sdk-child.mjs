#!/usr/bin/env node
/**
 * One-request QMD 2.8.3 SDK search child. Reads one JSON object from stdin and
 * writes only a JSON candidate array to stdout. The parent must provide Node 24,
 * an existing approved database, an approved local embedding GGUF for semantic
 * requests, and process/network sandboxing. This helper does not authenticate
 * its caller or install a sandbox. It performs lexical or embedding-only vector
 * search: no query expansion, generation, reranking, indexing, or downloads.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { normalizeConfig } = require("./config");
const { acquireInferenceWithMemory } = require("./resources");
const { validatedSemanticPassage } = require("./qmd");
process.umask(0o077);

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_QUERY_CHARS = 1024;
const MAX_FILEPATH_CHARS = 4096;
const MAX_COLLECTIONS = 64;
const COLLECTION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

class RequestError extends Error {
  constructor(message) {
    super(message);
    this.code = "INVALID_REQUEST";
  }
}

async function readRequest() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new RequestError("request exceeds 16384 bytes");
    chunks.push(chunk);
  }
  if (bytes === 0) throw new RequestError("stdin must contain one JSON request");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError("stdin must contain valid JSON");
  }
}

function requireAbsoluteFile(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new RequestError(`${label} must be an absolute path`);
  }
  let stat;
  try {
    stat = fs.statSync(value);
  } catch {
    throw new RequestError(`${label} must be an existing file`);
  }
  if (!stat.isFile()) throw new RequestError(`${label} must be an existing file`);
  return fs.realpathSync(value);
}

function requireSqliteDatabase(value) {
  let raw;
  try { raw = fs.lstatSync(value); }
  catch { throw new RequestError("dbPath must be an existing SQLite file"); }
  if (raw.isSymbolicLink() || raw.nlink !== 1 || (typeof process.getuid === "function" && raw.uid !== process.getuid())) {
    throw new RequestError("dbPath must be an owner-controlled non-link file");
  }
  const dbPath = requireAbsoluteFile(value, "dbPath");
  const file = fs.openSync(dbPath, "r");
  const header = Buffer.alloc(16);
  try {
    if (fs.readSync(file, header, 0, 16, 0) !== 16 || !header.equals(Buffer.from("SQLite format 3\0"))) {
      throw new RequestError("dbPath must be an existing SQLite file");
    }
  } finally {
    fs.closeSync(file);
  }
  return dbPath;
}

function requireEmbedModel(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError("modelPaths must contain an embed path for semantic search");
  }
  const modelPath = value.embed;
  if (typeof modelPath !== "string" || !path.isAbsolute(modelPath)) {
    throw new RequestError("modelPaths.embed must be an absolute local GGUF path");
  }
  let stat;
  try {
    stat = fs.lstatSync(modelPath);
  } catch {
    throw new RequestError("modelPaths.embed must be an existing local GGUF file");
  }
  if (stat.isSymbolicLink() || stat.nlink !== 1 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new RequestError("modelPaths.embed must be an owner-controlled non-link file");
  }
  if (!stat.isFile()) throw new RequestError("modelPaths.embed must be an existing local GGUF file");
  const file = fs.openSync(modelPath, "r");
  const header = Buffer.alloc(4);
  try {
    if (fs.readSync(file, header, 0, 4, 0) !== 4 || !header.equals(Buffer.from("GGUF"))) {
      throw new RequestError("modelPaths.embed must have a GGUF header");
    }
  } finally {
    fs.closeSync(file);
  }
  return fs.realpathSync(modelPath);
}

function requirePackageRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new RequestError("packageRoot must be an absolute path");
  }
  let packageRoot;
  try {
    packageRoot = fs.realpathSync(value);
  } catch {
    throw new RequestError("packageRoot must be an existing directory");
  }
  if (!fs.statSync(packageRoot).isDirectory()) {
    throw new RequestError("packageRoot must be an existing directory");
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  } catch {
    throw new RequestError("packageRoot must contain a readable package.json");
  }
  if (manifest.name !== "@tobilu/qmd" || manifest.version !== "2.8.3") {
    throw new RequestError("packageRoot must be @tobilu/qmd version 2.8.3");
  }
  for (const relative of ["dist/index.js", "dist/llm.js"]) {
    let isFile = false;
    try {
      isFile = fs.statSync(path.join(packageRoot, relative)).isFile();
    } catch {}
    if (!isFile) {
      throw new RequestError(`packageRoot is missing ${relative}`);
    }
  }
  return packageRoot;
}

function validateRequest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError("request must be a JSON object");
  }
  if (value.operation !== "lexical" && value.operation !== "semantic") {
    throw new RequestError("operation must be lexical or semantic");
  }
  if (typeof value.query !== "string" || value.query.trim().length === 0 || value.query.length > MAX_QUERY_CHARS) {
    throw new RequestError("query must be a nonempty string of at most 1024 characters");
  }
  const hasCollection = Object.hasOwn(value, "collection");
  const hasCollections = Object.hasOwn(value, "collections");
  if (hasCollection === hasCollections) throw new RequestError("provide exactly one of collection or collections");
  let collections;
  if (hasCollection) {
    if (typeof value.collection !== "string" || !COLLECTION_PATTERN.test(value.collection)) {
      throw new RequestError("collection must be a valid collection ID");
    }
    collections = [value.collection];
  } else {
    if (!Array.isArray(value.collections) || value.collections.length < 1 || value.collections.length > MAX_COLLECTIONS) {
      throw new RequestError("collections must contain 1 through 64 collection IDs");
    }
    if (!value.collections.every((collection) => typeof collection === "string" && COLLECTION_PATTERN.test(collection))) {
      throw new RequestError("collections must contain only valid collection IDs");
    }
    if (new Set(value.collections).size !== value.collections.length) throw new RequestError("collections must be unique");
    collections = [...value.collections];
  }
  if (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 8) {
    throw new RequestError("limit must be an integer from 1 through 8");
  }
  const packageRoot = requirePackageRoot(value.packageRoot);
  const dbPath = requireSqliteDatabase(value.dbPath);
  const stateDirectory = value.stateDirectory ?? path.dirname(dbPath);
  if (typeof stateDirectory !== "string" || !path.isAbsolute(stateDirectory) || path.normalize(stateDirectory) !== stateDirectory) {
    throw new RequestError("stateDirectory must be a normalized absolute path");
  }
  let resourcePolicy;
  try {
    resourcePolicy = normalizeConfig({
      version: 1,
      enabled: false,
      stateDirectory,
      roots: [],
      resourcePolicy: value.resourcePolicy,
    }).resourcePolicy;
  } catch (error) {
    throw new RequestError(`resourcePolicy is invalid: ${error.message}`);
  }
  const request = {
    operation: value.operation,
    packageRoot,
    dbPath,
    collections,
    query: value.query,
    limit: value.limit,
    stateDirectory,
    resourcePolicy,
    admissionTimeoutMs: value.admissionTimeoutMs ?? 30_000,
  };
  if (!Number.isSafeInteger(request.admissionTimeoutMs) || request.admissionTimeoutMs <= 0) throw new RequestError("admissionTimeoutMs is required");
  request.embedModel = value.operation === "semantic" ? requireEmbedModel(value.modelPaths) : null;
  return request;
}

function sanitizeCandidates(rows, collection, limit) {
  if (!Array.isArray(rows)) throw new Error("QMD search returned a non-array result");
  return rows.slice(0, limit).map((row) => {
    const validFile = typeof row?.filepath === "string"
      && row.filepath.length <= MAX_FILEPATH_CHARS
      && row.filepath.startsWith(`qmd://${collection}/`);
    if (!validFile || !Number.isFinite(row.score)) {
      throw new Error("QMD search returned an invalid candidate");
    }
    const semantic = typeof row.body === "string"
      ? validatedSemanticPassage({ chunkPos: row.chunkPos, contentHash: row.hash }, row.body)
      : null;
    return { file: row.filepath, score: row.score, ...(semantic ? { semantic } : {}) };
  });
}

async function run() {
  const request = validateRequest(await readRequest());
  if (request.embedModel) process.env.QMD_EMBED_MODEL = request.embedModel;
  const admitted = request.operation === "semantic"
    ? await acquireInferenceWithMemory({
      stateDirectory: request.stateDirectory,
      resourcePolicy: request.resourcePolicy,
      qmd: { modelPaths: { embed: request.embedModel } },
    }, { timeoutMs: request.admissionTimeoutMs })
    : null;
  if (admitted && !admitted.ok) throw Object.assign(new Error(admitted.status), { code: admitted.status });
  const admission = admitted?.admission || null;

  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = (chunk, encodingOrCallback, callback) => {
    if (typeof encodingOrCallback === "function") {
      return process.stderr.write(chunk, encodingOrCallback);
    }
    return process.stderr.write(chunk, encodingOrCallback, callback);
  };
  try {
    let store;
    let disposeDefaultLlamaCpp;
    try {
      const indexUrl = pathToFileURL(path.join(request.packageRoot, "dist/index.js")).href;
      const llmUrl = pathToFileURL(path.join(request.packageRoot, "dist/llm.js")).href;
      const llm = await import(llmUrl);
      disposeDefaultLlamaCpp = llm.disposeDefaultLlamaCpp;
      const { createStore } = await import(indexUrl);
      if (typeof createStore !== "function" || typeof disposeDefaultLlamaCpp !== "function") {
        throw new Error("QMD package does not expose the required SDK functions");
      }
      store = await createStore({ dbPath: request.dbPath });
      const search = request.operation === "lexical" ? store.searchLex : store.searchVector;
      if (typeof search !== "function") throw new Error(`QMD store does not expose search method for ${request.operation}`);
      const candidates = [];
      for (const collection of request.collections) {
        const rows = await search.call(store, request.query, { collection, limit: request.limit });
        candidates.push(...sanitizeCandidates(rows, collection, request.limit));
      }
      return candidates;
    } finally {
      try {
        if (store) await store.close();
      } finally {
        if (disposeDefaultLlamaCpp) await disposeDefaultLlamaCpp();
      }
    }
  } finally {
    process.stdout.write = originalStdoutWrite;
    if (admission) admission.release();
  }
}

try {
  const candidates = await run();
  process.stdout.write(`${JSON.stringify(candidates)}\n`);
} catch (error) {
  const code = error?.code === "INVALID_REQUEST" ? "INVALID_REQUEST" : "QMD_SEARCH_FAILED";
  const message = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
  process.exitCode = 1;
}

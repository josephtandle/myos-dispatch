"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAX_CACHE_ENTRIES = 64;
const cache = new Map();

function cacheKey(filePath) {
  return path.resolve(filePath);
}

function setCached(key, value) {
  cache.set(key, value);
  if (cache.size > MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

/**
 * Returns a shared cached parsed object. Callers MUST NOT mutate it; copy or
 * rebuild data before mutation.
 */
function readJsonCached(filePath) {
  const key = cacheKey(filePath);
  const stat = fs.statSync(key);
  const cached = cache.get(key);

  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size
  ) {
    return cached.parsed;
  }

  const parsed = JSON.parse(fs.readFileSync(key, "utf8"));
  setCached(key, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    parsed,
  });
  return parsed;
}

function invalidateJsonCache(filePath) {
  cache.delete(cacheKey(filePath));
}

function clearJsonCache() {
  cache.clear();
}

module.exports = {
  clearJsonCache,
  invalidateJsonCache,
  readJsonCached,
};

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_MANIFEST_ENTRIES = 10_000;
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".vtt", ".srt"]);

function denied(reason) { return { ok: false, reason }; }
function sameNode(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs
    && a.ctimeNs === b.ctimeNs && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink;
}
function sameDirectory(a, b) { return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid; }
function ownRegular(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
    && (typeof process.getuid !== "function" || stat.uid === BigInt(process.getuid())) && (Number(stat.mode) & 0o077) === 0;
}
function inspectAncestors(filePath) {
  const ancestors = [];
  let cursor = path.parse(filePath).root;
  for (const part of [null, ...filePath.slice(cursor.length).split(path.sep).filter(Boolean)]) {
    if (part !== null) cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor, { bigint: true }); } catch { return null; }
    if (stat.isSymbolicLink() || !stat.isDirectory() || (Number(stat.mode) & 0o022) !== 0) return null;
    if (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid()) && stat.uid !== 0n) return null;
    ancestors.push({ path: cursor, stat });
  }
  return ancestors;
}
function sameAncestors(before, after) {
  return before && after && before.length === after.length
    && before.every((entry, index) => entry.path === after[index].path && sameDirectory(entry.stat, after[index].stat));
}
function readBounded(fd) {
  const buffer = Buffer.allocUnsafe(MAX_MANIFEST_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  return buffer.subarray(0, offset);
}
function stringNode(value) { return typeof value === "string" && /^\d+$/.test(value); }
function validPath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\\")
    && value === path.posix.normalize(value) && !value.startsWith("/") && !value.split("/").some((part) => !part || part === "." || part === "..");
}
function validHash(value) { return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value); }
function exactKeys(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function loadManifest(root) {
  if (!root.admissionManifest) return { ok: true, legacy: true };
  let fd;
  try {
    const ancestorsBefore = inspectAncestors(path.dirname(root.admissionManifest));
    if (!ancestorsBefore) return denied("admissionManifestUnsafeAncestor");
    const pathBefore = fs.lstatSync(root.admissionManifest, { bigint: true });
    if (!ownRegular(pathBefore) || pathBefore.size > BigInt(MAX_MANIFEST_BYTES)) return denied("admissionManifestUnsafe");
    fd = fs.openSync(root.admissionManifest, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const descriptorBefore = fs.fstatSync(fd, { bigint: true });
    if (!ownRegular(descriptorBefore) || !sameNode(pathBefore, descriptorBefore)) return denied("admissionManifestChanged");
    const bytes = readBounded(fd);
    const descriptorAfter = fs.fstatSync(fd, { bigint: true });
    const pathAfter = fs.lstatSync(root.admissionManifest, { bigint: true });
    const ancestorsAfter = inspectAncestors(path.dirname(root.admissionManifest));
    if (bytes.length > MAX_MANIFEST_BYTES || bytes.length !== Number(descriptorBefore.size)
      || !sameNode(descriptorBefore, descriptorAfter) || !sameNode(descriptorAfter, pathAfter)
      || !sameAncestors(ancestorsBefore, ancestorsAfter)) return denied("admissionManifestChanged");
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (!exactKeys(manifest, ["version", "rootId", "rootPath", "root", "policySha256", "files"]) || manifest.version !== 1
      || manifest.rootId !== root.id || manifest.rootPath !== fs.realpathSync(root.path)
      || !exactKeys(manifest.root, ["dev", "ino"]) || !stringNode(manifest.root.dev) || !stringNode(manifest.root.ino)
      || !validHash(manifest.policySha256) || manifest.policySha256.toLowerCase() !== root.admissionPolicySha256
      || !Array.isArray(manifest.files) || manifest.files.length > MAX_MANIFEST_ENTRIES) return denied("admissionManifestInvalid");
    const rootStat = fs.lstatSync(root.path, { bigint: true });
    if (rootStat.isSymbolicLink() || rootStat.dev.toString() !== manifest.root.dev || rootStat.ino.toString() !== manifest.root.ino) return denied("admissionRootChanged");
    const entries = new Map();
    for (const entry of manifest.files) {
      if (!exactKeys(entry, ["path", "sha256", "dev", "ino"]) || !validPath(entry.path) || !validHash(entry.sha256) || !stringNode(entry.dev) || !stringNode(entry.ino)
        || !TEXT_EXTENSIONS.has(path.posix.extname(entry.path).toLowerCase()) || entries.has(entry.path)) return denied("admissionManifestInvalid");
      entries.set(entry.path, Object.freeze({ ...entry, sha256: entry.sha256.toLowerCase() }));
    }
    return { ok: true, generation: crypto.createHash("sha256").update(bytes).digest("hex"), entries };
  } catch { return denied("admissionManifestUnavailable"); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function admissionFor(root, relative) {
  const manifest = loadManifest(root);
  if (!manifest.ok || manifest.legacy) return manifest;
  const entry = manifest.entries.get(relative);
  if (entry) return { ...manifest, entry, ancestor: false };
  const prefix = `${relative}/`;
  if ([...manifest.entries.keys()].some((candidate) => candidate.startsWith(prefix))) return { ...manifest, entry: null, ancestor: true };
  return denied("admissionNotListed");
}

module.exports = { admissionFor, loadManifest, MAX_MANIFEST_BYTES, MAX_MANIFEST_ENTRIES };

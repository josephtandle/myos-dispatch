"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { admissionFor } = require("./admission");
const { primeResidency, residentOnMac } = require("./residency");

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "build", "dist", "cache", "caches", "browserprofiles"]);
const CONTENT_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".vtt", ".srt"]);
const DOCUMENT_EXTENSIONS = new Set([".docx", ".pptx", ".xlsx", ".pdf"]);
const SENSITIVE = /(^\.env($|\.)|secret|credential|private[-_ ]?key|id_rsa|id_ed25519|\.pem$|\.p12$|\.key$)/i;
const SECRET_CONTENT = /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|["']?(?:api[_-]?key|access[_-]?token|password|secret|token)["']?\s*[:=]\s*(?:"[^"\r\n]{8,}"|'[^'\r\n]{8,}'|[^\s,#}\]]{8,}))/i;
const PROTECTED_ABSOLUTE = [
  "/library/cloudstorage/", "/library/mobile documents/", "/library/keychains/",
  "/application support/google/chrome/", "/application support/chromium/",
  "/application support/microsoft edge/", "/application support/firefox/profiles/",
  "/library/safari/", "/.ssh/", "/.aws/", "/.azure/", "/.config/gcloud/",
  "/.myos/agent-chrome/",
  "/dropbox/", "/onedrive/", "/google drive/",
];

function unavailable(reason, filePath) {
  return { ok: false, status: "sourceUnavailable", reason, path: filePath };
}

function hasUnsafeComponent(filePath) {
  let cursor = path.parse(filePath).root;
  for (const part of filePath.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function classify(root, filePath) {
  const relative = path.relative(root.path, filePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return unavailable("outsideApprovedRoot", filePath);
  const parts = relative.split(path.sep);
  if (parts.some((part) => part.startsWith("."))) return unavailable("hiddenPath", filePath);
  if (parts.some((part) => EXCLUDED_DIRECTORIES.has(part.toLowerCase()))) return unavailable("excludedDirectory", filePath);
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  const padded = `${normalized.replace(/\/$/, "")}/`;
  if (PROTECTED_ABSOLUTE.some((fragment) => padded.includes(fragment))) return unavailable("protectedAbsolutePath", filePath);
  if (parts.some((part) => SENSITIVE.test(part))) return unavailable("sensitiveName", filePath);
  const admission = admissionFor(root, relative);
  if (!admission.ok) return unavailable(admission.reason, filePath);
  const extension = path.extname(filePath).toLowerCase();
  const explicitlyEnabled = root.contentEnabled && root.extensions.includes(extension);
  const textEligible = explicitlyEnabled && CONTENT_EXTENSIONS.has(extension);
  const documentEligible = explicitlyEnabled && DOCUMENT_EXTENSIONS.has(extension);
  return { ok: true, relative, extension, textEligible, documentEligible, contentEligible: textEligible || documentEligible, admission };
}

function validateStat(root, filePath, stat) {
  if (!stat.isFile()) return unavailable("notRegularFile", filePath);
  if (Number(stat.nlink) > 1) return unavailable("hardlinkDenied", filePath);
  if (typeof process.getuid === "function" && Number(stat.uid) !== process.getuid()) return unavailable("foreignOwner", filePath);
  if (Number(stat.size) > root.maxFileBytes) return unavailable("sizeLimit", filePath);
  if (!residentOnMac(filePath, stat)) return unavailable("cloudPlaceholderOrFlagsUnavailable", filePath);
  return { ok: true };
}

function sameIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size
    && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs;
}

function lstatBigint(filePath) {
  return fs.lstatSync(filePath, { bigint: true });
}

function toSafeNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function millisecondsFromNanoseconds(nanoseconds) {
  return Number(nanoseconds / 1_000_000n) + Number(nanoseconds % 1_000_000n) / 1_000_000;
}

function verifyMetadata(root, filePath) {
  const classification = classify(root, filePath);
  if (!classification.ok) return classification;
  if (hasUnsafeComponent(filePath)) return unavailable("symlinkDenied", filePath);
  try {
    const stat = lstatBigint(filePath);
    const allowed = validateStat(root, filePath, stat);
    if (!allowed.ok) return allowed;
    if (!classification.admission.legacy) {
      if (!classification.admission.entry) return unavailable("admissionDirectoryOnly", filePath);
      if (stat.dev.toString() !== classification.admission.entry.dev || stat.ino.toString() !== classification.admission.entry.ino) return unavailable("admissionSourceChanged", filePath);
    }
    return { ok: true, path: filePath, ...classification, stat };
  } catch (error) {
    return unavailable(error.code === "ENOENT" ? "removed" : "statFailed", filePath);
  }
}

function readVerifiedBytes(root, filePath, options = {}) {
  const admission = verifyMetadata(root, filePath);
  if (!admission.ok || !admission.contentEligible) return admission.ok ? unavailable("contentNotEnabled", filePath) : admission;
  const classification = admission;
  let fd;
  try {
    if (options.beforeOpen) options.beforeOpen();
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const before = fs.fstatSync(fd, { bigint: true });
    const allowed = validateStat(root, filePath, before);
    if (!allowed.ok) return allowed;
    if (!sameIdentity(admission.stat, before)) return unavailable("changedBeforeOpen", filePath);
    const size = toSafeNumber(before.size);
    if (size === null || size > root.maxFileBytes) return unavailable("sizeLimit", filePath);
    const buffer = Buffer.alloc(size + 1);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead > root.maxFileBytes || BigInt(bytesRead) !== before.size) return unavailable("unstableOrSizeLimit", filePath);
    if (options.afterRead) options.afterRead();
    const after = fs.fstatSync(fd, { bigint: true });
    if (options.beforeFinalVerification) options.beforeFinalVerification();
    const pathAfter = lstatBigint(filePath);
    if (!sameIdentity(before, after) || !sameIdentity(after, pathAfter)) return unavailable("changedDuringRead", filePath);
    const bytes = buffer.subarray(0, bytesRead);
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (!classification.admission.legacy && hash !== classification.admission.entry.sha256) return unavailable("admissionHashMismatch", filePath);
    if (!classification.admission.legacy) {
      const current = admissionFor(root, classification.relative);
      if (!current.ok || current.legacy || !current.entry || current.generation !== classification.admission.generation
        || current.entry.sha256 !== classification.admission.entry.sha256 || current.entry.dev !== classification.admission.entry.dev || current.entry.ino !== classification.admission.entry.ino) return unavailable("admissionRevokedDuringRead", filePath);
    }
    return {
      ok: true,
      path: filePath,
      relative: classification.relative,
      extension: classification.extension,
      textEligible: classification.textEligible,
      documentEligible: classification.documentEligible,
      buffer: bytes,
      bytes: bytesRead,
      hash,
      admissionGeneration: classification.admission.legacy ? null : classification.admission.generation,
      sourceReadAt: new Date().toISOString(),
      stat: {
        dev: before.dev.toString(), ino: before.ino.toString(), size: Number(before.size),
        mtimeNs: before.mtimeNs.toString(), ctimeNs: before.ctimeNs.toString(),
      },
    };
  } catch (error) {
    return unavailable(error.code === "ENOENT" ? "removed" : "readFailed", filePath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readVerified(root, filePath, options = {}) {
  const classification = classify(root, filePath);
  if (!classification.ok || !classification.textEligible) return classification.ok ? unavailable("contentNotEnabled", filePath) : classification;
  const read = readVerifiedBytes(root, filePath, options);
  if (!read.ok) return read;
  const bytes = read.buffer;
  if (bytes.includes(0)) return unavailable("unsupportedBinary", filePath);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return unavailable("invalidUtf8", filePath); }
  if (read.extension === ".json") {
    try { JSON.parse(text); } catch { return unavailable("invalidJson", filePath); }
  }
  if (SECRET_CONTENT.test(text)) return unavailable("secretPatternDenied", filePath);
  return {
    ok: true, path: read.path, relative: read.relative, text, bytes: read.bytes, hash: read.hash,
    admissionGeneration: read.admissionGeneration, sourceReadAt: read.sourceReadAt, stat: read.stat,
  };
}

function discoverRoot(root, deadline) {
  const files = [];
  const unavailableSources = [];
  let complete = true;
  const visit = (directory) => {
    if (!complete) return;
    if (Date.now() > deadline || files.length >= root.maxFiles) { complete = false; return; }
    if (!fs.existsSync(directory)) { complete = false; unavailableSources.push(unavailable("rootOfflineOrUnreadable", directory)); return; }
    if (hasUnsafeComponent(directory)) { unavailableSources.push(unavailable("symlinkDenied", directory)); return; }
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { complete = false; unavailableSources.push(unavailable("rootOfflineOrUnreadable", directory)); return; }
    const candidates = [];
    const consumeCandidates = () => {
      if (candidates.length === 0) return;
      primeResidency(candidates.map((candidate) => candidate.filePath), deadline);
      for (const { filePath, classified } of candidates) {
        if (Date.now() > deadline || files.length >= root.maxFiles) { complete = false; break; }
        let stat;
        try { stat = lstatBigint(filePath); } catch { unavailableSources.push(unavailable("statFailed", filePath)); continue; }
        const permitted = validateStat(root, filePath, stat);
        if (!permitted.ok) { unavailableSources.push(permitted); continue; }
        files.push({
          path: filePath, relative: classified.relative, extension: classified.extension,
          textEligible: classified.textEligible, documentEligible: classified.documentEligible,
          contentEligible: classified.contentEligible, size: Number(stat.size), mtimeMs: millisecondsFromNanoseconds(stat.mtimeNs),
        });
      }
      candidates.length = 0;
    };
    for (const entry of entries) {
      if (Date.now() > deadline || files.length >= root.maxFiles) { complete = false; break; }
      const filePath = path.join(directory, entry.name);
      const classified = classify(root, filePath);
      if (!classified.ok) continue;
      if (entry.isSymbolicLink()) { unavailableSources.push(unavailable("symlinkDenied", filePath)); continue; }
      if (entry.isDirectory()) { consumeCandidates(); visit(filePath); continue; }
      if (!entry.isFile()) continue;
      candidates.push({ filePath, classified });
      if (candidates.length >= Math.min(128, root.maxFiles - files.length)) consumeCandidates();
    }
    consumeCandidates();
  };
  visit(root.path);
  return { files, unavailableSources, complete };
}

function selectRoots(config, requested) {
  if (requested === undefined) return config.roots;
  if (!Array.isArray(requested) || requested.length === 0 || requested.some((id) => typeof id !== "string")) throw Object.assign(new Error("roots must be a non-empty array of root ids"), { code: "INVALID_REQUEST" });
  if (new Set(requested).size !== requested.length) throw Object.assign(new Error("duplicate requested root id"), { code: "INVALID_REQUEST" });
  return requested.map((id) => {
    const root = config.roots.find((candidate) => candidate.id === id);
    if (!root) throw Object.assign(new Error(`unknown root id: ${id}`), { code: "INVALID_REQUEST" });
    return root;
  });
}

function hasSecretContent(text) { return SECRET_CONTENT.test(text); }

module.exports = { CONTENT_EXTENSIONS, DOCUMENT_EXTENSIONS, classify, discoverRoot, hasSecretContent, readVerified, readVerifiedBytes, selectRoots, verifyMetadata };

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertTrustedAncestor(stat) {
  const currentUser = process.getuid();
  const trustedOwner = stat.uid === currentUser || stat.uid === 0;
  const otherWritable = (stat.mode & 0o022) !== 0;
  const trustedStickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
  if (!stat.isDirectory() || stat.isSymbolicLink() || !trustedOwner || (otherWritable && !trustedStickyRoot)) {
    throw coded("receipt directory ancestry is not trusted", "UNSAFE_RECEIPT_DIRECTORY");
  }
}

function assertPrivateDirectory(directory) {
  if (!path.isAbsolute(directory)) throw coded("receipt directory must be absolute", "INVALID_ARGUMENT");
  const resolved = path.resolve(directory);
  const parts = resolved.split(path.sep).filter(Boolean);
  let current = path.parse(resolved).root;
  assertTrustedAncestor(fs.lstatSync(current));
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch { throw coded("receipt directory ancestry must exist", "UNSAFE_RECEIPT_DIRECTORY"); }
    assertTrustedAncestor(stat);
  }
  const stat = fs.lstatSync(resolved);
  if (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    throw coded("receipt directory must be owned by the current user with mode 0700", "UNSAFE_RECEIPT_DIRECTORY");
  }
  return resolved;
}

function cleanupCreated(filePath, receiptDirectory, parentIdentity, fileIdentity, fd, created, io) {
  if (fd !== undefined) {
    try { io.closeSync(fd); } catch {}
  }
  if (!created) return "notCreated";
  if (!fileIdentity) return "ownershipUnknown";
  let currentParent;
  let currentFile;
  try {
    currentParent = io.lstatSync(receiptDirectory);
    currentFile = io.lstatSync(filePath);
  } catch {
    return "ownershipChanged";
  }
  if (!sameIdentity(parentIdentity, currentParent) || !sameIdentity(fileIdentity, currentFile)) {
    return "ownershipChanged";
  }
  try {
    io.unlinkSync(filePath);
    return "removed";
  } catch {
    return "cleanupFailed";
  }
}

function writeReceipt(result, directory, dependencies = {}) {
  const receiptDirectory = assertPrivateDirectory(directory);
  const io = {
    closeSync: dependencies.closeSync || fs.closeSync,
    fchmodSync: dependencies.fchmodSync || fs.fchmodSync,
    fstatSync: dependencies.fstatSync || fs.fstatSync,
    lstatSync: dependencies.lstatSync || fs.lstatSync,
    openSync: dependencies.openSync || fs.openSync,
    unlinkSync: dependencies.unlinkSync || fs.unlinkSync,
    writeFileSync: dependencies.writeFileSync || fs.writeFileSync,
  };
  const uuid = (dependencies.randomUUID || crypto.randomUUID)();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(uuid)) {
    throw coded("receipt UUID is malformed", "RECEIPT_WRITE_FAILED");
  }
  const name = `${uuid}.json`;
  const filePath = path.join(receiptDirectory, name);
  let existing;
  try { existing = io.lstatSync(filePath); } catch { existing = null; }
  if (existing) throw coded("receipt output already exists", "UNSAFE_RECEIPT_OUTPUT");
  const resultJson = JSON.stringify(result);
  const resultSha256 = crypto.createHash("sha256").update(resultJson).digest("hex");
  const payload = `${JSON.stringify({ version: 1, result })}\n`;
  const parentIdentity = io.lstatSync(receiptDirectory);
  let fd;
  let fileIdentity;
  let created = false;
  try {
    fd = io.openSync(filePath, "wx", 0o600);
    created = true;
    fileIdentity = io.fstatSync(fd);
    io.writeFileSync(fd, payload, "utf8");
    io.fchmodSync(fd, 0o600);
    io.closeSync(fd);
    fd = undefined;
  } catch {
    const failure = coded("receipt write failed", "RECEIPT_WRITE_FAILED");
    failure.cleanupStatus = cleanupCreated(filePath, receiptDirectory, parentIdentity, fileIdentity, fd, created, io);
    throw failure;
  }
  return { name, resultSha256 };
}

module.exports = { assertPrivateDirectory, writeReceipt };

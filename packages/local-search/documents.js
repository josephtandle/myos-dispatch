"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const PARSER_SCHEMA_VERSION = 1;
const PARSER_IDENTITY_SCHEMA = Object.freeze({
  schemaVersion: PARSER_SCHEMA_VERSION,
  implementation: "myos-local-document-parser",
  formulaEvaluation: false,
  xmlEntities: false,
});
const PARSER_PATH = path.join(__dirname, "document-parser.py");
const SANDBOX = "/usr/bin/sandbox-exec";
const SANDBOX_POLICY = "(version 1)(allow default)(deny network*)";
const DEFAULT_LIMITS = Object.freeze({
  inputBytes: 16 * 1024 * 1024,
  extractedUtf8Bytes: 4 * 1024 * 1024,
  stdoutBytes: 8 * 1024 * 1024,
  pagesOrSlides: 2_000,
  cells: 100_000,
  segments: 50_000,
  archiveMembers: 5_000,
  archiveExpandedBytes: 64 * 1024 * 1024,
  archiveMemberBytes: 16 * 1024 * 1024,
  archiveCompressionRatio: 100,
  timeoutMs: 30_000,
});
const SUPPORTED = new Set(["pdf", "docx", "pptx", "xlsx"]);

function coded(message, code, details) {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

function normalizedExtension(extension) {
  if (typeof extension !== "string") throw coded("document extension is required", "UNSUPPORTED_FORMAT");
  const value = extension.toLowerCase().replace(/^\./, "");
  if (!SUPPORTED.has(value)) throw coded("document format is unsupported", "UNSUPPORTED_FORMAT");
  return value;
}

function boundedLimits(options) {
  const limits = {};
  for (const [name, maximum] of Object.entries(DEFAULT_LIMITS)) {
    const candidate = options[name] === undefined ? maximum : options[name];
    if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > maximum) {
      throw coded(`${name} must be a positive integer no greater than its hard default`, "INVALID_LIMIT");
    }
    limits[name] = candidate;
  }
  if (options.deadline !== undefined) {
    const deadline = options.deadline instanceof Date ? options.deadline.getTime() : options.deadline;
    if (!Number.isFinite(deadline)) throw coded("deadline must be an epoch millisecond value or Date", "INVALID_DEADLINE");
    limits.timeoutMs = Math.min(limits.timeoutMs, Math.max(1, Math.floor(deadline - Date.now())));
  }
  return limits;
}

function validatePython(pythonPath) {
  if (typeof pythonPath !== "string" || !path.isAbsolute(pythonPath)) throw coded("an absolute isolated Python path is required", "PYTHON_UNAVAILABLE");
  let resolved;
  let stat;
  try { resolved = fs.realpathSync(pythonPath); stat = fs.statSync(resolved); } catch { throw coded("the isolated Python runtime is unavailable", "PYTHON_UNAVAILABLE"); }
  if (!stat.isFile()) throw coded("the isolated Python runtime is unsafe", "PYTHON_UNAVAILABLE");
  try { fs.accessSync(resolved, fs.constants.X_OK); } catch { throw coded("the isolated Python runtime is not executable", "PYTHON_UNAVAILABLE"); }
  return path.normalize(pythonPath);
}

function requireSandbox() {
  if (process.platform !== "darwin" || !fs.existsSync(SANDBOX)) throw coded("macOS sandbox-exec is required", "SANDBOX_UNAVAILABLE");
  const probe = spawnSync(SANDBOX, ["-p", SANDBOX_POLICY, "/usr/bin/true"], { env: { PATH: "/usr/bin:/bin" }, stdio: "ignore", timeout: 1_000 });
  if (probe.status !== 0) throw coded("macOS sandbox-exec network isolation is unavailable", "SANDBOX_UNAVAILABLE");
}

function safeBoundary(text, offset) {
  if (offset <= 0 || offset >= text.length) return true;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validCell(value) {
  const match = typeof value === "string" && /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(value);
  if (!match) return false;
  let column = 0;
  for (const character of match[1]) column = column * 26 + character.charCodeAt(0) - 64;
  return column <= 16_384 && Number(match[2]) <= 1_048_576;
}

function validLocator(locator, extension) {
  if (!locator || typeof locator !== "object" || Array.isArray(locator) || Buffer.byteLength(JSON.stringify(locator), "utf8") > 1_024) return false;
  if (extension === "pdf") return exactKeys(locator, ["page"]) && positiveInteger(locator.page);
  if (extension === "docx") {
    return (exactKeys(locator, ["paragraph"]) && positiveInteger(locator.paragraph)) ||
      (exactKeys(locator, ["table", "row", "cell", "paragraph"]) && [locator.table, locator.row, locator.cell, locator.paragraph].every(positiveInteger));
  }
  if (extension === "pptx") {
    const keys = locator.tableCell ? ["slide", "shape", "tableCell", "paragraph"] : ["slide", "shape", "paragraph"];
    return exactKeys(locator, keys) && positiveInteger(locator.slide) && positiveInteger(locator.paragraph) &&
      Array.isArray(locator.shape) && locator.shape.length > 0 && locator.shape.length <= 32 && locator.shape.every(positiveInteger) &&
      (!locator.tableCell || (exactKeys(locator.tableCell, ["row", "cell"]) && positiveInteger(locator.tableCell.row) && positiveInteger(locator.tableCell.cell)));
  }
  if (extension === "xlsx") {
    const keys = locator.valueSource ? ["sheet", "cell", "valueSource"] : ["sheet", "cell"];
    return exactKeys(locator, keys) && typeof locator.sheet === "string" && locator.sheet.trim().length > 0 && Buffer.byteLength(locator.sheet, "utf8") <= 256 &&
      validCell(locator.cell) && (locator.valueSource === undefined || locator.valueSource === "cachedFormula");
  }
  return false;
}

function validateIdentity(value, extension, limits) {
  if (!exactKeys(value, ["schemaVersion", "implementation", "implementationHash", "python", "format", "libraries", "options", "limits"]) ||
      value.schemaVersion !== PARSER_IDENTITY_SCHEMA.schemaVersion || value.implementation !== PARSER_IDENTITY_SCHEMA.implementation || value.format !== extension ||
      !/^[a-f0-9]{64}$/.test(value.implementationHash) || typeof value.python !== "string" || Buffer.byteLength(value.python, "utf8") > 64 ||
      !exactKeys(value.libraries, [extension]) || typeof value.libraries[extension] !== "string" || Buffer.byteLength(value.libraries[extension], "utf8") > 64 ||
      !exactKeys(value.options, ["isolatedMode", "formulaEvaluation", "xmlEntities", "pdfDecodedStreamBytes", "pdfDecodedTotalBytes", "addressSpaceBytes", "memoryLimitEnforced", "cpuSeconds"]) ||
      value.options.isolatedMode !== true || value.options.formulaEvaluation !== PARSER_IDENTITY_SCHEMA.formulaEvaluation || value.options.xmlEntities !== PARSER_IDENTITY_SCHEMA.xmlEntities ||
      typeof value.options.memoryLimitEnforced !== "boolean" || (extension === "pdf" && value.options.memoryLimitEnforced !== true) ||
      ![value.options.pdfDecodedStreamBytes, value.options.pdfDecodedTotalBytes, value.options.addressSpaceBytes, value.options.cpuSeconds].every(positiveInteger)) {
    throw coded("parser returned an invalid identity", "MALFORMED_PARSER_OUTPUT");
  }
  const expectedLimits = {
    inputBytes: limits.inputBytes, extractedUtf8Bytes: limits.extractedUtf8Bytes, pagesOrSlides: limits.pagesOrSlides,
    cells: limits.cells, segments: limits.segments, archiveMembers: limits.archiveMembers,
    archiveExpandedBytes: limits.archiveExpandedBytes, archiveMemberBytes: limits.archiveMemberBytes,
    archiveCompressionRatio: limits.archiveCompressionRatio,
  };
  if (canonicalJson(value.limits) !== canonicalJson(expectedLimits)) throw coded("parser identity limits do not match invocation", "MALFORMED_PARSER_OUTPUT");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validLimitations(limitations, extension) {
  const allowed = {
    docx: new Set(["endnotesNotExtracted", "footnotesNotExtracted", "headersFootersNotExtracted", "imageTextNotExtracted", "nestedTablesNotExtracted", "textBoxesNotExtracted"]),
    pptx: new Set(["chartTextNotExtracted", "imageTextNotExtracted", "notesNotExtracted"]),
    xlsx: new Set(["cachedFormulaValuesMayBeStale", "formulaCacheMissing"]),
  };
  if (extension === "pdf") {
    return limitations.every((item) => ["formXObjectCoverageUnverified", "imageTextNotExtracted", "unknownXObjectContent"].includes(item) || /^page:[1-9][0-9]*:nonTextContentNotExtracted$/.test(item));
  }
  if (!allowed[extension] || !limitations.every((item) => allowed[extension].has(item))) return false;
  return extension !== "xlsx" || !limitations.includes("formulaCacheMissing") || limitations.includes("cachedFormulaValuesMayBeStale");
}

function validateResult(raw, bytes, limits, extension) {
  let value;
  try { value = JSON.parse(raw); } catch { throw coded("parser returned malformed JSON", "MALFORMED_PARSER_OUTPUT"); }
  if (!exactKeys(value, ["version", "sourceHash", "parserFingerprint", "parserIdentity", "text", "segments", "complete", "coverage"]) || value.version !== PARSER_SCHEMA_VERSION || typeof value.text !== "string" || !Array.isArray(value.segments) || !value.parserIdentity) {
    throw coded("parser returned an invalid result schema", "MALFORMED_PARSER_OUTPUT");
  }
  validateIdentity(value.parserIdentity, extension, limits);
  const expectedFingerprint = crypto.createHash("sha256").update(canonicalJson(value.parserIdentity)).digest("hex");
  if (value.parserFingerprint !== expectedFingerprint) throw coded("parser fingerprint does not match its identity", "MALFORMED_PARSER_OUTPUT");
  const expectedHash = crypto.createHash("sha256").update(bytes).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(value.sourceHash) || value.sourceHash !== expectedHash) throw coded("parser source hash does not match input", "SOURCE_HASH_MISMATCH");
  if (Buffer.byteLength(value.text, "utf8") > limits.extractedUtf8Bytes || value.segments.length > limits.segments) throw coded("parser result exceeds a configured limit", "MALFORMED_PARSER_OUTPUT");
  let previousEnd = 0;
  for (const segment of value.segments) {
    if (!exactKeys(segment, ["start", "end", "locator"]) || !Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end) || segment.start < previousEnd || segment.end <= segment.start || segment.end > value.text.length || !safeBoundary(value.text, segment.start) || !safeBoundary(value.text, segment.end) || !value.text.slice(segment.start, segment.end).trim() || !validLocator(segment.locator, extension)) {
      throw coded("parser returned invalid UTF-16 segment offsets", "INVALID_SEGMENTS");
    }
    previousEnd = segment.end;
  }
  if (typeof value.complete !== "boolean" || !exactKeys(value.coverage, ["status", "limitations"]) || !["extracted", "partial"].includes(value.coverage.status) || !Array.isArray(value.coverage.limitations) || value.coverage.limitations.length > 128 || new Set(value.coverage.limitations).size !== value.coverage.limitations.length || value.coverage.limitations.some((item) => typeof item !== "string" || !item || Buffer.byteLength(item, "utf8") > 256) || !validLimitations(value.coverage.limitations, extension) || value.complete !== (value.coverage.status === "extracted" && value.coverage.limitations.length === 0)) {
    throw coded("parser returned invalid coverage metadata", "MALFORMED_PARSER_OUTPUT");
  }
  return deepFreeze(value);
}

function parserFailure(stderr, fallback) {
  try {
    const parsed = JSON.parse(stderr);
    if (parsed && parsed.error && typeof parsed.error.code === "string") return coded(parsed.error.message || "document parser failed", parsed.error.code);
  } catch {}
  return coded("document parser failed", fallback);
}

async function extractDocument(input, options = {}) {
  const extension = normalizedExtension(options.extension);
  const pythonPath = validatePython(options.pythonPath);
  const limits = boundedLimits(options);
  const bytes = Buffer.isBuffer(input) ? input : input instanceof Uint8Array ? Buffer.from(input) : null;
  if (!bytes) throw coded("document input must be bytes", "INVALID_INPUT");
  if (bytes.length > limits.inputBytes) throw coded("document exceeds the input limit", "INPUT_LIMIT");
  if (options.signal && options.signal.aborted) throw coded("document extraction was aborted", "ABORTED");
  if (options.deadline !== undefined && (options.deadline instanceof Date ? options.deadline.getTime() : options.deadline) <= Date.now()) throw coded("document extraction exceeded its deadline", "TIMEOUT");
  requireSandbox();

  const args = ["-p", SANDBOX_POLICY, pythonPath, "-I", PARSER_PATH, extension,
    String(limits.inputBytes), String(limits.extractedUtf8Bytes), String(limits.pagesOrSlides), String(limits.cells), String(limits.segments),
    String(limits.archiveMembers), String(limits.archiveExpandedBytes), String(limits.archiveMemberBytes), String(limits.archiveCompressionRatio)];
  return new Promise((resolve, reject) => {
    const child = spawn(SANDBOX, args, {
      detached: true,
      env: { PATH: "/usr/bin:/bin", HOME: "/var/empty", TMPDIR: "/tmp", PYTHONHASHSEED: "0" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure = null;
    let settled = false;
    let killTimer;
    let timeout;
    const signalGroup = (signal) => {
      try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") failure ||= coded("could not signal parser process group", "PROCESS_GROUP_SIGNAL_FAILED"); }
    };
    const terminate = (error) => {
      failure ||= error;
      signalGroup("SIGTERM");
      if (!killTimer) { killTimer = setTimeout(() => signalGroup("SIGKILL"), 250); killTimer.unref(); }
    };
    const abort = () => terminate(coded("document extraction was aborted", "ABORTED"));
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (options.signal) options.signal.removeEventListener("abort", abort);
      action(value);
    };
    const collect = (target, chunk, stream) => {
      const used = stream === "stdout" ? stdoutBytes : stderrBytes;
      const limit = stream === "stdout" ? limits.stdoutBytes : Math.min(limits.stdoutBytes, 64 * 1024);
      const remaining = Math.max(0, limit - used);
      if (remaining) target.push(chunk.subarray(0, remaining));
      if (stream === "stdout") stdoutBytes += Math.min(chunk.length, remaining); else stderrBytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) terminate(coded(`${stream} exceeded its limit`, "OUTPUT_LIMIT"));
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(stderr, chunk, "stderr"));
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") terminate(coded("parser stdin failed", "STDIN_FAILED")); });
    child.stdin.end(bytes);
    child.on("error", (error) => finish(reject, coded(`document parser could not start: ${error.message}`, "SPAWN_FAILED")));
    child.on("close", (code) => {
      const complete = () => {
        if (failure) return finish(reject, failure);
        const errorText = Buffer.concat(stderr).toString("utf8");
        if (code !== 0) return finish(reject, parserFailure(errorText, "PARSER_FAILED"));
        try { finish(resolve, validateResult(Buffer.concat(stdout).toString("utf8"), bytes, limits, extension)); }
        catch (error) { finish(reject, error); }
      };
      try {
        process.kill(-child.pid, 0);
        terminate(coded("parser left a lingering process", "LINGERING_PROCESS_GROUP"));
        const started = Date.now();
        const poll = setInterval(() => {
          try {
            process.kill(-child.pid, 0);
            signalGroup("SIGKILL");
            if (Date.now() - started > 1_000) { clearInterval(poll); finish(reject, coded("parser process group did not exit", "LINGERING_PROCESS_GROUP")); }
          } catch (error) { if (error.code === "ESRCH") { clearInterval(poll); complete(); } }
        }, 25);
        poll.unref();
      } catch (error) {
        if (error.code === "ESRCH") complete(); else finish(reject, coded("parser process group state is unknown", "PROCESS_GROUP_STATE_UNKNOWN"));
      }
    });
    if (options.signal) options.signal.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => terminate(coded("document extraction exceeded its deadline", "TIMEOUT")), limits.timeoutMs);
    timeout.unref();
  });
}

module.exports = { DEFAULT_LIMITS, PARSER_IDENTITY_SCHEMA, PARSER_SCHEMA_VERSION, extractDocument };

#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { compileScheduleSpec } = require("../src/orchestration/schedule-spec");

function main(argv = process.argv.slice(2)) {
  const file = argv[0];
  if (!file) {
    process.stderr.write("Usage: compile-schedule-spec <schedule-spec.json>\n");
    process.exitCode = 2;
    return null;
  }
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch (error) {
    process.stderr.write(`Invalid schedule spec: ${error.message}\n`);
    process.exitCode = 2;
    return null;
  }
  const compiled = compileScheduleSpec(spec);
  process.stdout.write(`${JSON.stringify(compiled, null, 2)}\n`);
  if (compiled.status === "rejected") process.exitCode = 2;
  return compiled;
}

if (require.main === module) main();

module.exports = { main };

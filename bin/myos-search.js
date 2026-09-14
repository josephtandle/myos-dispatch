#!/usr/bin/env node
"use strict";

const { execute } = require("../packages/local-search/discovery.js");

function main(argv = process.argv.slice(2), adapters) {
  let result;
  try {
    result = execute(argv, adapters);
  } catch {
    result = { ok: false, status: "internalError" };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok === false ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { main };

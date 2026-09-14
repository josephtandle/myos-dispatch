#!/usr/bin/env node
"use strict";

const path = require("node:path");
const service = require("./service");

function invalid(message) {
  throw Object.assign(new Error(message), { code: "INVALID_ARGUMENT" });
}

function parse(argv) {
  const args = [...argv];
  const operation = args.shift();
  if (!new Set(["enable", "disable", "status"]).has(operation)) invalid("operation must be enable, disable, or status");
  const values = {};
  while (args.length) {
    const flag = args.shift();
    if (flag === "--confirm") {
      if (Object.hasOwn(values, flag)) invalid(`duplicate argument: ${flag}`);
      values[flag] = true;
      continue;
    }
    if (!new Set(["--config", "--node24"]).has(flag) || args.length === 0) invalid(`unknown or incomplete argument: ${flag}`);
    if (Object.hasOwn(values, flag)) invalid(`duplicate argument: ${flag}`);
    values[flag] = args.shift();
  }
  if (!values["--config"] || !path.isAbsolute(values["--config"])) invalid("--config must be an absolute path");
  if (operation === "enable") {
    if (!values["--node24"] || !path.isAbsolute(values["--node24"])) invalid("enable requires an absolute --node24 path");
    if (values["--confirm"] !== true) invalid("enable requires --confirm");
  } else if (values["--node24"] || values["--confirm"]) invalid(`${operation} does not accept enable-only arguments`);
  return { operation, configPath: values["--config"], node24: values["--node24"], confirm: values["--confirm"] === true };
}

async function main(argv = process.argv.slice(2), dependencies) {
  const options = parse(argv);
  if (options.operation === "enable") return service.enable(options, dependencies);
  if (options.operation === "disable") return service.disable(options, dependencies);
  return service.status(options, dependencies);
}

if (require.main === module) {
  main().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }, (error) => {
    process.stdout.write(`${JSON.stringify(service.operationError(error))}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parse };

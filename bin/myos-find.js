#!/usr/bin/env node
"use strict";

const { main } = require("../packages/local-search/desktop-find");

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

#!/usr/bin/env node
'use strict';

const path = require('node:path');

const node24Bin = '/opt/homebrew/opt/node@24/bin';
if (process.versions.node.split('.')[0] !== '24') {
  console.error('Atelier refresh requires Node 24');
  process.exitCode = 2;
} else {
  process.env.PATH = `${node24Bin}:${process.env.PATH || ''}`;
  const { DEFAULT_CONFIG_PATH, readConfig, runRefresh } = require('../src/atelier-refresh');
  const args = process.argv.slice(2);
  let configPath = DEFAULT_CONFIG_PATH;
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] !== '--config' || !args[index + 1] || index + 2 !== args.length) {
      console.error('Usage: myos-atelier-refresh.js [--config ABSOLUTE_CONFIG_PATH]');
      process.exitCode = 2;
      break;
    }
    configPath = args[index + 1];
  }
  if (process.exitCode === undefined) {
    try {
      if (!path.isAbsolute(configPath)) throw new Error('config_path_must_be_absolute');
      const report = runRefresh(readConfig(configPath));
      console.log(JSON.stringify(report));
      if (report.status === 'attention') process.exitCode = 1;
    } catch {
      console.error('Atelier refresh failed: invalid or unavailable local configuration');
      process.exitCode = 1;
    }
  }
}

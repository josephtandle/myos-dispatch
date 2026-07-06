#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  auditFastpathsDoc,
  collectCapabilityIds,
  readJson,
} = require('../src/fastpath-store');

const HOME = process.env.HOME || os.homedir();
const WORKSPACE = path.join(HOME, '.myos', 'workspace');
const FASTPATHS_FILE = path.join(WORKSPACE, 'DISPATCH-FASTPATHS.json');
const CAPABILITIES_INDEX_FILE = path.join(WORKSPACE, 'capabilities-index.json');

function main() {
  if (!fs.existsSync(FASTPATHS_FILE)) {
    console.error(`DISPATCH-FASTPATHS.json not found: ${FASTPATHS_FILE}`);
    process.exit(1);
  }

  const fastpathsDoc = readJson(FASTPATHS_FILE);
  const capabilityIds = fs.existsSync(CAPABILITIES_INDEX_FILE)
    ? collectCapabilityIds(readJson(CAPABILITIES_INDEX_FILE))
    : new Set();
  const audit = auditFastpathsDoc(fastpathsDoc, {
    workspaceRoot: WORKSPACE,
    capabilityIds,
  });
  const warnings = audit.warnings.slice();
  const errors = audit.errors;
  if (capabilityIds.size === 0) {
    warnings.push('capabilities-index.json missing or empty; capability id checks skipped');
  }

  const counts = audit.counts || {};
  console.log(`Dispatch fastpaths: ${counts.activeCount || 0} active (${counts.stableCount || 0} stable, ${counts.probationCount || 0} probation, ${counts.retiredCount || 0} retired), cap ${counts.maxActive || 0}`);

  for (const warning of warnings) console.warn(`WARN: ${warning}`);
  for (const error of errors) console.error(`ERROR: ${error}`);

  if (errors.length > 0) process.exit(1);
}

main();

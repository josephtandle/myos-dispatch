#!/usr/bin/env node
'use strict';
const {syncAtelier}=require('../src/atelier-sync');
try {
  if(process.argv.length!==3) throw new Error('Usage: myos-atelier-sync REPOSITORY');
  console.log(JSON.stringify(syncAtelier(process.argv[2]),null,2));
} catch(error) { console.error(error.message); process.exitCode=1; }

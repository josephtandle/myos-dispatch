#!/usr/bin/env node
'use strict';
const {createSnapshot}=require('../src/atelier-source');
const root=process.argv[2];
if(!root){console.error('Usage: node bin/myos-atelier-snapshot.js REPOSITORY (after successful pinned Atelier graph build)');process.exitCode=2;}
else console.log(JSON.stringify(createSnapshot(root),null,2));

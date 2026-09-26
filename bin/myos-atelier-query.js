#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const {queryPortfolio,validatePortfolio}=require('../src/atelier-portfolio');
try {
  const [config,projectId,...query]=process.argv.slice(2);
  if(!config||!projectId)throw new Error('Usage: myos-atelier-query REGISTRY PROJECT_ID QUERY (or --validate)');
  const registry=JSON.parse(fs.readFileSync(config,'utf8'));
  if(projectId==='--validate') { const value=validatePortfolio(registry);console.log(JSON.stringify({status:'valid',brands:value.brands.size,projects:value.projects.size})); }
  else console.log(JSON.stringify(queryPortfolio({registry,projectId,query:query.join(' ')}),null,2));
} catch(error) {console.error(error.message);process.exitCode=1;}

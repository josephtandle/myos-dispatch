#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {auditCollections}=require('../src/atelier-governance');
const {getConfiguredDataSources}=require('../src/data-source-registry');
const {readAtelierSource}=require('../src/atelier-source');
try {
  const file=process.argv[2]||path.join(__dirname,'../config/atelier-governance.json');
  const catalog=JSON.parse(fs.readFileSync(file,'utf8'));
  const sources=getConfiguredDataSources().filter(s=>s.mode==='atelier');
  const result=auditCollections(catalog,sources.map(s=>s.id));
  const collections=sources.map(source=>{
    const entry=catalog.collections?.find(c=>c.sourceId===source.id);
    const expected=source.sourceOrigin?.path||source.path;
    if(entry?.canonicalPath!==expected)result.errors.push('canonical_source_mismatch:'+source.id);
    const read=readAtelierSource(source);
    if(read.status!=='fresh')result.errors.push('source_not_fresh:'+source.id);
    return {id:entry?.id,sourceId:source.id,status:read.status,authority:entry?.authority,semanticAcceptance:'not_inferred_from_enrollment'};
  });
  console.log(JSON.stringify({taskClass:'cheap_routing',status:result.errors.length?'invalid':'valid',...result,collections},null,2));
  if(result.errors.length)process.exitCode=1;
} catch { console.error('Governance audit failed: invalid or unavailable local configuration');process.exitCode=1; }

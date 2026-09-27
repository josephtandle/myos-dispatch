'use strict';
// Additive MyOS domain governance; never changes the Atelier root contracts.
const path=require('node:path');
const text=value=>typeof value==='string'&&value.trim().length>0;
function auditCollections(catalog,sourceIds=[]) {
  const errors=[];
  if(!Array.isArray(sourceIds)||!sourceIds.length)return {errors:['no_active_sources']};
  if(catalog?.schema!=='myos.knowledge-governance@v1'||!Array.isArray(catalog.collections)) return {errors:['invalid_catalog']};
  const ids=new Set(),sources=new Set();
  for(const c of catalog.collections) {
    if(!c||!text(c.id)||ids.has(c.id)||!text(c.sourceId)||sources.has(c.sourceId)) {errors.push('duplicate_or_invalid_collection');continue;}
    ids.add(c.id);sources.add(c.sourceId);
    if(!text(c.owner)||!text(c.canonicalPath)||!path.isAbsolute(c.canonicalPath)||!['authored-source','original-evidence','mixed-source'].includes(c.role)||c.authority!=='documentary'||c.conflictRule!=='owner-review'||c.operationalFacts!=='live-system-only') errors.push('invalid_authority:'+c.id);
  }
  for(const id of sourceIds)if(!sources.has(id))errors.push('missing_collection:'+id);
  for(const id of sources)if(!sourceIds.includes(id))errors.push('unknown_source:'+id);
  return {errors};
}
function resolveClaim({records,key,hashes}={}) {
  const invalid={status:'invalid'};
  if(!Array.isArray(records)||!text(key)||!hashes||typeof hashes!=='object'||Array.isArray(hashes))return invalid;
  const selected=records.filter(r=>r?.key===key);
  const accepted=selected.filter(r=>r.stage==='accepted');
  if(!accepted.length)return {status:'unaccepted'};
  const ids=new Map();
  for(const r of accepted) {
    if(Date.parse(r.acceptedAt)>Date.now())return invalid;
    // Binary intake must produce a separately verified text source before semantic acceptance.
    if(!/\.(md|markdown|mdown|txt)$/i.test(r.source?.path||''))return invalid;
    if(!text(r.id)||ids.has(r.id)||!text(r.collectionId)||!text(r.value)||!text(r.acceptedBy)||!Number.isFinite(Date.parse(r.acceptedAt))||r.confidence!=='verified'||!text(r.source?.path)||path.isAbsolute(r.source.path)||r.source.path.split(/[\\/]/).includes('..')||typeof r.source.sha256!=='string'||!/^[a-f0-9]{64}$/.test(r.source.sha256)||!Array.isArray(r.supersedes)||r.supersedes.some(id=>!text(id)))return invalid;
    ids.set(r.id,r);
  }
  for(const r of accepted)for(const id of r.supersedes)if(!ids.has(id)||ids.get(id).collectionId!==r.collectionId)return invalid;
  const visiting=new Set(),visited=new Set();
  function acyclic(id) {
    if(visiting.has(id))return false;
    if(visited.has(id))return true;
    visiting.add(id);
    for(const parent of ids.get(id).supersedes)if(!acyclic(parent))return false;
    visiting.delete(id);visited.add(id);return true;
  }
  if(accepted.some(r=>!acyclic(r.id)))return invalid;
  const replaced=new Set(accepted.flatMap(r=>r.supersedes));
  const current=accepted.filter(r=>!replaced.has(r.id));
  if(current.some(r=>hashes[r.collectionId+':'+r.source.path]!==r.source.sha256))return {status:'stale'};
  if(current.length!==1)return {status:'conflict',recordIds:current.map(r=>r.id)};
  return {status:'accepted',record:current[0]};
}
module.exports={auditCollections,resolveClaim};

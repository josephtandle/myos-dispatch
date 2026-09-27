'use strict';
const fs=require('node:fs');
const {queryPortfolio}=require('./atelier-portfolio');
// Internal authorization seam only. A transport must verify tokens before constructing principal.
// Never map an HTTP request's principal/issuer/subject fields directly to this argument.
function readAuthorizedKnowledge({registryPath,policyPath,principal,projectId,brandId,query=''}) {
  const denied={status:'denied',matches:[]};
  if(!principal||typeof principal.issuer!=='string'||typeof principal.subject!=='string'||!principal.subject) return denied;
  try {
    const policy=JSON.parse(fs.readFileSync(policyPath,'utf8'));
    if(policy.schema!=='myos.atelier-grants@v1'||!Array.isArray(policy.grants)) return denied;
    const grants=policy.grants.filter(g=>g.issuer===principal.issuer&&g.subject===principal.subject&&g.projectId===projectId&&g.disabled!==true&&(!g.expiresAt||Date.parse(g.expiresAt)>Date.now()));
    if(grants.length!==1) return denied;
    const grant=grants[0];
    if(!Array.isArray(grant.brandIds)||!Array.isArray(grant.audiences)||grant.audiences.some(a=>!['private','team','public'].includes(a))) return denied;
    if(brandId&&!grant.brandIds.includes(brandId)) return denied;
    const registry=JSON.parse(fs.readFileSync(registryPath,'utf8'));
    const project=registry.projects?.find(p=>p.id===projectId);
    const documentsOnly=Array.isArray(project?.brandIds)&&project.brandIds.length===0;
    const chosen=brandId||project?.primaryBrandId||(project?.brandIds.length===1?project.brandIds[0]:null);
    if(documentsOnly ? brandId||grant.brandIds.length!==0 : !chosen||!grant.brandIds.includes(chosen))return denied;
    const response=queryPortfolio({registry,projectId,brandId:chosen,query,audiences:grant.audiences});
    if(response.status!=='ok') return denied;
    // External readers never receive unverified fallback material or stale metadata.
    if(response.results.some(r=>r.status!=='fresh'))return {status:'unavailable',matches:[]};
    const matches=response.results.flatMap(r=>r.matches.map(({id,title,summary,audience,hash})=>({id,title,summary,audience,hash,citation:`atelier://${encodeURIComponent(projectId)}/${encodeURIComponent(chosen||'_project')}/${encodeURIComponent(id)}`})));
    // Reload on each request and fail closed if permissions changed during retrieval.
    if(JSON.stringify(policy)!==JSON.stringify(JSON.parse(fs.readFileSync(policyPath,'utf8')))) return denied;
    return {status:'ok',projectId,brandId:chosen,evidenceStatus:'source_reference',liveFactAuthority:false,matches};
  } catch { return denied; }
}
module.exports={readAuthorizedKnowledge};

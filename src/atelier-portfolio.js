'use strict';
const fs=require('node:fs');
const path=require('node:path');
const cp=require('node:child_process');
const {readAtelierSource}=require('./atelier-source');
const AUDIENCES=['private','team','public'];
function validatePortfolio(registry) {
  if(registry?.schema!=='myos.atelier-portfolio@v1'||!Array.isArray(registry.brands)||!Array.isArray(registry.projects)||!registry.sources||typeof registry.sources!=='object') throw new Error('invalid_portfolio');
  const brands=new Map(),projects=new Map(),brains=new Set();
  for(const brand of registry.brands) {
    if(typeof brand.id!=='string'||!brand.id||brands.has(brand.id)) throw new Error('duplicate_or_invalid_brand');
    const source=registry.sources[brand.brain?.sourceId];
    const file=brand.brain?.path;
    if(!source||typeof file!=='string'||path.isAbsolute(file)||file.split('/').includes('..')||!file.endsWith('.md')) throw new Error('invalid_brand_brain');
    const root=fs.realpathSync(source.path),canonical=fs.realpathSync(path.join(root,file));
    if(!canonical.startsWith(root+path.sep)||brains.has(canonical)) throw new Error('duplicate_or_escaped_brand_brain');
    cp.execFileSync('git',['--no-optional-locks','-C',root,'ls-files','--error-unmatch','--',file],{stdio:'pipe',timeout:5000});
    brains.add(canonical);brands.set(brand.id,brand);
  }
  for(const project of registry.projects) {
    if(typeof project.id!=='string'||!project.id||projects.has(project.id)||!Array.isArray(project.brandIds)||project.brandIds.some(id=>!brands.has(id))||!Array.isArray(project.sourceIds)||(!project.brandIds.length&&!project.sourceIds.length)) throw new Error('invalid_project');
    if(project.primaryBrandId&&!project.brandIds.includes(project.primaryBrandId)) throw new Error('invalid_primary_brand');
    for(const id of project.sourceIds) {
      const source=registry.sources[id];
      if(!source||!Array.isArray(source.includePaths)||!source.includePaths.length) throw new Error('unscoped_project_source');
    }
    projects.set(project.id,project);
  }
  return {brands,projects};
}
function queryPortfolio({registry,projectId,brandId,query='',audiences=['private','team']}) {
  const {brands,projects}=validatePortfolio(registry);
  const project=projectId?projects.get(projectId):null;
  if(projectId&&!project) return {status:'unknown_project',results:[]};
  const documentsOnly=project?.brandIds.length===0;
  const chosen=brandId||project?.primaryBrandId||(project?.brandIds.length===1?project.brandIds[0]:null);
  if(documentsOnly&&brandId) return {status:'brand_project_mismatch',results:[]};
  if(!chosen&&!documentsOnly) return {status:'ambiguous_brand',results:[]};
  const brand=brands.get(chosen);
  if(!documentsOnly&&(!brand||project&&!project.brandIds.includes(chosen))) return {status:'brand_project_mismatch',results:[]};
  const selections=[...(brand?[{id:brand.brain.sourceId,includePaths:[brand.brain.path],role:'brand_brain'}]:[]),...(project?.sourceIds||[]).map(id=>({id,role:'project'}))];
  const results=selections.map(({id,includePaths,role})=>{
    const source=registry.sources[id];
    const allowed=audiences.filter(a=>AUDIENCES.includes(a)&&(source.audiences||['private','team']).includes(a));
    return {sourceId:id,role,...readAtelierSource({...source,includePaths:includePaths||source.includePaths,audiences:allowed},{query})};
  });
  return {status:'ok',projectId:project?.id||null,brandId:chosen,results};
}
module.exports={queryPortfolio,validatePortfolio};

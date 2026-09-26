'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const cp=require('node:child_process');
const {queryPortfolio}=require('../src/atelier-portfolio');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'atelier-portfolio-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  cp.execFileSync('git',['init','-q',root]);
  for(const id of ['alpha','beta'])fs.writeFileSync(path.join(root,id+'.md'),'---\nkg:\n  audience: team\n---\n# '+id+'\nBrand '+id);
  cp.execFileSync('git',['-C',root,'add','.']);
  const registry={schema:'myos.atelier-portfolio@v1',sources:{shared:{path:root}},brands:[{id:'alpha',brain:{sourceId:'shared',path:'alpha.md'}},{id:'beta',brain:{sourceId:'shared',path:'beta.md'}}],projects:[{id:'a',brandIds:['alpha'],sourceIds:[]},{id:'b',brandIds:['beta'],sourceIds:[]}]};
  return {root,registry};
}
test('explicit project selects its own canonical Brand Brain in a shared repository',t=>{
  const {root,registry}=fixture(t);
  const result=queryPortfolio({registry,projectId:'a',query:'brand',audiences:['team']});
  assert.equal(result.status,'ok');
  assert.equal(result.brandId,'alpha');
  assert.deepEqual(result.results.flatMap(r=>r.matches.map(n=>n.sourcePath)),[fs.realpathSync(path.join(root,'alpha.md'))]);
});
test('multi-brand project requires an explicit or primary brand and rejects mismatch',t=>{
  const {registry}=fixture(t);
  registry.projects.push({id:'both',brandIds:['alpha','beta'],sourceIds:[]});
  assert.equal(queryPortfolio({registry,projectId:'both'}).status,'ambiguous_brand');
  assert.equal(queryPortfolio({registry,projectId:'both',brandId:'beta'}).brandId,'beta');
  assert.equal(queryPortfolio({registry,projectId:'a',brandId:'beta'}).status,'brand_project_mismatch');
});
test('duplicate canonical brains and missing sources fail validation',t=>{
  const {registry}=fixture(t);
  registry.brands[1].brain.path='alpha.md';
  assert.throws(()=>queryPortfolio({registry,projectId:'a'}),/duplicate_or_escaped_brand_brain/);
  registry.brands[1].brain.path='missing.md';
  assert.throws(()=>queryPortfolio({registry,projectId:'a'}),/ENOENT/);
});
test('explicit audience allowance cannot be enlarged by a request',t=>{
  const {registry}=fixture(t);
  registry.sources.shared.audiences=['private'];
  const result=queryPortfolio({registry,projectId:'a',audiences:['team']});
  assert.deepEqual(result.results.flatMap(r=>r.matches),[]);
});
test('unspecified source audiences do not admit public requests',t=>{
  const {root,registry}=fixture(t);
  fs.writeFileSync(path.join(root,'alpha.md'),'---\nkg:\n  audience: public\n---\n# Public alpha');
  const result=queryPortfolio({registry,projectId:'a',audiences:['public']});
  assert.deepEqual(result.results.flatMap(r=>r.matches),[]);
});
test('document-only projects retrieve their explicit scope without inventing a brand',t=>{
  const {registry}=fixture(t);
  registry.sources.operations={...registry.sources.shared,includePaths:['beta.md']};
  registry.projects.push({id:'operations',brandIds:[],sourceIds:['operations']});
  const result=queryPortfolio({registry,projectId:'operations',query:'brand'});
  assert.equal(result.status,'ok');
  assert.equal(result.brandId,null);
  assert.deepEqual(result.results.map(r=>r.role),['project']);
  assert.ok(result.results.flatMap(r=>r.matches).every(n=>n.sourcePath.endsWith('beta.md')));
  assert.equal(result.results.flatMap(r=>r.matches).length,1);
  assert.equal(queryPortfolio({registry,projectId:'operations',brandId:'alpha'}).status,'brand_project_mismatch');
});

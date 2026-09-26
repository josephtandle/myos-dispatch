'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const cp=require('node:child_process');
const {createSnapshot}=require('../src/atelier-source');
const {readAuthorizedKnowledge}=require('../src/atelier-access');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'atelier-access-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  cp.execFileSync('git',['init','-q',root]);
  fs.writeFileSync(path.join(root,'brain.md'),'---\nkg:\n  audience: team\n---\n# Brand\nTeam brand guidelines');
  cp.execFileSync('git',['-C',root,'add','brain.md']);
  fs.mkdirSync(path.join(root,'atelier-output'));fs.mkdirSync(path.join(root,'.atelier-local'));
  fs.writeFileSync(path.join(root,'atelier-output/knowledge.graph.json'),JSON.stringify({schema:'mnstry.atelier-knowledge-graph@v1',nodes:[{id:'brand:brain',path:'brain.md',title:'Brand',summary:'Team brand guidelines',audience:'team',relations:{}}],errors:[]}));
  fs.writeFileSync(path.join(root,'.atelier-local/myos-dispatch-snapshot.json'),JSON.stringify(createSnapshot(root)));
  const registry={schema:'myos.atelier-portfolio@v1',sources:{brain:{path:root}},brands:[{id:'brand',brain:{sourceId:'brain',path:'brain.md'}}],projects:[{id:'demo',brandIds:['brand'],sourceIds:[]}]};
  const policy={schema:'myos.atelier-grants@v1',grants:[{issuer:'https://identity.example',subject:'alice',projectId:'demo',brandIds:['brand'],audiences:['team']}]};
  const principal={issuer:'https://identity.example',subject:'alice'};
  const registryPath=path.join(root,'portfolio.json'),policyPath=path.join(root,'grants.json');
  fs.writeFileSync(registryPath,JSON.stringify(registry));fs.writeFileSync(policyPath,JSON.stringify(policy));
  return {root,registryPath,policyPath,policy,principal,projectId:'demo',query:'brand'};
}
test('a trusted authenticated principal receives only granted knowledge without local filesystem paths',t=>{
  const options=fixture(t);
  const result=readAuthorizedKnowledge(options);
  assert.equal(result.status,'ok');
  assert.equal(result.matches.length,1);
  assert.equal(result.matches[0].summary,'Team brand guidelines');
  assert.equal(JSON.stringify(result).includes(options.root),false);
});
test('other identities, issuers, projects and brands are denied without source metadata',t=>{
  const options=fixture(t);
  for(const change of [{principal:null},{principal:{...options.principal,subject:'bob'}},{principal:{...options.principal,issuer:'https://other.example'}},{projectId:'other'},{brandId:'other'}]) {
    assert.deepEqual(readAuthorizedKnowledge({...options,...change}),{status:'denied',matches:[]});
  }
});
test('revoked and expired grants stop subsequent reads',t=>{
  const options=fixture(t);
  assert.equal(readAuthorizedKnowledge(options).status,'ok');
  options.policy.grants[0].expiresAt='2000-01-01T00:00:00Z';
  fs.writeFileSync(options.policyPath,JSON.stringify(options.policy));
  assert.equal(readAuthorizedKnowledge(options).status,'denied');
  options.policy.grants=[];
  fs.writeFileSync(options.policyPath,JSON.stringify(options.policy));
  assert.equal(readAuthorizedKnowledge(options).status,'denied');
});
test('stale sources are unavailable to external access instead of falling back',t=>{
  const options=fixture(t);
  fs.appendFileSync(path.join(options.root,'brain.md'),'\nUpdated');
  assert.deepEqual(readAuthorizedKnowledge(options),{status:'unavailable',matches:[]});
});

'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {auditCollections,resolveClaim}=require('../src/atelier-governance');
const hash='a'.repeat(64);
const claim=(id,value)=>({id,key:'brand:alpha:positioning',value,collectionId:'alpha',stage:'accepted',source:{path:'brain.md',sha256:hash},confidence:'verified',acceptedBy:'joe',acceptedAt:'2026-09-26T00:00:00Z',supersedes:[]});
test('an empty installation cannot pass the governance readiness audit',()=>{
  assert.ok(auditCollections({schema:'myos.knowledge-governance@v1',collections:[]},[]).errors.includes('no_active_sources'));
});
test('future-dated acceptance cannot establish currently accepted knowledge',()=>{
  const r={...claim('future','A'),acceptedAt:'9999-01-01T00:00:00Z'};
  assert.equal(resolveClaim({records:[r],key:r.key,hashes:{'alpha:brain.md':hash}}).status,'invalid');
});
test('collection audit requires explicit authority and prevents documentary operational truth',()=>{
  const collection={id:'alpha',sourceId:'source-alpha',owner:'joe',canonicalPath:'/approved/alpha',role:'authored-source',authority:'documentary',conflictRule:'owner-review',operationalFacts:'live-system-only'};
  assert.deepEqual(auditCollections({schema:'myos.knowledge-governance@v1',collections:[collection]},['source-alpha']).errors,[]);
  assert.ok(auditCollections({schema:'myos.knowledge-governance@v1',collections:[{...collection,operationalFacts:'documents-win'}]},['source-alpha']).errors.length);
  assert.ok(auditCollections({schema:'myos.knowledge-governance@v1',collections:[]},['source-alpha']).errors.length);
});
test('enrollment and extraction do not silently become accepted knowledge',()=>{
  const result=resolveClaim({records:[{...claim('asset','claim'),stage:'enrolled',acceptedBy:undefined}],key:'brand:alpha:positioning',hashes:{'alpha:brain.md':hash}});
  assert.equal(result.status,'unaccepted');
});
test('accepted conflicting claims require owner resolution rather than newest timestamp',()=>{
  const result=resolveClaim({records:[claim('first','A'),claim('second','B')],key:'brand:alpha:positioning',hashes:{'alpha:brain.md':hash}});
  assert.equal(result.status,'conflict');
  assert.equal(result.record,undefined);
});
test('explicit same-claim supersession resolves and changed source invalidates acceptance',()=>{
  const records=[claim('first','A'),{...claim('second','B'),supersedes:['first']}];
  const options={records,key:'brand:alpha:positioning',hashes:{'alpha:brain.md':hash}};
  assert.equal(resolveClaim(options).record.id,'second');
  assert.equal(resolveClaim({...options,hashes:{'alpha:brain.md':'b'.repeat(64)}}).status,'stale');
});
test('unattributed acceptance and dangling supersession fail closed',()=>{
  assert.equal(resolveClaim({records:[{...claim('first','A'),acceptedBy:''}],key:'brand:alpha:positioning',hashes:{'alpha:brain.md':hash}}).status,'invalid');
  assert.equal(resolveClaim({records:[{...claim('first','A'),supersedes:['missing']}],key:'brand:alpha:positioning',hashes:{'alpha:brain.md':hash}}).status,'invalid');
});
test('asset sidecars and unextracted binary assets cannot substantiate accepted claims',()=>{
  for(const file of ['report.pdf.kg.json','report.pdf','report.docx']) {
    const r={...claim('asset','The report says A'),source:{path:file,sha256:hash}};
    assert.equal(resolveClaim({records:[r],key:r.key,hashes:{['alpha:'+file]:hash}}).status,'invalid');
  }
});
test('supersession cycles and cross-collection replacement are invalid',()=>{
  const first={...claim('first','A'),supersedes:['second']};
  const second={...claim('second','B'),supersedes:['first']};
  assert.equal(resolveClaim({records:[first,second],key:first.key,hashes:{'alpha:brain.md':hash}}).status,'invalid');
  assert.equal(resolveClaim({records:[claim('first','A'),{...claim('second','B'),collectionId:'beta',supersedes:['first']}],key:first.key,hashes:{'alpha:brain.md':hash,'beta:brain.md':hash}}).status,'invalid');
});

'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const cp=require('node:child_process');
const {syncAtelier}=require('../src/atelier-sync');
const {readAtelierSource}=require('../src/atelier-source');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'atelier-sync-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  cp.execFileSync('git',['init','-q',root]);
  fs.writeFileSync(path.join(root,'brand.md'),'---\nkg:\n  audience: team\n---\n# Brand A\nOriginal');
  fs.writeFileSync(path.join(root,'atelier.project.json'),JSON.stringify({graph:{outputPath:'atelier-output/knowledge.graph.json'},roots:{workspace:'.'},repos:[{path:'.'}]}));
  cp.execFileSync('git',['-C',root,'add','.']);
  return root;
}
function build(root) {
  fs.mkdirSync(path.join(root,'atelier-output'),{recursive:true});
  fs.writeFileSync(path.join(root,'atelier-output/knowledge.graph.json'),JSON.stringify({schema:'mnstry.atelier-knowledge-graph@v1',nodes:[{id:'brand:a',path:'brand.md',audience:'team',summary:fs.readFileSync(path.join(root,'brand.md'),'utf8'),relations:{}}],errors:[]}));
}
test('sync rebuilds graph then snapshots current source, restoring fresh retrieval',t=>{
  const root=fixture(t);
  assert.equal(syncAtelier(root,{build}).status,'fresh');
  assert.equal(readAtelierSource({path:root}).status,'fresh');
  fs.appendFileSync(path.join(root,'brand.md'),'\nRevised');
  assert.equal(readAtelierSource({path:root}).reason,'graph_stale');
  assert.equal(syncAtelier(root,{build}).status,'fresh');
  assert.ok(readAtelierSource({path:root}).matches[0].summary.includes('Revised'));
});
test('failed rebuild removes freshness receipt and preserves the previous snapshot as recovery data',t=>{
  const root=fixture(t);
  syncAtelier(root,{build});
  assert.throws(()=>syncAtelier(root,{build:()=>{throw new Error('build_failed');}}),/build_failed/);
  assert.equal(readAtelierSource({path:root}).reason,'snapshot_missing');
  assert.ok(fs.readdirSync(path.join(root,'.atelier-local')).some(f=>f.startsWith('snapshot-before-')));
});
test('source mutation during build cannot be certified fresh',t=>{
  const root=fixture(t);
  assert.throws(()=>syncAtelier(root,{build:repo=>{build(repo);fs.appendFileSync(path.join(repo,'brand.md'),'\nConcurrent edit');}}),/source_changed_during_build/);
  assert.equal(readAtelierSource({path:root}).reason,'snapshot_missing');
});
test('refreshing one brand leaves the second brands snapshot unchanged',t=>{
  const a=fixture(t),b=fixture(t);
  syncAtelier(a,{build});syncAtelier(b,{build});
  const before=fs.readFileSync(path.join(b,'.atelier-local/myos-dispatch-snapshot.json'),'utf8');
  fs.appendFileSync(path.join(a,'brand.md'),'\nRevised A');syncAtelier(a,{build});
  assert.equal(fs.readFileSync(path.join(b,'.atelier-local/myos-dispatch-snapshot.json'),'utf8'),before);
  assert.equal(readAtelierSource({path:b}).status,'fresh');
});
test('a dead process lock is preserved and recovered without removing an active lock',t=>{
  const root=fixture(t);
  fs.mkdirSync(path.join(root,'.atelier-local'));
  const lock=path.join(root,'.atelier-local/sync.lock');
  const deadPid=Number(cp.execFileSync(process.execPath,['-e','console.log(process.pid)'],{encoding:'utf8'}));
  fs.writeFileSync(lock,JSON.stringify({pid:deadPid}));
  assert.equal(syncAtelier(root,{build}).status,'fresh');
  assert.ok(fs.readdirSync(path.dirname(lock)).some(f=>f.startsWith('abandoned-lock-')));
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid}));
  assert.throws(()=>syncAtelier(root,{build}),/sync_locked/);
  assert.ok(fs.existsSync(lock));
});

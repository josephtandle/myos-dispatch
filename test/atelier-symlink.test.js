'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const cp=require('node:child_process');
const {createSnapshot,readAtelierSource}=require('../src/atelier-source');
const {planAudiences}=require('../src/atelier-audience');
function fixture(t) {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'atelier-links-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const root=path.join(base,'repo');fs.mkdirSync(root);
  cp.execFileSync('git',['init','-q',root]);
  fs.writeFileSync(path.join(base,'outside.md'),'Outside sentinel');
  fs.writeFileSync(path.join(root,'note.md'),'---\nkg:\n  audience: team\n---\n# Inside');
  fs.writeFileSync(path.join(root,'atelier.project.json'),JSON.stringify({name:'demo'}));
  fs.symlinkSync('../outside.md',path.join(root,'external.md'));
  fs.symlinkSync('missing.md',path.join(root,'dangling.md'));
  fs.symlinkSync('note.md',path.join(root,'internal.md'));
  cp.execFileSync('git',['-C',root,'add','.']);
  fs.mkdirSync(path.join(root,'atelier-output'));fs.mkdirSync(path.join(root,'.atelier-local'));
  fs.writeFileSync(path.join(root,'atelier-output/knowledge.graph.json'),JSON.stringify({schema:'mnstry.atelier-knowledge-graph@v1',nodes:['note.md','external.md','internal.md'].map(file=>({id:file,path:file,title:file,audience:'team',relations:{}})),errors:[]}));
  return {base,root};
}
test('tracked symlinks are omitted without reading their targets or blocking real sources',t=>{
  const {root}=fixture(t);
  const snapshot=createSnapshot(root);
  assert.deepEqual(Object.keys(snapshot.files).sort(),['atelier.project.json','note.md']);
  fs.writeFileSync(path.join(root,'.atelier-local/myos-dispatch-snapshot.json'),JSON.stringify(snapshot));
  const result=readAtelierSource({path:root,audiences:['team']});
  assert.equal(result.status,'fresh');
  assert.deepEqual(result.matches.map(x=>x.id),['note.md']);
  fs.unlinkSync(path.join(root,'external.md'));
  fs.writeFileSync(path.join(root,'external.md'),'Now an ordinary source');
  assert.equal(readAtelierSource({path:root,audiences:['team']}).reason,'graph_stale');
});
test('audience planning leaves internal external and dangling symlinks untouched',t=>{
  const {base,root}=fixture(t);
  const plan=planAudiences(root);
  assert.deepEqual(Object.keys(plan.decisions),['note.md']);
  assert.equal(fs.readFileSync(path.join(base,'outside.md'),'utf8'),'Outside sentinel');
  assert.equal(fs.readlinkSync(path.join(root,'external.md')),'../outside.md');
});

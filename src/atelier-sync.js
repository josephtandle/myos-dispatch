'use strict';
const fs=require('node:fs');
const path=require('node:path');
const cp=require('node:child_process');
const crypto=require('node:crypto');
const {sourceManifest,createSnapshot,validGraph}=require('./atelier-source');
function acquireLock(lock) {
  try {
    const fd=fs.openSync(lock,'wx',0o600);
    fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));
    return fd;
  } catch(error) {
    if(error.code!=='EEXIST')throw error;
    const stat=fs.lstatSync(lock);
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error('sync_locked');
    let owner;
    try{owner=JSON.parse(fs.readFileSync(lock,'utf8'));}catch{throw new Error('sync_locked');}
    if(!Number.isSafeInteger(owner.pid)||owner.pid<1)throw new Error('sync_locked');
    try{process.kill(owner.pid,0);throw new Error('sync_locked');}catch(check){if(check.code!=='ESRCH')throw new Error('sync_locked');}
    // Serialize recovery so competing processes cannot move a newly acquired lock.
    const guard=lock+'.recovery';
    let recovery;
    try{recovery=fs.openSync(guard,'wx',0o600);}catch{throw new Error('sync_locked');}
    try {
      const current=fs.lstatSync(lock);
      if(current.ino!==stat.ino||current.dev!==stat.dev)throw new Error('sync_locked');
      fs.renameSync(lock,path.join(path.dirname(lock),'abandoned-lock-'+crypto.randomUUID()+'.json'));
      return acquireLock(lock);
    } finally {fs.closeSync(recovery);fs.unlinkSync(guard);}
  }
}
function syncAtelier(root,options={}) {
  root=fs.realpathSync(root);
  const project=JSON.parse(fs.readFileSync(path.join(root,'atelier.project.json'),'utf8'));
  if(project.graph?.outputPath!=='atelier-output/knowledge.graph.json'||project.roots?.workspace!=='.'||project.repos?.length!==1||project.repos[0].path!=='.') throw new Error('Only an in-place single-root graph can be synchronized');
  const state=path.join(root,'.atelier-local');
  fs.mkdirSync(state,{recursive:true,mode:0o700});
  if(fs.realpathSync(state)!==state) throw new Error('Unsafe state directory');
  const lock=path.join(state,'sync.lock');
  const fd=acquireLock(lock);
  const snapshotPath=path.join(state,'myos-dispatch-snapshot.json');
  const temp=path.join(state,'snapshot-'+crypto.randomUUID()+'.tmp');
  try {
    const before=sourceManifest(root);
    // A failed rebuild must leave no freshness receipt for the old graph.
    if(fs.existsSync(snapshotPath)) fs.renameSync(snapshotPath,path.join(state,'snapshot-before-'+crypto.randomUUID()+'.json'));
    if(options.build) options.build(root);
    else cp.execFileSync('npx',['-y','-p','@mnstry/atelier@0.2.0-alpha.12','mnstry-atelier','graph','--project','./atelier.project.json'],{cwd:root,stdio:'pipe',timeout:120000,maxBuffer:4*1024*1024});
    const snapshot=createSnapshot(root);
    if(JSON.stringify(before)!==JSON.stringify(snapshot.files)) throw new Error('source_changed_during_build');
    const graph=JSON.parse(fs.readFileSync(path.join(root,project.graph.outputPath),'utf8'));
    if(!validGraph(graph)) throw new Error('graph_invalid');
    fs.writeFileSync(temp,JSON.stringify(snapshot,null,2)+'\n',{flag:'wx',mode:0o600});
    fs.renameSync(temp,snapshotPath);
    return {status:'fresh',repository:root,files:Object.keys(snapshot.files).length,nodes:graph.nodes.length,graphHash:snapshot.graphHash};
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
    if(fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
module.exports={syncAtelier};

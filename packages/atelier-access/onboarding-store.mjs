import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const PRIVATE=0o600;
const stable=value=>JSON.stringify(value,null,2)+'\n';

export async function withWorkflowLock(file,apply,run) {
  if(!apply)return run();
  const lockPath=file+'.workflow.lock';
  let handle;
  try{handle=await fs.open(lockPath,'wx',PRIVATE);}catch(error){if(error.code==='EEXIST')throw new Error('concurrent_state_drift');throw error;}
  try{return await run();}finally{await handle.close();await fs.unlink(lockPath);}
}

export async function readPrivateJson(file) {
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw new Error('private_file_required');
  const raw=await fs.readFile(file,'utf8');
  try{return {raw,value:JSON.parse(raw)};}catch{throw new Error('invalid_json');}
}

async function lock(file) {
  const lockFile=file+'.onboarding.lock';
  try {
    const handle=await fs.open(lockFile,'wx',PRIVATE);
    await handle.close();
  } catch(error) {
    if(error?.code==='EEXIST')throw new Error('concurrent_state_drift');
    throw error;
  }
  return async()=>{await fs.rm(lockFile,{force:true});};
}

export async function atomicJsonWrite(file,expectedRaw,value) {
  const release=await lock(file);
  try {
    const current=await fs.readFile(file,'utf8');
    if(current!==expectedRaw)throw new Error('concurrent_state_drift');
    const backup=file+'.bak-'+crypto.randomUUID();
    await fs.writeFile(backup,current,{mode:PRIVATE,flag:'wx'});
    await fs.chmod(backup,PRIVATE);
    const temporary=path.join(path.dirname(file),'.'+path.basename(file)+'.'+crypto.randomUUID()+'.tmp');
    await fs.writeFile(temporary,stable(value),{mode:PRIVATE,flag:'wx'});
    await fs.chmod(temporary,PRIVATE);
    await fs.rename(temporary,file);
    return {backup};
  } finally {await release();}
}

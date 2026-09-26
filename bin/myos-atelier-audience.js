#!/usr/bin/env node
'use strict';
const {planAudiences}=require('../src/atelier-audience');
const fs=require('node:fs');
const path=require('node:path');
const args=process.argv.slice(2);
const root=args.find(arg=>!arg.startsWith('--'));
if(!root){console.error('Usage: node bin/myos-atelier-audience.js REPOSITORY [--patch | --apply]');process.exitCode=2;}
else {
  const result=planAudiences(root);
  if(args.includes('--apply')) {
    for(const change of result.changes) if(fs.readFileSync(path.join(result.root,change.file),'utf8')!==change.original) throw new Error('Source changed during planning: '+change.file);
    for(const change of result.changes) fs.writeFileSync(path.join(result.root,change.file),change.updated);
    fs.mkdirSync(path.join(result.root,'.atelier-local'),{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(result.root,'atelier.audience-policy.json'),JSON.stringify(result.policy,null,2)+'\n',{mode:0o600});
    fs.writeFileSync(path.join(result.root,'.atelier-local/audience-decisions.json'),JSON.stringify(result.decisions,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify({repository:result.root,changed:result.changes.map(c=>c.file),next:'Rebuild the Atelier graph, then refresh the Dispatch snapshot.'},null,2));
  }
  else if(args.includes('--patch')) {
    let patch='*** Begin Patch\n';
    for(const change of result.changes) {
      const before=change.original.trimEnd().split('\n'), after=change.updated.trimEnd().split('\n');
      let shared=0;
      while(shared<before.length&&shared<after.length&&before[before.length-1-shared]===after[after.length-1-shared]) shared++;
      const context=shared?before.slice(before.length-shared,before.length-shared+1):[];
      patch+='*** Update File: '+path.join(result.root,change.file)+'\n@@\n'+before.slice(0,before.length-shared).map(line=>'-'+line).concat(after.slice(0,after.length-shared).map(line=>'+'+line),context.map(line=>' '+line)).join('\n')+'\n';
    }
    for(const [relative,data] of [['atelier.audience-policy.json',result.policy],['.atelier-local/audience-decisions.json',result.decisions]]) {
      const target=path.join(result.root,relative); const content=JSON.stringify(data,null,2);
      if(fs.existsSync(target)) patch+='*** Update File: '+target+'\n@@\n'+fs.readFileSync(target,'utf8').trimEnd().split('\n').map(l=>'-'+l).join('\n')+'\n'+content.split('\n').map(l=>'+'+l).join('\n')+'\n';
      else patch+='*** Add File: '+target+'\n'+content.split('\n').map(l=>'+'+l).join('\n')+'\n';
    }
    console.log(patch+'*** End Patch');
  } else console.log(JSON.stringify({repository:result.root,changed:result.changes.map(c=>c.file),decisions:result.decisions},null,2));
}

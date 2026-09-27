'use strict';
const fs=require('node:fs');
const path=require('node:path');
const cp=require('node:child_process');
const AUDIENCES=new Set(['private','team','public']);
function trackedGitFiles(root) {
  return cp.execFileSync('git',['--no-optional-locks','-C',root,'ls-files','-t','-z'],{encoding:'utf8',timeout:5000,maxBuffer:4*1024*1024})
    .split('\0').filter(Boolean)
    .filter(entry=>entry[0]!=='S')
    .map(entry=>entry.slice(2));
}
function classifyAudience({path:file='',text='',override,existing,previous}) {
  const giveawayCandidate=/giveaway|free[ -]?download|lead[ -]?magnet|freebie/i.test(file+' '+text);
  if(override!==undefined) {
    if(!AUDIENCES.has(override)) throw new Error('Invalid audience override for '+file);
    return {audience:override,reason:'manual-override',giveawayCandidate};
  }
  if(AUDIENCES.has(existing)&&existing!==previous) return {audience:existing,reason:'existing-explicit-label',giveawayCandidate};
  const sensitivePath=/(^|[\/._ -])(credentials?|secrets?|passwords?|tax-ids?|bank-accounts?|medical|health-records?|personnel|payroll|private)([\/._ -]|$)/i.test(file);
  const sensitiveText=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:password|api[_ -]?key|access[_ -]?token)\s*[:=]\s*["']?[a-zA-Z0-9_\-]{16,}|\b(?:confidential personnel|personal medical record|bank account number|social security number)\b/i.test(text);
  return {audience:sensitivePath||sensitiveText?'private':'team',reason:sensitivePath||sensitiveText?'sensitive-material':'team-default',giveawayCandidate};
}
function updateMarkdown(text,{slug,file,audience}) {
  const match=text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  let front=match?.[1]||'';
  const kg=front.match(/^kg:[ \t]*\r?\n((?:[ \t]+[^\n]*(?:\n|$)|\n)*)/m);
  if(kg) {
    let block=kg[0];
    if(/^\s+audience:/m.test(block)) block=block.replace(/^([ \t]+)audience:[^\n]*/m,'$1audience: '+audience);
    else block=block.trimEnd()+'\n  audience: '+audience+'\n';
    front=front.replace(kg[0],block);
  } else {
    if(/^kg:/m.test(front)) throw new Error('Inline kg metadata requires manual review: '+file);
    const id=slug+':'+file.replace(/\.(md|markdown|mdown)$/i,'').toLowerCase().replace(/[^a-z0-9]+/g,'-');
    front+=(front?'\n':'')+'kg:\n  id: '+id+'\n  type: document\n  status: active\n  audience: '+audience+'\n  relations: {}';
  }
  return '---\n'+front.trimEnd()+'\n---\n'+(match?text.slice(match[0].length):text);
}
function planAudiences(root) {
  root=fs.realpathSync(root);
  const project=JSON.parse(fs.readFileSync(path.join(root,'atelier.project.json'),'utf8'));
  const policyPath=path.join(root,'atelier.audience-policy.json');
  const policy=fs.existsSync(policyPath)?JSON.parse(fs.readFileSync(policyPath,'utf8')):{schema:'myos.atelier-audience-policy@v1',defaultAudience:'team',automaticPublic:false,overrides:{}};
  if(policy.overrides===undefined) policy.overrides={};
  if(!policy.overrides || typeof policy.overrides!=='object' || Array.isArray(policy.overrides)) throw new Error('Audience overrides must be a path-to-audience object');
  const statePath=path.join(root,'.atelier-local/audience-decisions.json');
  const previous=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):{};
  const files=trackedGitFiles(root).filter(f=>/\.(md|markdown|mdown|kg\.json)$/i.test(f)&&!/(^|\/)\.env/.test(f));
  const changes=[]; const decisions={};
  for(const file of files) {
    const full=path.join(root,file);
    if(fs.lstatSync(full).isSymbolicLink()) continue;
    if(!fs.realpathSync(full).startsWith(root+path.sep)) throw new Error('Source escapes repo: '+file);
    if(fs.statSync(full).size>4*1024*1024) throw new Error('Source too large: '+file);
    const text=fs.readFileSync(full,'utf8');
    const sidecar=file.endsWith('.kg.json')?JSON.parse(text):null;
    const existing=sidecar?.kg?.audience||text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1].match(/^\s+audience:\s*["']?(private|team|public)["']?\s*$/m)?.[1];
    const enrolled=sidecar?.summary==='Enrolled at adoption; not yet described.';
    const prior=previous[file];
    const decision=classifyAudience({path:file,text,existing,previous:prior?.reason==='existing-explicit-label'?undefined:(prior?.audience||(enrolled?'private':undefined)),override:policy.overrides[file]});
    decisions[file]=decision;
    let next;
    if(sidecar){sidecar.kg.audience=decision.audience;next=JSON.stringify(sidecar,null,2)+'\n';}
    else next=updateMarkdown(text,{slug:project.name,file,audience:decision.audience});
    if(next!==text) changes.push({file,original:text,updated:next});
  }
  return {root,policy,decisions,changes};
}
module.exports={classifyAudience,updateMarkdown,planAudiences};

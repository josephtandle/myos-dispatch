import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPair,SignJWT} from 'jose';
import {executeOnboarding,parseCommand,taskClass} from '../onboarding.mjs';
import {atomicJsonWrite} from '../onboarding-store.mjs';
import {execFileSync} from 'node:child_process';

process.env.CF_API_TOKEN='fake-provider-test-token';

test('plan defaults to dry-run and identifies maintenance work',()=>{
  assert.equal(taskClass,'maintenance');
  assert.deepEqual(parseCommand(['plan','--config','/private/config.json','--email','alice@example.com','--account-id','account_1','--app-id','app_1']),{
    command:'plan',configPath:'/private/config.json',email:'alice@example.com',accountId:'account_1',appId:'app_1',apply:false
  });
});

test('strict command parsing rejects unsafe operator input',()=>{
  const base=['plan','--config','/private/config.json','--email','alice@example.com','--account-id','account_1','--app-id','app_1'];
  assert.equal(parseCommand(base).apply,false);
  for(const argv of [
    [...base,'--unknown'],
    [...base.slice(0,4),'Alice@example.com',...base.slice(5)],
    ['enroll',...base.slice(1),'--projects','one','--all-team','--assertion-file','/private/assertion'],
    ['enroll',...base.slice(1),'--assertion-file','/private/assertion']
  ])assert.throws(()=>parseCommand(argv));
});

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'atelier-onboarding-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const configPath=path.join(root,'config.json'),registryPath=path.join(root,'registry.json'),policyPath=path.join(root,'grants.json');
  const config={enabled:true,authMode:'cloudflare-access',issuer:'https://example.cloudflareaccess.com',resource:'https://team.example/mcp',jwksUri:'https://example.cloudflareaccess.com/cdn-cgi/access/certs',applicationAudience:'a'.repeat(64),allowedEmails:['owner@example.com'],registryPath,policyPath};
  const registry={schema:'myos.atelier-portfolio@v1',brands:[{id:'brand'}],projects:[{id:'project',brandIds:['brand']}]};
  const policy={schema:'myos.atelier-grants@v1',grants:[{issuer:config.issuer,subject:'unrelated',projectId:'project',brandIds:['brand'],audiences:['team']} ]};
  for(const [file,value] of [[configPath,config],[registryPath,registry],[policyPath,policy]])await fs.writeFile(file,JSON.stringify(value),{mode:0o600});
  const provider={app:{domain:'team.example',aud:config.applicationAudience},policy:{id:'policy',decision:'allow',include:[{email:{email:'owner@example.com'}}],exclude:[],require:[]},writes:0};
  const fetchImpl=async(url,options={})=>{
    if(options.method==='PUT'){provider.writes++;provider.policy=JSON.parse(options.body);}
    const result=url.endsWith('/policies')? [provider.policy]:url.includes('/policies/')?provider.policy:provider.app;
    return new Response(JSON.stringify({success:true,result}),{status:200,headers:{'content-type':'application/json'}});
  };
  return {config,configPath,registryPath,policyPath,provider,fetchImpl};
}
const args=(command,configPath,email='alice@example.com')=>[command,'--config',configPath,'--email',email,'--account-id','account_1','--app-id','app_1'];

test('add dry-run leaves local and fake Cloudflare policy unchanged, apply is atomic and private',async t=>{
  const state=await fixture(t);const before=await fs.readFile(state.configPath,'utf8');
  const dry=await executeOnboarding(args('add',state.configPath),{fetchImpl:state.fetchImpl});
  assert.deepEqual(dry,{taskClass,command:'add',status:'pending',dryRun:true,addLocalEmail:true,addProviderEmail:true});
  assert.equal(await fs.readFile(state.configPath,'utf8'),before);assert.equal(state.provider.writes,0);
  const applied=await executeOnboarding([...args('add',state.configPath),'--apply'],{fetchImpl:state.fetchImpl});
  assert.equal(applied.restartRequired,true);assert.deepEqual(JSON.parse(await fs.readFile(state.configPath,'utf8')).allowedEmails,['owner@example.com','alice@example.com']);
  assert.equal(state.provider.policy.include[1].email.email,'alice@example.com');assert.equal((await fs.stat(applied.backup)).mode&0o077,0);
});

test('enrollment binds signed Cloudflare identity to exact team project and is idempotent',async t=>{
  const state=await fixture(t);const {publicKey,privateKey}=await generateKeyPair('RS256');
  await executeOnboarding([...args('add',state.configPath),'--apply'],{fetchImpl:state.fetchImpl});
  const assertion=await new SignJWT({type:'app',email:'alice@example.com'}).setProtectedHeader({alg:'RS256'}).setIssuer(state.config.issuer).setSubject('alice-subject').setAudience(state.config.applicationAudience).setExpirationTime('5m').sign(privateKey);
  const assertionPath=path.join(path.dirname(state.configPath),'assertion.jwt');await fs.writeFile(assertionPath,assertion,{mode:0o600});
  const command=[...args('enroll',state.configPath),'--projects','project','--assertion-file',assertionPath];
  const dry=await executeOnboarding(command,{key:publicKey});assert.equal(dry.addGrantCount,1);assert.equal(JSON.stringify(dry).includes(assertion),false);
  await executeOnboarding([...command,'--apply'],{key:publicKey});const repeated=await executeOnboarding([...command,'--apply'],{key:publicKey});
  const grants=JSON.parse(await fs.readFile(state.policyPath,'utf8')).grants;assert.equal(grants.length,2);assert.equal(repeated.addedGrantCount,0);assert.deepEqual(grants[1].audiences,['team']);
  await assert.rejects(()=>executeOnboarding([...args('enroll',state.configPath,'mallory@example.com'),'--projects','unknown','--assertion-file',assertionPath],{key:publicKey}),/unknown_project/);
});

test('plan accepts document-only projects from the current portfolio',async t=>{
  const state=await fixture(t);
  const registry=JSON.parse(await fs.readFile(state.registryPath,'utf8'));
  registry.projects.push({id:'docs-only',brandIds:[]});
  await fs.writeFile(state.registryPath,JSON.stringify(registry));
  const result=await executeOnboarding(args('plan',state.configPath));
  assert.equal(result.projectCount,2);
});

test('provider outage cannot prevent local grant revocation',async t=>{
  const state=await fixture(t);
  const policy=JSON.parse(await fs.readFile(state.policyPath,'utf8'));
  policy.grants.push({issuer:state.config.issuer,subject:'alice',projectId:'project',brandIds:['brand'],audiences:['team'],email:'alice@example.com',managedBy:'atelier-onboarding'});
  await fs.writeFile(state.policyPath,JSON.stringify(policy));
  const result=await executeOnboarding([...args('revoke',state.configPath),'--apply'],{fetchImpl:async()=>{throw new Error('offline');}});
  assert.equal(result.status,'partial');
  assert.equal(JSON.parse(await fs.readFile(state.policyPath,'utf8')).grants.some(g=>g.subject==='alice'),false);
  assert.equal(result.reconciliationRequired,1);
});

test('provider policy drift refuses overwrite and reports partial local change',async t=>{
  const state=await fixture(t);let calls=0;
  const fetchImpl=async(url,options)=>{
    if(url.endsWith('/policies')&&++calls===2)state.provider.policy.include.push({email:{email:'concurrent@example.com'}});
    return state.fetchImpl(url,options);
  };
  const result=await executeOnboarding([...args('add',state.configPath),'--apply'],{fetchImpl});
  assert.equal(result.status,'partial');assert.equal(result.error,'provider_state_drift');assert.equal(state.provider.writes,0);
});

test('workflow lock prevents overlapping apply and file CAS preserves newer state',async t=>{
  const state=await fixture(t);
  await fs.writeFile(state.configPath+'.workflow.lock','',{mode:0o600});
  await assert.rejects(()=>executeOnboarding([...args('revoke',state.configPath),'--apply'],{fetchImpl:state.fetchImpl}),/concurrent_state_drift/);
  await assert.rejects(()=>atomicJsonWrite(state.policyPath,'stale',{}),/concurrent_state_drift/);
  assert.equal(JSON.parse(await fs.readFile(state.policyPath,'utf8')).schema,'myos.atelier-grants@v1');
});

test('real CLI plan is read-only and private-file checks reject unsafe configs',async t=>{
  const state=await fixture(t);const before=await fs.readFile(state.configPath,'utf8');
  const output=execFileSync(process.execPath,['onboarding.mjs',...args('plan',state.configPath)],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
  assert.equal(JSON.parse(output).dryRun,true);assert.equal(await fs.readFile(state.configPath,'utf8'),before);
  await fs.chmod(state.configPath,0o644);
  await assert.rejects(()=>executeOnboarding(args('plan',state.configPath)),/private_file_required/);
});

test('mixed provider rules are rejected without access changes',async t=>{
  const state=await fixture(t);state.provider.policy.include[0].everyone={};
  await assert.rejects(()=>executeOnboarding([...args('add',state.configPath),'--apply'],{fetchImpl:state.fetchImpl}),/complex_provider_policy/);
  assert.equal(state.provider.writes,0);
});

test('expired, spoofed and mismatched employee assertions cannot write grants',async t=>{
  const state=await fixture(t);await executeOnboarding([...args('add',state.configPath),'--apply'],{fetchImpl:state.fetchImpl});
  const {publicKey,privateKey}=await generateKeyPair('RS256');const other=await generateKeyPair('RS256');
  const tokenPath=path.join(path.dirname(state.configPath),'token');
  const before=await fs.readFile(state.policyPath,'utf8');
  for(const [email,expiry,signingKey] of [['alice@example.com',1,privateKey],['owner@example.com',Math.floor(Date.now()/1000)+300,privateKey],['alice@example.com',Math.floor(Date.now()/1000)+300,other.privateKey]]){
    const token=await new SignJWT({type:'app',email}).setProtectedHeader({alg:'RS256'}).setIssuer(state.config.issuer).setSubject('subject').setAudience(state.config.applicationAudience).setExpirationTime(expiry).sign(signingKey);
    await fs.writeFile(tokenPath,token,{mode:0o600});
    await assert.rejects(()=>executeOnboarding([...args('enroll',state.configPath),'--projects','project','--assertion-file',tokenPath,'--apply'],{key:publicKey}));
    assert.equal(await fs.readFile(state.policyPath,'utf8'),before);
  }
});

test('duplicate existing grants are rejected rather than called idempotent',async t=>{
  const state=await fixture(t);await executeOnboarding([...args('add',state.configPath),'--apply'],{fetchImpl:state.fetchImpl});
  const {publicKey,privateKey}=await generateKeyPair('RS256');
  const token=await new SignJWT({type:'app',email:'alice@example.com'}).setProtectedHeader({alg:'RS256'}).setIssuer(state.config.issuer).setSubject('subject').setAudience(state.config.applicationAudience).setExpirationTime('5m').sign(privateKey);
  const tokenPath=path.join(path.dirname(state.configPath),'token');await fs.writeFile(tokenPath,token,{mode:0o600});
  const command=[...args('enroll',state.configPath),'--projects','project','--assertion-file',tokenPath,'--apply'];
  await executeOnboarding(command,{key:publicKey});
  const policy=JSON.parse(await fs.readFile(state.policyPath,'utf8'));policy.grants.push(policy.grants.at(-1));await fs.writeFile(state.policyPath,JSON.stringify(policy));
  await assert.rejects(()=>executeOnboarding(command,{key:publicKey}),/conflicting_subject_grant/);
});

test('revoke preserves unrelated and legacy grants while reporting reconciliation',async t=>{
  const state=await fixture(t);const policy=JSON.parse(await fs.readFile(state.policyPath,'utf8'));
  policy.grants.push({issuer:state.config.issuer,subject:'alice',projectId:'project',brandIds:['brand'],audiences:['team'],email:'alice@example.com',managedBy:'atelier-onboarding'},{issuer:state.config.issuer,subject:'legacy',projectId:'project',brandIds:['brand'],audiences:['team'],email:'alice@example.com'});
  await fs.writeFile(state.policyPath,JSON.stringify(policy),{mode:0o600});
  const config=JSON.parse(await fs.readFile(state.configPath,'utf8'));config.allowedEmails.push('alice@example.com');await fs.writeFile(state.configPath,JSON.stringify(config),{mode:0o600});state.provider.policy.include.push({email:{email:'alice@example.com'}});
  const result=await executeOnboarding([...args('revoke',state.configPath),'--apply'],{fetchImpl:state.fetchImpl});
  assert.equal(result.reconciliationRequired,2);const grants=JSON.parse(await fs.readFile(state.policyPath,'utf8')).grants;assert.equal(grants.length,2);assert.equal(grants.some(grant=>grant.subject==='unrelated'),true);assert.equal(grants.some(grant=>grant.subject==='legacy'),true);
});

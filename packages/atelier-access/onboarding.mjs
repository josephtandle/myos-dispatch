#!/usr/bin/env node
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {atomicJsonWrite,readPrivateJson,withWorkflowLock} from './onboarding-store.mjs';

export const taskClass='maintenance';
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;
const usage='Usage: onboarding.mjs <plan|add|enroll|revoke> --config FILE --email EMAIL --account-id ID --app-id ID [--apply] [--projects id,id|--all-team] [--assertion-file FILE]';
const fail=code=>{throw new Error(code);};
const unique=values=>[...new Set(values)];

export function parseCommand(argv) {
  if(argv.length===0||argv[0]==='help'||argv[0]==='--help')return {command:'help'};
  const [command,...rest]=argv;
  if(!['plan','add','enroll','revoke'].includes(command))fail('invalid_command');
  const values={command,apply:false};
  const known=new Set(['--config','--email','--account-id','--app-id','--assertion-file','--projects','--all-team','--apply']);
  for(let index=0;index<rest.length;index++) {
    const flag=rest[index];
    if(!known.has(flag))fail('unknown_flag');
    if(flag==='--apply'){if(values.apply)fail('duplicate_flag');values.apply=true;continue;}
    if(flag==='--all-team'){if(values.allTeam)fail('duplicate_flag');values.allTeam=true;continue;}
    const value=rest[++index];
    if(!value||value.startsWith('--'))fail('missing_flag_value');
    const rawName=flag.slice(2).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());
    const name=rawName==='config'?'configPath':rawName;
    if(name in values)fail('duplicate_flag');
    values[name]=value;
  }
  for(const name of ['configPath','email','accountId','appId'])if(!values[name])fail('required_'+name);
  if(!EMAIL.test(values.email)||values.email!==values.email.toLowerCase())fail('invalid_email');
  if(!ID.test(values.accountId)||!ID.test(values.appId))fail('invalid_cloudflare_id');
  if(values.projects&&values.allTeam)fail('conflicting_project_flags');
  if(command==='enroll'){
    if(!values.assertionFile)fail('required_assertionFile');
    if(!values.projects&&!values.allTeam)fail('required_projects');
  } else if(values.projects||values.allTeam||values.assertionFile)fail('flag_not_allowed');
  return values;
}

async function verifierFor(config,key) {
  const {createTokenVerifier}=await import('./auth.mjs');
  return createTokenVerifier(config,{key});
}
async function validateConfig(config) {
  if(config?.authMode!=='cloudflare-access'||config?.enabled!==true)fail('cloudflare_access_config_required');
  await verifierFor(config);
  if(new URL(config.resource).pathname!=='/mcp')fail('resource_endpoint_mismatch');
  return config;
}
function validateRegistry(registry) {
  if(registry?.schema!=='myos.atelier-portfolio@v1'||!Array.isArray(registry.projects)||!Array.isArray(registry.brands))fail('invalid_registry');
  const brandIds=new Set(registry.brands.map(brand=>brand?.id));
  const projects=new Map();
  for(const project of registry.projects){
    if(!project||!ID.test(project.id)||!Array.isArray(project.brandIds)||project.brandIds.some(id=>!brandIds.has(id)))fail('invalid_registry');
    if(projects.has(project.id))fail('invalid_registry');projects.set(project.id,project);
  }
  return projects;
}
function validateGrants(policy) {
  if(policy?.schema!=='myos.atelier-grants@v1'||!Array.isArray(policy.grants))fail('invalid_grants');
  return policy;
}
async function cf(fetchImpl,config,args,method,path,body) {
  const token=process.env.CF_API_TOKEN;
  if(!token)fail('cf_api_token_required');
  const response=await fetchImpl('https://api.cloudflare.com/client/v4/accounts/'+args.accountId+'/access/apps/'+args.appId+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});
  let payload;try{payload=await response.json();}catch{fail('provider_invalid_response');}
  if(!response.ok||payload?.success!==true)fail('provider_error');
  return payload.result;
}
function providerPolicy(policy) {
  const emailRules=policy?.include;
  if(!ID.test(policy?.id)||policy?.decision!=='allow'||!Array.isArray(emailRules)||emailRules.length===0||!emailRules.every(rule=>rule&&Object.keys(rule).length===1&&rule.email&&Object.keys(rule.email).length===1&&typeof rule.email.email==='string'&&EMAIL.test(rule.email.email)&&rule.email.email===rule.email.email.toLowerCase())||!Array.isArray(policy.exclude)||policy.exclude.length!==0||!Array.isArray(policy.require)||policy.require.length!==0)fail('complex_provider_policy');
  return policy;
}
async function inspectProvider(fetchImpl,config,args) {
  const app=await cf(fetchImpl,config,args,'GET','');
  if(app?.domain!==new URL(config.resource).host||app?.aud!==config.applicationAudience)fail('provider_app_mismatch');
  const policies=await cf(fetchImpl,config,args,'GET','/policies');
  if(!Array.isArray(policies)||policies.length!==1)fail('provider_policy_count');
  return {app,policy:providerPolicy(policies[0])};
}
function grantFor(identity,email,project) {
  return {issuer:identity.issuer,subject:identity.subject,projectId:project.id,brandIds:[...project.brandIds],audiences:['team'],email,managedBy:'atelier-onboarding'};
}
const sameGrant=(left,right)=>left.issuer===right.issuer&&left.subject===right.subject&&left.projectId===right.projectId&&left.email===right.email&&left.managedBy==='atelier-onboarding'&&JSON.stringify(left.brandIds)===JSON.stringify(right.brandIds)&&JSON.stringify(left.audiences)===JSON.stringify(right.audiences);
async function identityFromAssertion(config,args,key) {
  const {raw}=await readPrivateJson(args.assertionFile).catch(async error=>{
    if(error.message!=='invalid_json')throw error;
    return {raw:await fs.readFile(args.assertionFile,'utf8')};
  });
  const assertion=raw.trim();
  if(!assertion||assertion.startsWith('{'))fail('signed_assertion_required');
  const identity=await (await verifierFor(config,key))(undefined,assertion);
  if(identity.email!==args.email)fail('assertion_email_mismatch');
  return identity;
}
function pending(command,extra={}) {return {taskClass,command,status:'pending',dryRun:true,...extra};}

export async function executeOnboarding(argv,{fetchImpl=globalThis.fetch,key}={}) {
  const args=Array.isArray(argv)?parseCommand(argv):argv;
  if(args.command==='help')return {taskClass,usage};
  return withWorkflowLock(args.configPath,args.apply,()=>runOnboarding(args,{fetchImpl,key}));
}

async function runOnboarding(args,{fetchImpl,key}) {
  const configFile=await readPrivateJson(args.configPath);const config=await validateConfig(configFile.value);
  const registryFile=await readPrivateJson(config.registryPath);const projects=validateRegistry(registryFile.value);
  const grantsFile=await readPrivateJson(config.policyPath);const grants=validateGrants(grantsFile.value);
  if(args.command==='plan')return pending('plan',{projectCount:projects.size,grantCount:grants.grants.length,email:args.email});
  if(args.command==='enroll') {
    const requested=args.allTeam?[...projects.keys()]:unique(args.projects.split(','));
    if(requested.length===0||requested.some(id=>!ID.test(id)||!projects.has(id)))fail('unknown_project');
    const identity=await identityFromAssertion(config,args,key);
    const additions=[];
    for(const projectId of requested){
      const wanted=grantFor(identity,args.email,projects.get(projectId));
      const collisions=grants.grants.filter(grant=>grant.issuer===identity.issuer&&grant.subject===identity.subject&&grant.projectId===projectId);
      if(collisions.length>1||collisions.some(grant=>grant.disabled===true||grant.expiresAt||!sameGrant(grant,wanted)))fail('conflicting_subject_grant');
      const emailMatches=grants.grants.filter(grant=>grant.email===args.email&&grant.projectId===projectId);
      if(emailMatches.some(grant=>grant.issuer!==identity.issuer||grant.subject!==identity.subject))fail('conflicting_email_grant');
      if(!collisions.length)additions.push(wanted);
    }
    if(!args.apply)return pending('enroll',{projectIds:requested,addGrantCount:additions.length});
    if((await readPrivateJson(args.configPath)).raw!==configFile.raw||(await readPrivateJson(config.registryPath)).raw!==registryFile.raw)fail('concurrent_state_drift');
    const write=additions.length?await atomicJsonWrite(config.policyPath,grantsFile.raw,{...grants,grants:[...grants.grants,...additions]}):null;
    return {taskClass,command:'enroll',status:'applied',projectIds:requested,addedGrantCount:additions.length,backup:write?.backup};
  }
  const localEmails=config.allowedEmails;
  if(args.command==='add') {
    const provider=await inspectProvider(fetchImpl,config,args);
    const emails=provider.policy.include.map(rule=>rule.email.email);
    const nextEmails=unique([...localEmails,args.email]);const providerAdd=!emails.includes(args.email);const localAdd=!localEmails.includes(args.email);
    if(!args.apply)return pending('add',{addLocalEmail:localAdd,addProviderEmail:providerAdd});
    const configWrite=localAdd?await atomicJsonWrite(args.configPath,configFile.raw,{...config,allowedEmails:nextEmails}):null;
    try {if(providerAdd)await updateProvider(fetchImpl,config,args,provider,[...provider.policy.include,{email:{email:args.email}}]);}
    catch(error){return {taskClass,command:'add',status:'partial',restartRequired:localAdd,providerCleanup:'failed',backup:configWrite?.backup,error:error.message};}
    return {taskClass,command:'add',status:'applied',restartRequired:localAdd,backup:configWrite?.backup};
  }
  const managed=grants.grants.filter(grant=>grant.email===args.email&&grant.managedBy==='atelier-onboarding');
  const legacy=grants.grants.filter(grant=>!grant.email||(grant.email===args.email&&grant.managedBy!=='atelier-onboarding'));
  if(localEmails.length===1&&localEmails[0]===args.email)fail('last_email_removal_refused');
  const localRemove=localEmails.includes(args.email);
  if(!args.apply)return pending('revoke',{removeGrantCount:managed.length,removeLocalEmail:localRemove,providerCleanup:'not_checked',reconciliationRequired:legacy.length});
  const grantsWrite=managed.length?await atomicJsonWrite(config.policyPath,grantsFile.raw,{...grants,grants:grants.grants.filter(grant=>!managed.includes(grant))}):null;
  let configWrite;
  try {
    configWrite=localRemove?await atomicJsonWrite(args.configPath,configFile.raw,{...config,allowedEmails:localEmails.filter(email=>email!==args.email)}):null;
    const provider=await inspectProvider(fetchImpl,config,args);
    if(provider.policy.include.some(rule=>rule.email.email===args.email))await updateProvider(fetchImpl,config,args,provider,provider.policy.include.filter(rule=>rule.email.email!==args.email));
  }
  catch(error){return {taskClass,command:'revoke',status:'partial',restartRequired:localRemove,providerCleanup:'failed',reconciliationRequired:legacy.length,grantBackup:grantsWrite?.backup,configBackup:configWrite?.backup,error:error.message};}
  return {taskClass,command:'revoke',status:'applied',restartRequired:localRemove,reconciliationRequired:legacy.length,grantBackup:grantsWrite?.backup,configBackup:configWrite?.backup};
}

async function updateProvider(fetchImpl,config,args,before,include) {
  const fresh=await inspectProvider(fetchImpl,config,args);
  if(JSON.stringify(fresh)!==JSON.stringify(before))fail('provider_state_drift');
  if(include.length===0)fail('last_provider_email_removal_refused');
  await fs.writeFile(args.configPath+'.cloudflare-policy-'+randomUUID()+'.json',JSON.stringify({accountId:args.accountId,appId:args.appId,policy:before.policy},null,2)+'\n',{mode:0o600,flag:'wx'});
  await cf(fetchImpl,config,args,'PUT','/policies/'+before.policy.id,{...before.policy,include});
  const after=await inspectProvider(fetchImpl,config,args);
  if(JSON.stringify(after.policy.include)!==JSON.stringify(include))fail('provider_readback_mismatch');
}

async function main() {
  try {const result=await executeOnboarding(process.argv.slice(2));process.stdout.write(JSON.stringify(result)+'\n');if(result.status==='partial')process.exitCode=2;}
  catch(error){process.stderr.write(JSON.stringify({taskClass,status:'rejected',error:error.message})+'\n');process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main();

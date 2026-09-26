'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const DOCUMENT = /\.(md|markdown|mdown|html?|pdf|docx|kg\.json)$/i;
const SENSITIVE = /(^|\/)(\.env[^/]*|credentials?[^/]*|secrets?[^/]*|[^/]*\.pem|[^/]*\.key)(\/|$)/i;
function safePath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || SENSITIVE.test(relative)) return null;
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root + path.sep)) return null;
  try { if (!fs.realpathSync(resolved).startsWith(root + path.sep)) return null; } catch { return null; }
  return resolved;
}
function trackedFiles(root) {
  return cp.execFileSync('git',['--no-optional-locks','-C',root,'ls-files','-z'],{encoding:'utf8',timeout:5000,maxBuffer:4*1024*1024}).split('\0').filter(file=>(DOCUMENT.test(file)||['atelier.project.json','repo-access.v1.json','boundary-policy.v1.json','atelier.audience-policy.json'].includes(file)) && !SENSITIVE.test(file) && !/^(atelier-output|\.atelier-local)\//.test(file)).filter(file=>{
    // Match Atelier's regular-file census. Missing tracked files still fail fingerprinting.
    try { return !fs.lstatSync(path.join(root,file)).isSymbolicLink(); } catch { return true; }
  }).sort();
}
function fingerprints(root, files) {
  const result = {};
  for (const relative of files) {
    const file = safePath(root,relative);
    if (!file || fs.statSync(file).size > 50*1024*1024) throw new Error('source_unavailable');
    result[relative] = digest(fs.readFileSync(file));
  }
  return result;
}
function createSnapshot(root) {
  root=fs.realpathSync(root);
  const graphPath=safePath(root,'atelier-output/knowledge.graph.json');
  if (!graphPath) throw new Error('graph_missing');
  return {schema:'myos.atelier-snapshot@v1',graphHash:digest(fs.readFileSync(graphPath)),files:fingerprints(root,trackedFiles(root))};
}
function readAudience(text) {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const kg=front?.[1].match(/^kg:[ \t]*\n((?:[ \t]+[^\n]*(?:\n|$)|\n)*)/m);
  return kg?.[1].match(/^\s+audience:\s*["']?(private|team|public)["']?\s*$/m)?.[1] || 'private';
}
function validGraph(graph) {
  const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const text=value=>typeof value==='string'&&value.length>0;
  return record(graph)&&graph.schema==='mnstry.atelier-knowledge-graph@v1'&&Array.isArray(graph.errors)&&graph.errors.length===0&&Array.isArray(graph.nodes)&&graph.nodes.every(node=>record(node)&&text(node.id)&&text(node.path)&&['private','team','public'].includes(node.audience||'private')&&(!node.tags||Array.isArray(node.tags)&&node.tags.every(text))&&record(node.relations||{})&&Object.values(node.relations||{}).every(ids=>text(ids)||Array.isArray(ids)&&ids.every(text)));
}
function readAtelierSource(source, options = {}) {
  let root;
  try { root=fs.realpathSync(source.path); } catch { return {status:'unavailable',reason:'repository_missing',matches:[],negativeIsComplete:false}; }
  const audiences = new Set(source.audiences || ['private','team']);
  try {
    const accessPath=path.join(root,'repo-access.v1.json');
    if(fs.existsSync(accessPath)) {
      if(!safePath(root,'repo-access.v1.json')) throw new Error('invalid_boundary');
      const access=JSON.parse(fs.readFileSync(accessPath,'utf8'));
      const projectPath=safePath(root,'atelier.project.json');
      const name=projectPath?JSON.parse(fs.readFileSync(projectPath,'utf8')).name:undefined;
      const boundary=access.repos?.[name]?.readBoundary||access.defaultReadBoundary;
      if(!['private','team','public'].includes(boundary)||!audiences.has(boundary)) return {status:'unavailable',reason:'repository_boundary',matches:[],negativeIsComplete:false};
    }
  } catch { return {status:'unavailable',reason:'invalid_boundary',matches:[],negativeIsComplete:false}; }
  const includes=source.includePaths;
  if(includes!==undefined && (!Array.isArray(includes)||!includes.length||includes.some(p=>typeof p!=='string'||!p||path.isAbsolute(p)||p.split('/').includes('..')))) return {status:'unavailable',reason:'invalid_scope',matches:[],negativeIsComplete:false};
  const inScope=file=>!includes||includes.some(p=>p.endsWith('/')?file.startsWith(p):file===p);
  const tokens=String(options.query||'').toLowerCase().match(/[a-z0-9]{3,}/g)||[];
  let files=[]; let graph; let current; let reason='graph_missing';
  try {
    files=trackedFiles(root);
    const graphPath=safePath(root,'atelier-output/knowledge.graph.json');
    if (!graphPath) throw new Error('graph_missing');
    const bytes=fs.readFileSync(graphPath);
    graph=JSON.parse(bytes);
    if(!validGraph(graph)) throw new Error('graph_invalid');
    const snapshotPath=safePath(root,'.atelier-local/myos-dispatch-snapshot.json');
    if(!snapshotPath) throw new Error('snapshot_missing');
    const snapshot=JSON.parse(fs.readFileSync(snapshotPath,'utf8'));
    current=fingerprints(root,files);
    if(snapshot.schema!=='myos.atelier-snapshot@v1'||snapshot.graphHash!==digest(bytes)||Object.keys(snapshot.files||{}).length!==files.length||files.some(file=>snapshot.files[file]!==current[file])) throw new Error('graph_stale');
    reason=null;
  } catch(error) { reason=['graph_missing','graph_invalid','snapshot_missing','graph_stale','source_unavailable'].includes(error.message)?error.message:'graph_unavailable'; }
  const entries=[];
  if(!reason) {
    for(const node of graph.nodes) {
      const file=safePath(root,node.path);
      if(!file || !inScope(node.path) || !Object.hasOwn(current,node.path) || !audiences.has(node.audience||'private')) continue;
      let canonicalAudience='private';
      if(/\.(md|markdown|mdown)$/i.test(node.path)) {
        if(fs.statSync(file).size>4*1024*1024) continue;
        canonicalAudience=readAudience(fs.readFileSync(file,'utf8'));
      } else {
        const sidecar=safePath(root,node.path+'.kg.json');
        if(!sidecar || !Object.hasOwn(current,node.path+'.kg.json')) continue;
        try { canonicalAudience=JSON.parse(fs.readFileSync(sidecar,'utf8')).kg?.audience||'private'; } catch { continue; }
      }
      if(!audiences.has(canonicalAudience)) continue;
      // Single-repository adapter: explicit repo boundary can only restrict node audience.
      const boundary=node.repoAccess?.readBoundary;
      if(boundary && !audiences.has(boundary)) continue;
      const searchable=[node.title,node.summary,node.path,...(node.tags||[])].join(' ').toLowerCase();
      entries.push({id:String(node.id).slice(0,240),title:String(node.title||'').slice(0,240),audience:canonicalAudience,sourcePath:file,hash:current[node.path],relations:node.relations||{},summary:String(node.summary||'').slice(0,600),score:tokens.reduce((n,t)=>n+Number(searchable.includes(t)),0)});
    }
  } else {
    // Search current tracked Markdown only. Do not trust stale graph labels or relationships.
    for(const relative of files.filter(f=>inScope(f)&&/\.(md|markdown|mdown)$/i.test(f)).slice(0,1000)) {
      const file=safePath(root,relative);
      if(!file || fs.statSync(file).size>1024*1024) continue;
      const bytes=fs.readFileSync(file); const body=bytes.toString('utf8'); const audience=readAudience(body);
      if(!audiences.has(audience)) continue;
      const searchable=(relative+' '+body).toLowerCase();
      entries.push({id:relative,title:body.match(/^#\s+(.+)$/m)?.[1]||relative,audience,sourcePath:file,hash:digest(bytes),relations:{},summary:body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').slice(0,600),score:tokens.reduce((n,t)=>n+Number(searchable.includes(t)),0)});
    }
  }
  const limit=Math.max(1,Math.min(20,options.limit||8));
  const selected=entries.filter(e=>!tokens.length||e.score>0).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,limit);
  const related=new Set(selected.flatMap(e=>Object.values(e.relations).flat()));
  for(const entry of entries) if(related.has(entry.id)&&!selected.some(n=>n.id===entry.id)&&selected.length<limit) selected.push(entry);
  // Do not reveal relationship targets excluded by audience or missing source checks.
  const allowed=new Set(entries.map(e=>e.id));
  if(!reason) {
    try {
      const after=fingerprints(root,trackedFiles(root));
      if(JSON.stringify(after)!==JSON.stringify(current)) return {status:'unavailable',reason:'source_changed',matches:[],negativeIsComplete:false};
    } catch { return {status:'unavailable',reason:'source_changed',matches:[],negativeIsComplete:false}; }
  }
  return {status:reason?'fallback':'fresh',reason,repository:root,negativeIsComplete:false,matches:selected.map(({score,relations,...entry})=>({...entry,relations:Object.fromEntries(Object.entries(relations).map(([kind,ids])=>[kind,Array.isArray(ids)?ids.filter(id=>allowed.has(id)):(allowed.has(ids)?ids:null)]).filter(([,ids])=>ids!==null&&(!Array.isArray(ids)||ids.length)))}))};
}
module.exports={readAtelierSource,createSnapshot,validGraph,sourceManifest:root=>fingerprints(fs.realpathSync(root),trackedFiles(fs.realpathSync(root)))};

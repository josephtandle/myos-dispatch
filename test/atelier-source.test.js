const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const registry = require('../src/data-source-registry');
const {createSnapshot,readAtelierSource}=require('../src/atelier-source');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'atelier-source-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  cp.execFileSync('git',['init','-q',root]);
  fs.writeFileSync(path.join(root,'launch.md'),'---\nkg:\n  audience: team\n---\n# Launch\nOriginal launch plan.');
  fs.writeFileSync(path.join(root,'brief.md'),'---\nkg:\n  audience: team\n---\n# Partner brief\nDerived from launch plan.');
  cp.execFileSync('git',['-C',root,'add','launch.md','brief.md']);
  fs.mkdirSync(path.join(root,'atelier-output'));
  const graph = {schema:'mnstry.atelier-knowledge-graph@v1',nodes:[{id:'demo:launch',path:'launch.md',title:'Launch',audience:'team',relations:{belongs_to:'demo:brief'}},{id:'demo:brief',path:'brief.md',title:'Partner brief',audience:'team',relations:{}}],edges:[],errors:[]};
  const graphPath=path.join(root,'atelier-output/knowledge.graph.json');
  fs.writeFileSync(graphPath,JSON.stringify(graph));
  fs.mkdirSync(path.join(root,'.atelier-local'));
  const snapshot={schema:'myos.atelier-snapshot@v1',graphHash:hash(fs.readFileSync(graphPath)),files:Object.fromEntries(['launch.md','brief.md'].map(file=>[file,hash(fs.readFileSync(path.join(root,file)))]))};
  fs.writeFileSync(path.join(root,'.atelier-local/myos-dispatch-snapshot.json'),JSON.stringify(snapshot));
  const config={version:1,dataSources:[{id:'atelier-demo',mode:'atelier',path:root,matchTerms:['demo notes'],audiences:['team']}]};
  return {root,config,graph,graphPath};
}
test('Atelier registered sources retrieve a relevant node and related source citation',t=>{
  const {root,config}=fixture(t);
  assert.equal(registry.getDataSource('atelier-demo',{config}).mode,'atelier');
  const result=JSON.parse(registry.readConfiguredTextSource('atelier-demo',12000,{config,query:'launch'}));
  assert.equal(result.status,'fresh');
  assert.equal(result.matches[0].id,'demo:launch');
  assert.equal(result.matches[0].sourcePath,fs.realpathSync(path.join(root,'launch.md')));
  assert.ok(result.matches.some(n=>n.id==='demo:brief'));
  assert.equal(result.matches[0].hash.length,64);
});
test('source edits force current-file fallback and discard stale relationships',t=>{
  const {root,config}=fixture(t);
  fs.writeFileSync(path.join(root,'launch.md'),'---\nkg:\n  audience: team\n---\n# Launch\nRevised launch plan.');
  const result=JSON.parse(registry.readConfiguredTextSource('atelier-demo',12000,{config,query:'launch'}));
  assert.equal(result.status,'fallback');
  assert.equal(result.reason,'graph_stale');
  assert.deepEqual(result.matches[0].relations,{});
  assert.ok(result.matches.find(node=>node.id==='launch.md').summary.includes('Revised launch plan'));
});
test('missing graph searches tracked sources instead of returning a false complete negative',t=>{
  const {root,config,graphPath}=fixture(t);
  config.dataSources[0].audiences=['private','team'];
  fs.unlinkSync(graphPath);
  const result=JSON.parse(registry.readConfiguredTextSource('atelier-demo',12000,{config,query:'launch'}));
  assert.equal(result.status,'fallback');
  assert.equal(result.reason,'graph_missing');
  assert.ok(result.matches.length>0);
  assert.equal(result.negativeIsComplete,false);
});
test('new tracked source invalidates the snapshot',t=>{
  const {root,config}=fixture(t);
  fs.writeFileSync(path.join(root,'new.md'),'# New note');
  cp.execFileSync('git',['-C',root,'add','new.md']);
  const result=JSON.parse(registry.readConfiguredTextSource('atelier-demo',12000,{config}));
  assert.equal(result.reason,'graph_stale');
});
test('team retrieval excludes private nodes and their relationship identifiers',t=>{
  const {root,config,graph,graphPath}=fixture(t);
  graph.nodes[1].audience='private';
  fs.writeFileSync(graphPath,JSON.stringify(graph));
  const snapshotPath=path.join(root,'.atelier-local/myos-dispatch-snapshot.json');
  const snapshot=JSON.parse(fs.readFileSync(snapshotPath));
  snapshot.graphHash=hash(fs.readFileSync(graphPath));
  fs.writeFileSync(snapshotPath,JSON.stringify(snapshot));
  const result=JSON.parse(registry.readConfiguredTextSource('atelier-demo',12000,{config,query:'launch'}));
  assert.equal(result.status,'fresh');
  assert.equal(result.matches.length,1);
  assert.deepEqual(result.matches[0].relations,{});
});
test('canonical private labels cannot be weakened by graph metadata',t=>{
  const {root,config}=fixture(t);
  const file=path.join(root,'launch.md');
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('audience: team','audience: private'));
  const snapshotPath=path.join(root,'.atelier-local/myos-dispatch-snapshot.json');
  const snapshot=JSON.parse(fs.readFileSync(snapshotPath));
  snapshot.files['launch.md']=hash(fs.readFileSync(file));
  fs.writeFileSync(snapshotPath,JSON.stringify(snapshot));
  const result=JSON.parse(registry.readConfiguredTextSource('atelier-demo',12000,{config,query:'launch'}));
  assert.ok(!result.matches.some(n=>n.id==='demo:launch'));
});
test('Atelier context respects the callers character budget',t=>{
  const {config}=fixture(t);
  const output=registry.readConfiguredTextSource('atelier-demo',500,{config,query:'launch'});
  assert.ok(output.length<=500);
  assert.ok(Array.isArray(JSON.parse(output).matches));
});
test('Dispatch context builder selects and renders the optional Atelier source',t=>{
  const {config}=fixture(t);
  const context=require('../src/workspace-context');
  const sections=context.buildDataSections('demo notes launch',{dataSourceOptions:{config}});
  assert.equal(sections.length,1);
  const result=JSON.parse(sections[0].slice(sections[0].indexOf('\n')+1));
  assert.equal(result.status,'fresh');
  assert.ok(result.matches.some(node=>node.id==='demo:launch'));
});
test('path-scoped source omits sibling brand and relations in fresh and stale reads',t=>{
  const {root}=fixture(t);
  const {readAtelierSource}=require('../src/atelier-source');
  const source={path:root,audiences:['team'],includePaths:['launch.md']};
  const fresh=readAtelierSource(source);
  assert.deepEqual(fresh.matches.map(n=>n.id),['demo:launch']);
  assert.deepEqual(fresh.matches[0].relations,{});
  fs.appendFileSync(path.join(root,'launch.md'),'\nChanged');
  assert.deepEqual(readAtelierSource(source).matches.map(n=>n.id),['launch.md']);
});
test('malformed graph falls back without trusting malformed relations',t=>{
  const {root,graph,graphPath}=fixture(t);
  graph.nodes[0].relations={belongs_to:{bad:true}};
  fs.writeFileSync(graphPath,JSON.stringify(graph));
  const {createSnapshot,readAtelierSource}=require('../src/atelier-source');
  fs.writeFileSync(path.join(root,'.atelier-local/myos-dispatch-snapshot.json'),JSON.stringify(createSnapshot(root)));
  const result=readAtelierSource({path:root,audiences:['team']});
  assert.equal(result.reason,'graph_invalid');
  assert.ok(result.matches.every(n=>Object.keys(n.relations).length===0));
});
test('repository team boundary blocks a public-only caller including stale fallback',t=>{
  const {root,graph,graphPath}=fixture(t);
  for(const node of graph.nodes){node.audience='public';node.repoAccess={readBoundary:'team'};}
  for(const file of ['launch.md','brief.md'])fs.writeFileSync(path.join(root,file),fs.readFileSync(path.join(root,file),'utf8').replace('audience: team','audience: public'));
  fs.writeFileSync(graphPath,JSON.stringify(graph));
  fs.writeFileSync(path.join(root,'repo-access.v1.json'),JSON.stringify({defaultReadBoundary:'team',repos:{}}));
  cp.execFileSync('git',['-C',root,'add','repo-access.v1.json']);
  const {createSnapshot,readAtelierSource}=require('../src/atelier-source');
  fs.writeFileSync(path.join(root,'.atelier-local/myos-dispatch-snapshot.json'),JSON.stringify(createSnapshot(root)));
  assert.equal(readAtelierSource({path:root,audiences:['public']}).matches.length,0);
  fs.appendFileSync(path.join(root,'launch.md'),'\nchange');
  assert.equal(readAtelierSource({path:root,audiences:['public']}).matches.length,0);
});
test('registry preserves an explicit Atelier path scope',t=>{
  const {config}=fixture(t);
  config.dataSources[0].includePaths=['launch.md'];
  const result=JSON.parse(registry.readConfiguredTextSource('atelier-demo',12000,{config}));
  assert.deepEqual(result.matches.map(n=>n.id),['demo:launch']);
});
test('sparse checkout omits intentionally absent tracked siblings from the source census',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'atelier-source-sparse-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  cp.execFileSync('git',['init','-q',root]);
  fs.writeFileSync(path.join(root,'atelier.project.json'),JSON.stringify({name:'demo'}));
  fs.writeFileSync(path.join(root,'visible.md'),'---\nkg:\n  audience: team\n---\n# Visible\n');
  fs.writeFileSync(path.join(root,'excluded.md'),'---\nkg:\n  audience: team\n---\n# Excluded\n');
  cp.execFileSync('git',['-C',root,'add','.']);
  cp.execFileSync('git',['-C',root,'commit','-qm','fixture']);
  cp.execFileSync('git',['-C',root,'sparse-checkout','set','--no-cone','/*','!/excluded.md']);
  fs.mkdirSync(path.join(root,'atelier-output')); fs.mkdirSync(path.join(root,'.atelier-local'));
  const graph={schema:'mnstry.atelier-knowledge-graph@v1',nodes:[{id:'demo:visible',path:'visible.md',title:'Visible',audience:'team',relations:{}}],errors:[]};
  const graphPath=path.join(root,'atelier-output/knowledge.graph.json');
  fs.writeFileSync(graphPath,JSON.stringify(graph));
  const snapshot=createSnapshot(root);
  assert.deepEqual(Object.keys(snapshot.files).sort(),['atelier.project.json','visible.md']);
  fs.writeFileSync(path.join(root,'.atelier-local/myos-dispatch-snapshot.json'),JSON.stringify(snapshot));
  assert.equal(readAtelierSource({path:root,audiences:['team']}).status,'fresh');
});
test('missing non-sparse tracked source still fails fingerprinting',t=>{
  const {root}=fixture(t);
  fs.unlinkSync(path.join(root,'launch.md'));
  assert.throws(()=>createSnapshot(root),/source_unavailable/);
});
test('trusted source origin permits a fresh read while enrolled bytes remain unchanged',t=>{
  const {root,config}=fixture(t);
  const origin=fs.mkdtempSync(path.join(os.tmpdir(),'atelier-origin-'));
  t.after(()=>fs.rmSync(origin,{recursive:true,force:true}));
  const bytes=fs.readFileSync(path.join(root,'launch.md'));
  fs.writeFileSync(path.join(origin,'launch.md'),bytes);
  config.dataSources[0].sourceOrigin={path:fs.realpathSync(origin),files:{'launch.md':hash(bytes)}};
  const result=JSON.parse(registry.readConfiguredTextSource('atelier-demo',12000,{config,query:'launch'}));
  assert.equal(result.status,'fresh');
  assert.equal(result.matches[0].id,'demo:launch');
});
test('trusted source origin denies retrieval when an enrolled file changes or disappears',t=>{
  const {root,config}=fixture(t);
  const origin=fs.mkdtempSync(path.join(os.tmpdir(),'atelier-origin-'));
  t.after(()=>fs.rmSync(origin,{recursive:true,force:true}));
  const bytes=fs.readFileSync(path.join(root,'launch.md'));
  fs.writeFileSync(path.join(origin,'launch.md'),bytes);
  config.dataSources[0].sourceOrigin={path:fs.realpathSync(origin),files:{'launch.md':hash(bytes)}};
  fs.writeFileSync(path.join(origin,'launch.md'),'changed');
  let result=JSON.parse(registry.readConfiguredTextSource('atelier-demo',12000,{config,query:'launch'}));
  assert.deepEqual(result,{status:'unavailable',reason:'origin_changed',matches:[],negativeIsComplete:false});
  fs.unlinkSync(path.join(origin,'launch.md'));
  result=JSON.parse(registry.readConfiguredTextSource('atelier-demo',12000,{config,query:'launch'}));
  assert.deepEqual(result,{status:'unavailable',reason:'origin_changed',matches:[],negativeIsComplete:false});
});
test('invalid trusted source origin scopes deny retrieval without leaking outside paths',t=>{
  const {root,config}=fixture(t);
  const outside=path.join(path.dirname(root),'atelier-origin-outside.md');
  fs.writeFileSync(outside,'outside');
  t.after(()=>fs.rmSync(outside,{force:true}));
  config.dataSources[0].sourceOrigin={path:fs.realpathSync(root),files:{'../atelier-origin-outside.md':hash(Buffer.from('outside'))}};
  const result=JSON.parse(registry.readConfiguredTextSource('atelier-demo',12000,{config,query:'launch'}));
  assert.deepEqual(result,{status:'unavailable',reason:'origin_invalid',matches:[],negativeIsComplete:false});
});
test('trusted origin rejects symlinked parent directories, non-string hashes, and oversized files',t=>{
  const {root,config}=fixture(t);
  const origin=fs.mkdtempSync(path.join(os.tmpdir(),'atelier-origin-'));
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'atelier-origin-outside-'));
  t.after(()=>{fs.rmSync(origin,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});});
  fs.writeFileSync(path.join(outside,'launch.md'),'outside');
  fs.symlinkSync(outside,path.join(origin,'linked'));
  config.dataSources[0].sourceOrigin={path:fs.realpathSync(origin),files:{'linked/launch.md':hash(Buffer.from('outside'))}};
  let result=JSON.parse(registry.readConfiguredTextSource('atelier-demo',12000,{config,query:'launch'}));
  assert.equal(result.reason,'origin_invalid');
  config.dataSources[0].sourceOrigin={path:fs.realpathSync(origin),files:{'launch.md':123}};
  result=JSON.parse(registry.readConfiguredTextSource('atelier-demo',12000,{config,query:'launch'}));
  assert.equal(result.reason,'origin_invalid');
  fs.writeFileSync(path.join(origin,'large.md'),Buffer.alloc(50*1024*1024+1));
  config.dataSources[0].sourceOrigin={path:fs.realpathSync(origin),files:{'large.md':hash(fs.readFileSync(path.join(origin,'large.md')))}};
  result=JSON.parse(registry.readConfiguredTextSource('atelier-demo',12000,{config,query:'launch'}));
  assert.equal(result.reason,'origin_invalid');
});
test('trusted origin read failures become origin_changed',t=>{
  const {root,config}=fixture(t);
  const origin=fs.mkdtempSync(path.join(os.tmpdir(),'atelier-origin-'));
  t.after(()=>fs.rmSync(origin,{recursive:true,force:true}));
  const bytes=fs.readFileSync(path.join(root,'launch.md'));
  const originRoot=fs.realpathSync(origin);
  const originFile=path.join(originRoot,'launch.md');
  fs.writeFileSync(originFile,bytes);
  config.dataSources[0].sourceOrigin={path:originRoot,files:{'launch.md':hash(bytes)}};
  const readFileSync=fs.readFileSync;
  t.mock.method(fs,'readFileSync',(file,...args)=>{
    if (file===originFile) { const error=new Error('permission denied'); error.code='EACCES'; throw error; }
    return readFileSync(file,...args);
  });
  const result=JSON.parse(registry.readConfiguredTextSource('atelier-demo',12000,{config,query:'launch'}));
  assert.deepEqual(result,{status:'unavailable',reason:'origin_changed',matches:[],negativeIsComplete:false});
});

const test=require('node:test');
const assert=require('node:assert/strict');
const {classifyAudience:classify,updateMarkdown}=require('../src/atelier-audience');
test('ordinary project material defaults to team',()=>assert.equal(classify({path:'notes/plan.md',text:'Launch plan'}).audience,'team'));
test('specific sensitive material is private',()=>assert.equal(classify({path:'personnel/payroll.md',text:'Staff amounts'}).audience,'private'));
test('giveaway is a candidate and stays team automatically',()=>assert.deepEqual(classify({path:'giveaways/ebook.md'}),{audience:'team',reason:'team-default',giveawayCandidate:true}));
test('explicit public override is honored without another approval gate',()=>assert.equal(classify({path:'giveaways/ebook.md',override:'public'}).audience,'public'));
test('manual private and existing explicit labels survive reruns',()=>{
  assert.equal(classify({path:'launch.md',override:'private',previous:'team'}).audience,'private');
  assert.equal(classify({path:'launch.md',existing:'public',previous:'team'}).audience,'public');
});
test('frontmatter update preserves existing fields and is idempotent',()=>{
  const text='---\nname: agent\nkg:\n  id: demo:agent\n  audience: private\n  relations: {}\n---\nOriginal body\n';
  const next=updateMarkdown(text,{slug:'demo',file:'agent.md',audience:'team'});
  assert.ok(next.includes('name: agent'));
  assert.ok(next.endsWith('Original body\n'));
  assert.equal(updateMarkdown(next,{slug:'demo',file:'agent.md',audience:'team'}),next);
});
test('policy without overrides is accepted and invalid override shapes are rejected',t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'atelier-audience-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  cp.execFileSync('git',['init','-q',root]);
  fs.writeFileSync(path.join(root,'atelier.project.json'),JSON.stringify({name:'demo'}));
  fs.writeFileSync(path.join(root,'README.md'),'# Demo\n');
  cp.execFileSync('git',['-C',root,'add','README.md']);
  fs.writeFileSync(path.join(root,'atelier.audience-policy.json'),JSON.stringify({defaultAudience:'team'}));
  const {planAudiences}=require('../src/atelier-audience');
  assert.equal(planAudiences(root).decisions['README.md'].audience,'team');
  fs.writeFileSync(path.join(root,'atelier.audience-policy.json'),JSON.stringify({overrides:[]}));
  assert.throws(()=>planAudiences(root),/Audience overrides/);
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {selectModels} = require("../src/runtime/oauth-registry");
const {executeClaudeText} = require("../src/runtime/oauth-claude");

test("Claude selection admits only authenticated, previously invoked exact Sonnet for bounded classes", () => {
  const entry={provider:"claude",model:"claude-sonnet-5",visible:true,auth:"subscription",observedAt:new Date().toISOString(),invokedAt:new Date().toISOString()};
  assert.equal(selectModels({models:[entry]},{provider:"claude",taskClass:"planning"})[0]?.model,"claude-sonnet-5");
  assert.deepEqual(selectModels({models:[{...entry,invokedAt:null}]},{provider:"claude",taskClass:"planning"}),[]);
  assert.deepEqual(selectModels({models:[entry]},{provider:"claude",taskClass:"audio_diarization"}),[]);
});

test("Claude transport uses subscription auth, exact identity and no tool or Desktop credentials", async () => {
  const calls=[];
  const result=await executeClaudeText({model:"claude-sonnet-5",prompt:"fixture",responseMode:"json",timeoutMs:10000,maxOutputTokens:512},{
    env:{PATH:process.env.PATH,HOME:process.env.HOME,ANTHROPIC_API_KEY:"secret",ANTHROPIC_BASE_URL:"https://invalid",CLAUDE_CODE_MESSAGING_TOKEN:"secret",CLAUDECODE:"1"},
    runCommand:async request=>{calls.push(request);return {code:0,stdout:JSON.stringify(calls.length===1?{loggedIn:true,authMethod:"claude.ai"}:{result:'{"value":42}',modelUsage:{"claude-sonnet-5":{}},usage:{input_tokens:4,output_tokens:2}})};},
  });
  assert.equal(result.json.value,42);
  assert.equal(calls.length,2);
  assert.equal(calls[1].env.ANTHROPIC_API_KEY,undefined);
  assert.equal(calls[1].env.ANTHROPIC_BASE_URL,undefined);
  assert.equal(calls[1].env.CLAUDE_CODE_MESSAGING_TOKEN,undefined);
  assert.equal(calls[1].args[calls[1].args.indexOf("--tools")+1],"");
  assert.equal(JSON.parse(calls[1].args[calls[1].args.indexOf("--settings")+1]).forceLoginMethod,"claudeai");
  assert.ok(calls[1].timeoutMs<=10000);
  assert.equal(calls[1].env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,"512");
});

test("Claude text refuses grounding and multimodal content rather than dropping it",async()=>{
  for(const extra of [{searchGrounding:true},{images:["fixture"]},{attachments:["fixture"]},{messages:[{role:"user",content:[{type:"image_url",image_url:{url:"fixture"}}]}]}]){
    let called=false;
    await assert.rejects(executeClaudeText({model:"claude-sonnet-5",prompt:"fixture",...extra},{runCommand:async()=>{called=true;return {code:0,stdout:'{}'};}}),/text-only/);
    assert.equal(called,false);
  }
});

test("Claude transport fails closed for API auth, malformed output, provider errors and identity mismatch",async()=>{
  for(const scenario of ["api","malformed","error","mismatch"]){
    let calls=0;
    await assert.rejects(executeClaudeText({model:"claude-sonnet-5",prompt:"fixture"},{env:{},runCommand:async()=>{
      calls++;
      if(calls===1)return {code:0,stdout:JSON.stringify({loggedIn:true,authMethod:scenario==="api"?"api_key":"claude.ai"})};
      return {code:0,stdout:scenario==="malformed"?"broken":JSON.stringify({result:"fixture",is_error:scenario==="error",modelUsage:{[scenario==="mismatch"?"claude-other":"claude-sonnet-5"]:{}}})};
    }}));
    assert.equal(calls,scenario==="api"?1:2);
  }
});

test("Claude text refuses object-form tool requests before spawning",async()=>{
  let calls=0;
  await assert.rejects(executeClaudeText({model:"claude-sonnet-5",prompt:"fixture",tools:{type:"function"}},{runCommand:async()=>{calls++;return {code:0,stdout:'{}'};}}),/does not support tools/);
  assert.equal(calls,0);
});

test("Claude usage includes cached input rather than hiding most consumed context",async()=>{
  let calls=0;
  const result=await executeClaudeText({model:"claude-sonnet-5",prompt:"fixture"},{env:{},runCommand:async()=>({code:0,stdout:JSON.stringify(++calls===1?{loggedIn:true,authMethod:"claude.ai"}:{result:"42",modelUsage:{"claude-sonnet-5":{}},usage:{input_tokens:2,cache_read_input_tokens:100,cache_creation_input_tokens:20,output_tokens:3}})})});
  assert.equal(result.usage.inputTokens,122);
  assert.equal(result.usage.outputTokens,3);
});

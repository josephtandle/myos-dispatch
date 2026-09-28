import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,SignJWT} from 'jose';
import {createTokenVerifier} from '../auth.mjs';
import {createAccessServer} from '../server.mjs';
import {once} from 'node:events';

const config={authMode:'cloudflare-access',issuer:'https://example.cloudflareaccess.com',resource:'https://team.example/mcp',jwksUri:'https://example.cloudflareaccess.com/cdn-cgi/access/certs',applicationAudience:'a'.repeat(64),allowedEmails:['alice@example.com']};
test('Cloudflare mode validates the signed application assertion, not the opaque bearer',async()=>{
  const {publicKey,privateKey}=await generateKeyPair('RS256');
  const token=await new SignJWT({type:'app',email:'alice@example.com'}).setProtectedHeader({alg:'RS256'}).setIssuer(config.issuer).setSubject('stable-alice-id').setAudience(config.applicationAudience).setExpirationTime('5m').sign(privateKey);
  const principal=await createTokenVerifier(config,{key:publicKey})('Bearer oauth:opaque',token);
  assert.deepEqual(principal,{issuer:config.issuer,subject:'stable-alice-id',email:'alice@example.com'});
});

test('HTTP Cloudflare enrollment returns only verified identity and denies a bearer-only bypass',async t=>{
  const {publicKey,privateKey}=await generateKeyPair('RS256');
  const token=await new SignJWT({type:'app',email:'alice@example.com'}).setProtectedHeader({alg:'RS256'}).setIssuer(config.issuer).setSubject('stable-alice-id').setAudience(config.applicationAudience).setExpirationTime('5m').sign(privateKey);
  const server=createAccessServer({...config,enabled:true},{key:publicKey});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const base='http://127.0.0.1:'+server.address().port;
  const response=await fetch(base+'/api/identity',{headers:{'cf-access-jwt-assertion':token}});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{issuer:config.issuer,subject:'stable-alice-id',email:'alice@example.com'});
  assert.equal((await fetch(base+'/api/identity',{headers:{authorization:'Bearer '+token}})).status,401);
});

test('Cloudflare assertions reject spoofing, other identities and invalid claims without bearer fallback',async()=>{
  const {publicKey,privateKey}=await generateKeyPair('RS256');
  const other=await generateKeyPair('RS256');
  const verify=createTokenVerifier(config,{key:publicKey});
  const claims={iss:config.issuer,aud:config.applicationAudience,sub:'stable-alice-id',type:'app',email:'alice@example.com',exp:Math.floor(Date.now()/1000)+300};
  const sign=(payload,key=privateKey)=>new SignJWT(payload).setProtectedHeader({alg:'RS256'}).sign(key);
  for(const change of [{iss:'https://other.cloudflareaccess.com'},{aud:config.resource},{aud:'b'.repeat(64)},{sub:''},{exp:1},{type:'service'},{email:'mallory@example.com'},{email:undefined}]){
    await assert.rejects(()=>sign({...claims,...change}).then(token=>verify('Bearer oauth:opaque',token)));
  }
  await assert.rejects(()=>sign(claims,other.privateKey).then(token=>verify(undefined,token)));
  const token=await sign(claims);
  for(const assertion of [undefined,'',token+','+token,[token,token]])await assert.rejects(()=>verify('Bearer '+token,assertion));
  await assert.rejects(()=>createTokenVerifier({...config,authMode:'bearer'},{key:publicKey})(undefined,token));
});

test('Cloudflare configuration cannot fall back to a different mode or signing-key origin',()=>{
  for(const change of [{authMode:'typo'},{applicationAudience:config.resource},{jwksUri:'https://evil.example/keys'},{issuer:'https://example.cloudflareaccess.com/path'},{allowedEmails:[]},{allowedEmails:['*']}]){
    assert.throws(()=>createTokenVerifier({...config,...change}));
  }
});

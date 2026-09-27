import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,SignJWT} from 'jose';
import {createTokenVerifier} from '../auth.mjs';
const config={issuer:'https://identity.example',resource:'https://atelier.example/mcp',jwksUri:'https://identity.example/.well-known/jwks.json'};
test('JWT verification binds issuer subject audience expiry and scope',async()=>{
  const {publicKey,privateKey}=await generateKeyPair('RS256');
  const token=await new SignJWT({scope:'atelier:read'}).setProtectedHeader({alg:'RS256'}).setIssuer(config.issuer).setSubject('alice').setAudience(config.resource).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const verify=createTokenVerifier(config,{key:publicKey});
  assert.deepEqual(await verify('Bearer '+token),{issuer:config.issuer,subject:'alice'});
});
test('tokens with wrong signature issuer audience expiry or scope cannot authenticate',async()=>{
  const {publicKey,privateKey}=await generateKeyPair('RS256');
  const other=await generateKeyPair('RS256');
  const verify=createTokenVerifier(config,{key:publicKey});
  for(const change of [{iss:'https://other.example'},{aud:'https://other.example/mcp'},{scope:'other:read'},{exp:1},{sub:''}]) {
    const token=await new SignJWT({iss:config.issuer,aud:config.resource,sub:'alice',scope:'atelier:read',exp:Math.floor(Date.now()/1000)+300,...change}).setProtectedHeader({alg:'RS256'}).sign(privateKey);
    await assert.rejects(()=>verify('Bearer '+token));
  }
  const token=await new SignJWT({scope:'atelier:read'}).setProtectedHeader({alg:'RS256'}).setIssuer(config.issuer).setSubject('alice').setAudience(config.resource).setExpirationTime('5m').sign(other.privateKey);
  await assert.rejects(()=>verify('Bearer '+token));
  await assert.rejects(()=>verify(undefined));
});

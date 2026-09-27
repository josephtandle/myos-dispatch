import {createRemoteJWKSet,jwtVerify} from 'jose';

export function createTokenVerifier(config,{key}={}) {
  for(const value of [config.issuer,config.resource,config.jwksUri]) {
    const url=new URL(value);
    if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search)throw new Error('HTTPS identity and resource URLs are required');
  }
  const resolver=key||createRemoteJWKSet(new URL(config.jwksUri),{timeoutDuration:5000,cooldownDuration:30000});
  return async authorization=>{
    if(typeof authorization!=='string'||authorization.length>16384||!authorization.startsWith('Bearer '))throw new Error('invalid_token');
    const {payload}=await jwtVerify(authorization.slice(7),resolver,{issuer:config.issuer,audience:config.resource,algorithms:['RS256','ES256'],requiredClaims:['exp','sub','iss','aud']});
    if(typeof payload.sub!=='string'||!payload.sub.trim()||typeof payload.scope!=='string'||!payload.scope.split(' ').includes('atelier:read'))throw new Error('insufficient_scope');
    return {issuer:payload.iss,subject:payload.sub};
  };
}

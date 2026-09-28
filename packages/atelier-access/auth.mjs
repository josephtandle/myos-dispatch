import {createRemoteJWKSet,jwtVerify} from 'jose';

export function createTokenVerifier(config,{key}={}) {
  const mode=config.authMode||'bearer';
  if(!['bearer','cloudflare-access'].includes(mode))throw new Error('invalid_auth_mode');
  const cloudflare=mode==='cloudflare-access';
  for(const value of [config.issuer,config.resource,config.jwksUri]) {
    const url=new URL(value);
    if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search)throw new Error('HTTPS identity and resource URLs are required');
  }
  if(cloudflare){
    if(!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(config.issuer)||config.jwksUri!==config.issuer+'/cdn-cgi/access/certs'||!/^[a-f0-9]{64}$/.test(config.applicationAudience))throw new Error('invalid_cloudflare_identity');
    if(!Array.isArray(config.allowedEmails)||config.allowedEmails.length===0||config.allowedEmails.some(email=>typeof email!=='string'||email!==email.toLowerCase()||!/^\S+@\S+\.\S+$/.test(email)))throw new Error('invalid_cloudflare_allowlist');
  }
  const resolver=key||createRemoteJWKSet(new URL(config.jwksUri),{timeoutDuration:5000,cooldownDuration:30000});
  return async (authorization,assertion)=>{
    const token=cloudflare?assertion:typeof authorization==='string'&&authorization.startsWith('Bearer ')?authorization.slice(7):null;
    if(typeof token!=='string'||!token||token.length>16384)throw new Error('invalid_token');
    const {payload}=await jwtVerify(token,resolver,{issuer:config.issuer,audience:cloudflare?config.applicationAudience:config.resource,algorithms:cloudflare?['RS256']:['RS256','ES256'],requiredClaims:['exp','sub','iss','aud']});
    if(typeof payload.sub!=='string'||!payload.sub.trim())throw new Error('invalid_subject');
    if(cloudflare){
      if(payload.type!=='app'||typeof payload.email!=='string'||!config.allowedEmails.includes(payload.email.toLowerCase()))throw new Error('identity_not_allowed');
      return {issuer:payload.iss,subject:payload.sub,email:payload.email.toLowerCase()};
    }
    if(typeof payload.scope!=='string'||!payload.scope.split(' ').includes('atelier:read'))throw new Error('insufficient_scope');
    return {issuer:payload.iss,subject:payload.sub};
  };
}

#!/usr/bin/env node
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { importJWK } from 'jose';
import { createTokenVerifier } from './auth.mjs';

const MAX_BODY = 256 * 1024;
function strictUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? url : null; } catch { return null; }
}
function urlError(name, value) { return typeof value === 'string' && value.startsWith('http:') ? `config.${name}_https` : `config.${name}_url`; }
const code = (report, value) => { if (!report.errors.includes(value)) report.errors.push(value); };

function localFile(report, name, file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return code(report, `file.${name}_symlink`);
    if (!stat.isFile()) return code(report, `file.${name}_regular`);
    if ((stat.mode & 0o077) !== 0) return code(report, `file.${name}_private`);
    return true;
  } catch { code(report, `file.${name}_readable`); return false; }
}

function parseLocal(report, name, file, schema) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || value.schema !== schema) throw new Error('schema');
    if (name === 'registry' && (!Array.isArray(value.brands) || !Array.isArray(value.projects) || !value.sources || typeof value.sources !== 'object')) throw new Error('schema');
    if (name === 'policy' && !Array.isArray(value.grants)) throw new Error('schema');
    return value;
  } catch { code(report, `schema.${name}_invalid`); return null; }
}

async function json(fetchImpl, url, report, failure, addError = true) {
  try {
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) { if (addError) code(report, failure); return null; }
    let text = '';
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      for (;;) { const part = await reader.read(); if (part.done) break; text += Buffer.from(part.value).toString(); if (Buffer.byteLength(text) > MAX_BODY) { await reader.cancel(); if (addError) code(report, `${failure}_size`); return null; } }
    } else text = await response.text();
    if (Buffer.byteLength(text) > MAX_BODY) { if (addError) code(report, `${failure}_size`); return null; }
    return JSON.parse(text);
  } catch { if (addError) code(report, failure); return null; }
}

function endpoint(value, origin) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === origin; } catch { return false; }
}

async function providerChecks(config, report, fetchImpl) {
  const cloudflare=config.authMode==='cloudflare-access';
  const authorizationIssuer=config.issuer;
  const issuer = strictUrl(authorizationIssuer);
  const suffix = issuer.pathname === '/' ? '' : issuer.pathname.replace(/\/$/, '');
  const candidates = cloudflare?[new URL('/.well-known/oauth-authorization-server',new URL(config.resource).origin)]:[new URL(`${suffix}/.well-known/openid-configuration`, issuer.origin), new URL(`/.well-known/oauth-authorization-server${suffix}`, issuer.origin)];
  let metadata = null;
  for (const candidate of candidates) {
    metadata = await json(fetchImpl, candidate, report, 'metadata.unavailable', false);
    if (metadata) break;
  }
  if (!metadata) code(report, 'metadata.unavailable');
  if (metadata) {
    const valid = metadata.issuer === authorizationIssuer && (cloudflare||metadata.jwks_uri === config.jwksUri) &&
      Array.isArray(metadata.response_types_supported) && metadata.response_types_supported.includes('code') &&
      (!metadata.grant_types_supported || (Array.isArray(metadata.grant_types_supported) && metadata.grant_types_supported.includes('authorization_code'))) &&
      Array.isArray(metadata.code_challenge_methods_supported) && metadata.code_challenge_methods_supported.includes('S256') &&
      endpoint(metadata.authorization_endpoint, issuer.origin) && endpoint(metadata.token_endpoint, issuer.origin);
    if (!valid) code(report, 'metadata.contract'); else report.checks.oauthMetadata = true;
  }
  const jwks = await json(fetchImpl, config.jwksUri, report, 'jwks.unavailable');
  if (jwks && Array.isArray(jwks.keys) && (await Promise.all(jwks.keys.map(async key => {
    if (!key || typeof key !== 'object') return false;
    const alg = key.alg || (key.kty === 'RSA' ? 'RS256' : key.kty === 'EC' && key.crv === 'P-256' ? 'ES256' : null);
    if (!alg || (alg !== 'RS256' && alg !== 'ES256') || (key.use !== undefined && key.use !== 'sig') || (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || !key.key_ops.includes('verify'))) || ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'].some(part => part in key)) return false;
    try { await importJWK(key, alg); return true; } catch { return false; }
  }))).some(Boolean)) report.checks.jwks = true;
  else if (jwks) code(report, 'jwks.signing_key');
  const resource = strictUrl(config.resource);
  if (!resource) { code(report, 'config.resource_url'); return; }
  const resourceMetadata = await json(fetchImpl, new URL('/.well-known/oauth-protected-resource/mcp', resource.origin), report, 'resource_metadata.unavailable');
  if (resourceMetadata && resourceMetadata.resource === config.resource && Array.isArray(resourceMetadata.authorization_servers) && resourceMetadata.authorization_servers.includes(authorizationIssuer)) report.checks.resourceMetadata = true;
  else if (resourceMetadata) code(report, 'resource_metadata.contract');
}

export async function inspectConfig(config, { fetchImpl = globalThis.fetch } = {}) {
  const report = { enabled: config?.enabled === true, ready: false, errors: [], checks: { localFiles: false, oauthMetadata: false, jwks: false, resourceMetadata: false }, clientRegistrationRequired: true, grantCount: 0, deploymentVerified: false, loginVerified: false };
  for (const [name, value] of [['issuer', config?.issuer], ['resource', config?.resource], ['jwksUri', config?.jwksUri]]) if (!strictUrl(value)) code(report, urlError(name, value));
  if(config?.authMode!==undefined){try{createTokenVerifier(config);}catch{code(report,'config.auth_mode_contract');}}
  if (config?.resource !== undefined && !strictUrl(config.resource)) code(report, 'config.resource_https');
  try { if (config?.resource !== undefined && strictUrl(config.resource)?.pathname !== '/mcp') code(report, 'config.resource_path'); } catch { code(report, 'config.resource_url'); }
  if (!report.enabled && !config?.registryPath && !config?.policyPath) return report;
  const files = [['registry', config.registryPath, 'myos.atelier-portfolio@v1'], ['policy', config.policyPath, 'myos.atelier-grants@v1']];
  const okay = files.every(([name, file]) => localFile(report, name, file));
  const registry = okay && parseLocal(report, 'registry', config.registryPath, files[0][2]);
  const policy = okay && parseLocal(report, 'policy', config.policyPath, files[1][2]);
  if (registry && policy) { report.checks.localFiles = true; report.grantCount = policy.grants.length; }
  if (report.enabled && report.errors.length === 0) await providerChecks(config, report, fetchImpl);
  return report;
}

async function main() {
  const file = process.argv[2];
  let config = { enabled: false };
  if (file) {
    let raw;
    try { raw = await readFile(file, 'utf8'); } catch { process.stdout.write(JSON.stringify({ enabled: false, ready: false, errors: ['config.unreadable'] }) + '\n'); process.exitCode = 1; return; }
    try { config = JSON.parse(raw); } catch { process.stdout.write(JSON.stringify({ enabled: false, ready: false, errors: ['config.invalid_json'] }) + '\n'); process.exitCode = 1; return; }
  }
  process.stdout.write(`${JSON.stringify(await inspectConfig(config))}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(() => { process.stdout.write(JSON.stringify({ enabled: false, ready: false, errors: ['config.unreadable'] }) + '\n'); process.exitCode = 1; });

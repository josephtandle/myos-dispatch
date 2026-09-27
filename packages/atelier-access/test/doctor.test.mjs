import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { inspectConfig } from '../doctor.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-doctor-'));
  const portfolio = { schema: 'myos.atelier-portfolio@v1', sources: {}, brands: [], projects: [] };
  const grants = { schema: 'myos.atelier-grants@v1', grants: [] };
  const registryPath = path.join(root, 'portfolio.json');
  const policyPath = path.join(root, 'grants.json');
  fs.writeFileSync(registryPath, JSON.stringify(portfolio), { mode: 0o600 });
  fs.writeFileSync(policyPath, JSON.stringify(grants), { mode: 0o600 });
  return { root, registryPath, policyPath };
}

test('disabled config is safe and never claims readiness', async () => {
  const report = await inspectConfig({ enabled: false });
  assert.equal(report.enabled, false);
  assert.equal(report.ready, false);
  assert.equal(report.deploymentVerified, false);
  assert.equal(report.loginVerified, false);
  assert.equal(report.grantCount, 0);
  assert.ok(Array.isArray(report.errors));
});

test('disabled preflight still rejects unsafe URLs and file modes', async () => {
  const f = fixture();
  const report = await inspectConfig({ enabled: false, issuer: 'https://user:pass@identity.example?token=x', resource: 'https://atelier.example/mcp', jwksUri: 'https://identity.example/jwks', registryPath: f.registryPath, policyPath: f.policyPath });
  assert.equal(report.ready, false);
  assert.ok(report.errors.includes('config.issuer_url'));
  assert.equal(report.checks.localFiles, true);
});

test('enabled config reports missing required URLs without throwing', async () => {
  const f = fixture();
  const report = await inspectConfig({ enabled: true, resource: 'https://atelier.example/mcp', registryPath: f.registryPath, policyPath: f.policyPath }, { fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.equal(report.ready, false);
  assert.ok(report.errors.includes('config.issuer_url'));
  assert.ok(report.errors.includes('config.jwksUri_url'));
});

test('enabled config validates local files and provider metadata without leaking values', async () => {
  const f = fixture();
  const config = {
    enabled: true,
    issuer: 'https://identity.example',
    resource: 'https://atelier.example/mcp',
    jwksUri: 'https://identity.example/.well-known/jwks.json',
    registryPath: f.registryPath,
    policyPath: f.policyPath,
  };
  const publicJwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' });
  const responses = new Map([
    ['https://identity.example/.well-known/openid-configuration', {
      issuer: config.issuer,
      jwks_uri: config.jwksUri,
      authorization_endpoint: 'https://identity.example/authorize',
      token_endpoint: 'https://identity.example/token',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
    }],
    ['https://identity.example/.well-known/jwks.json', { keys: [{ ...publicJwk, alg: 'RS256', use: 'sig' }] }],
    ['https://atelier.example/.well-known/oauth-protected-resource/mcp', { resource: config.resource, authorization_servers: [config.issuer] }],
  ]);
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error');
    const body = responses.get(String(url));
    return body ? new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('', { status: 404 });
  };
  const report = await inspectConfig(config, { fetchImpl });
  assert.equal(report.checks.localFiles, true);
  assert.equal(report.checks.oauthMetadata, true);
  assert.equal(report.checks.jwks, true);
  assert.equal(report.checks.resourceMetadata, true);
  assert.equal(report.grantCount, 0);
  assert.equal(report.clientRegistrationRequired, true);
  assert.equal(report.deploymentVerified, false);
  assert.equal(report.loginVerified, false);
  assert.equal(report.ready, false);
  assert.doesNotMatch(JSON.stringify(report), /identity\.example|atelier\.example|portfolio\.json/);
});

test('issuer paths use matching discovery paths and a valid fallback stays clean', async () => {
  const f = fixture();
  const config = { enabled: true, issuer: 'https://identity.example/tenant', resource: 'https://atelier.example/mcp', jwksUri: 'https://identity.example/tenant/jwks', registryPath: f.registryPath, policyPath: f.policyPath };
  const publicJwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' });
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push(String(url)); assert.equal(options.redirect, 'error');
    if (String(url) === 'https://identity.example/tenant/.well-known/openid-configuration') return new Response('', { status: 404 });
    if (String(url) === 'https://identity.example/.well-known/oauth-authorization-server/tenant') return new Response(JSON.stringify({ issuer: config.issuer, jwks_uri: config.jwksUri, authorization_endpoint: 'https://identity.example/authorize', token_endpoint: 'https://identity.example/token', response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'] }));
    if (String(url) === config.jwksUri) return new Response(JSON.stringify({ keys: [{ ...publicJwk, alg: 'RS256' }] }));
    if (String(url).includes('oauth-protected-resource')) return new Response(JSON.stringify({ resource: config.resource, authorization_servers: [config.issuer] }));
    return new Response('', { status: 404 });
  };
  const report = await inspectConfig(config, { fetchImpl });
  assert.equal(report.checks.oauthMetadata, true);
  assert.ok(seen.includes('https://identity.example/tenant/.well-known/openid-configuration'));
  assert.ok(!report.errors.includes('metadata.unavailable'));
});

test('JWKS rejects encryption and sign-only operation keys', async () => {
  const f = fixture();
  const config = { enabled: true, issuer: 'https://identity.example', resource: 'https://atelier.example/mcp', jwksUri: 'https://identity.example/jwks', registryPath: f.registryPath, policyPath: f.policyPath };
  const publicJwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' });
  const fetchImpl = async url => {
    const value = String(url);
    if (value.endsWith('openid-configuration')) return new Response(JSON.stringify({ issuer: config.issuer, jwks_uri: config.jwksUri, authorization_endpoint: 'https://identity.example/authorize', token_endpoint: 'https://identity.example/token', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] }));
    if (value === config.jwksUri) return new Response(JSON.stringify({ keys: [null, { ...publicJwk, alg: 'RS256', use: null, key_ops: ['sign'] }] }));
    return new Response(JSON.stringify({ resource: config.resource, authorization_servers: [config.issuer] }));
  };
  const report = await inspectConfig(config, { fetchImpl });
  assert.equal(report.checks.jwks, false);
  assert.ok(report.errors.includes('jwks.signing_key'));
});

test('oversized streaming response is cancelled and reported safely', async () => {
  const f = fixture();
  const config = { enabled: true, issuer: 'https://identity.example', resource: 'https://atelier.example/mcp', jwksUri: 'https://identity.example/jwks', registryPath: f.registryPath, policyPath: f.policyPath };
  let cancelled = false;
  const fetchImpl = async url => {
    const value = String(url);
    if (value.endsWith('openid-configuration')) return new Response(JSON.stringify({ issuer: config.issuer, jwks_uri: config.jwksUri, authorization_endpoint: 'https://identity.example/authorize', token_endpoint: 'https://identity.example/token', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] }));
    if (value === config.jwksUri) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(300000)); }, cancel() { cancelled = true; } }));
    return new Response(JSON.stringify({ resource: config.resource, authorization_servers: [config.issuer] }));
  };
  const report = await inspectConfig(config, { fetchImpl });
  assert.equal(cancelled, true);
  assert.ok(report.errors.includes('jwks.unavailable_size'));
});

test('enabled config reports safe failure codes for insecure endpoint and private-file violations', async () => {
  const f = fixture();
  fs.chmodSync(f.policyPath, 0o644);
  const report = await inspectConfig({ enabled: true, issuer: 'http://identity.example', resource: 'https://atelier.example/not-mcp', jwksUri: 'https://identity.example/jwks', registryPath: f.registryPath, policyPath: f.policyPath }, { fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.equal(report.ready, false);
  assert.ok(report.errors.includes('config.issuer_https'));
  assert.ok(report.errors.includes('config.resource_path'));
  assert.ok(report.errors.includes('file.policy_private'));
  assert.doesNotMatch(JSON.stringify(report), /must not fetch|identity\.example|atelier\.example/);
});

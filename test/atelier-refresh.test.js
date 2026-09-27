'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { syncAtelier } = require('../src/atelier-sync');
const { readAtelierSource } = require('../src/atelier-source');
const { runRefresh, validateConfig } = require('../src/atelier-refresh');

test('actual CLI accepts the documented absolute config flag and returns a fresh report', t => {
  const f = fixture(t);
  const file = path.join(f.root, 'runner-config.json');
  fs.writeFileSync(file, JSON.stringify(config(f)));
  const result = cp.spawnSync(process.execPath, [path.join(__dirname, '../bin/myos-atelier-refresh.js'), '--config', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'complete');
  assert.equal(report.sources.length, 2);
  assert.ok(report.sources.every(source => source.status === 'skipped'));
});

test('missing nested source path still excludes state descendants in their original order', t => {
  const f = fixture(t);
  const missing = path.join(f.root, 'not-created', 'source');
  const config = {
    schema: 'myos.atelier-refresh@v1', owner: 'test', taskClass: 'maintenance',
    statePath: path.join(missing, 'state', 'refresh.json'),
    sources: [{ ...f.sources[0], path: missing }],
    retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
  };
  assert.throws(() => validateConfig(config), /state_must_be_outside_sources/);
});

function hash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-refresh-'));
  const statePath = path.join(root, 'state', 'refresh.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sources = [];
  for (const id of ['good', 'bad']) {
    const rawSourcePath = path.join(root, id);
    fs.mkdirSync(rawSourcePath, { recursive: true });
    const sourcePath = fs.realpathSync(rawSourcePath);
    fs.writeFileSync(path.join(sourcePath, 'README.md'), `---\nkg:\n  audience: team\n---\n# ${id}\n`);
    fs.writeFileSync(path.join(sourcePath, 'atelier.project.json'), JSON.stringify({
      graph: { outputPath: 'atelier-output/knowledge.graph.json' },
      roots: { workspace: '.' },
      repos: [{ path: '.' }],
    }));
    cp.execFileSync('git', ['init', '-q', sourcePath]);
    cp.execFileSync('git', ['-C', sourcePath, 'add', '.']);
    const bytes = fs.readFileSync(path.join(sourcePath, 'README.md'));
    const rawOriginPath = path.join(root, `${id}-origin`);
    fs.mkdirSync(rawOriginPath, { recursive: true });
    const originPath = fs.realpathSync(rawOriginPath);
    fs.writeFileSync(path.join(originPath, 'README.md'), bytes);
    const source = {
      id,
      mode: 'atelier',
      path: sourcePath,
      audiences: ['team'],
      sourceOrigin: { path: originPath, files: { 'README.md': hash(bytes) } },
    };
    sources.push(source);
  }
  const build = sourcePath => {
    fs.mkdirSync(path.join(sourcePath, 'atelier-output'), { recursive: true });
    fs.writeFileSync(path.join(sourcePath, 'atelier-output/knowledge.graph.json'), JSON.stringify({
      schema: 'mnstry.atelier-knowledge-graph@v1',
      nodes: [{ id: 'readme', path: 'README.md', audience: 'team', summary: 'fixture', relations: {} }],
      errors: [],
    }));
  };
  for (const source of sources) syncAtelier(source.path, { build });
  return { root, statePath, sources, build };
}

function deps(fixture, overrides = {}) {
  return {
    readAtelierSource,
    syncAtelier: sourcePath => syncAtelier(sourcePath, { build: fixture.build }),
    ...overrides,
  };
}

function config(fixture) {
  return {
    schema: 'myos.atelier-refresh@v1',
    owner: 'joe',
    taskClass: 'maintenance',
    statePath: fixture.statePath,
    retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
    sources: fixture.sources,
  };
}

test('fresh sources are skipped and stale sources rebuild derived state', t => {
  const fx = fixture(t);
  let syncs = 0;
  const dependencies = deps(fx, { syncAtelier: sourcePath => { syncs += 1; return syncAtelier(sourcePath, { build: fx.build }); } });
  const first = runRefresh(config(fx), { dependencies, now: 1_000 });
  assert.deepEqual(first.sources.map(source => source.status), ['skipped', 'skipped']);
  fs.appendFileSync(path.join(fx.sources[0].path, 'README.md'), 'changed\n');
  const second = runRefresh(config(fx), { dependencies, now: 2_000 });
  assert.equal(second.sources.find(source => source.id === 'good').status, 'refreshed');
  assert.equal(second.sources.find(source => source.id === 'bad').status, 'skipped');
  assert.equal(syncs, 1);
});

test('canonical origin drift blocks refresh without rewriting or blessing hashes', t => {
  const fx = fixture(t);
  fs.appendFileSync(path.join(fx.sources[0].sourceOrigin.path, 'README.md'), 'origin drift\n');
  let syncs = 0;
  const result = runRefresh(config(fx), { dependencies: deps(fx, { syncAtelier: () => { syncs += 1; } }), now: 1_000 });
  assert.equal(result.sources.find(source => source.id === 'good').status, 'blocked');
  assert.equal(result.sources.find(source => source.id === 'good').reason, 'origin_changed');
  assert.equal(syncs, 0);
  assert.equal(Object.keys(fx.sources[0].sourceOrigin.files).length, 1);
});

test('failed refreshes persist bounded retry and exponential backoff', t => {
  const fx = fixture(t);
  fs.appendFileSync(path.join(fx.sources[0].path, 'README.md'), 'stale\n');
  const dependencies = deps(fx, { syncAtelier: () => { throw new Error('builder_failed'); } });
  const first = runRefresh(config(fx), { dependencies, now: 1_000 });
  assert.equal(first.sources.find(source => source.id === 'good').status, 'failed');
  const second = runRefresh(config(fx), { dependencies, now: 1_050 });
  assert.equal(second.sources.find(source => source.id === 'good').status, 'retry_scheduled');
  assert.equal(second.status, 'pending');
  const third = runRefresh(config(fx), { dependencies, now: 1_100 });
  assert.equal(third.sources.find(source => source.id === 'good').status, 'failed');
  assert.equal(third.sources.find(source => source.id === 'good').attempts, 2);
  assert.equal(third.sources.some(source => JSON.stringify(source).includes('builder_failed')), false);
  const fourth = runRefresh(config(fx), { dependencies, now: 1_300 });
  assert.equal(fourth.sources.find(source => source.id === 'good').attempts, 3);
  const fifth = runRefresh(config(fx), { dependencies, now: 1_700 });
  assert.equal(fifth.sources.find(source => source.id === 'good').status, 'blocked');
  assert.equal(fifth.sources.find(source => source.id === 'good').reason, 'retry_exhausted');
});

test('changed source fingerprint resets exhausted retry state', t => {
  const fx = fixture(t);
  fs.appendFileSync(path.join(fx.sources[0].path, 'README.md'), 'stale\n');
  const dependencies = deps(fx, { syncAtelier: () => { throw new Error('builder_failed'); } });
  const first = runRefresh(config(fx), { dependencies, now: 1_000 });
  assert.equal(first.sources.find(source => source.id === 'good').attempts, 1);
  fs.appendFileSync(path.join(fx.sources[0].path, 'README.md'), 'changed again\n');
  const second = runRefresh(config(fx), { dependencies, now: 1_050 });
  assert.equal(second.sources.find(source => source.id === 'good').status, 'failed');
  assert.equal(second.sources.find(source => source.id === 'good').attempts, 1);
});

test('an existing lock returns a bounded locked report', t => {
  const fx = fixture(t);
  const lockPath = `${fx.statePath}.lock`;
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));
  t.after(() => fs.rmSync(lockPath, { force: true }));
  const result = runRefresh(config(fx), { dependencies: deps(fx), now: 1_000 });
  assert.equal(result.status, 'locked');
  assert.equal(result.taskClass, 'maintenance');
  assert.equal(result.sources.length, 0);
});

test('a dead lock owner is recovered and retained as a stale evidence file', t => {
  const fx = fixture(t);
  const lockPath = `${fx.statePath}.lock`;
  const exited = cp.spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: exited.pid }));
  const result = runRefresh(config(fx), { dependencies: deps(fx), now: 1_000 });
  assert.equal(result.status, 'complete');
  assert.equal(fs.existsSync(lockPath), false);
  assert.ok(fs.readdirSync(path.dirname(lockPath)).some(name => name.startsWith('refresh.json.lock.stale-')));
});

test('canonical direct sources require an explicit flag and may refresh without an origin', t => {
  const fx = fixture(t);
  const direct = { ...fx.sources[0], canonicalDirect: true };
  delete direct.sourceOrigin;
  const directConfig = { ...config(fx), sources: [direct] };
  const result = runRefresh(directConfig, { dependencies: deps(fx), now: 1_000 });
  assert.equal(result.sources[0].status, 'skipped');
  assert.equal(result.sources[0].reason, 'fresh');
  assert.throws(() => validateConfig({ ...directConfig, sources: [{ ...direct, canonicalDirect: false }] }), /source_origin_required/);
});

test('state path cannot overlap a source or its canonical origin', t => {
  const fx = fixture(t);
  assert.throws(() => validateConfig({ ...config(fx), statePath: path.join(fx.sources[0].path, 'state.json') }), /state_must_be_outside_sources/);
  assert.throws(() => validateConfig({ ...config(fx), statePath: path.join(fx.sources[0].sourceOrigin.path, 'state.json') }), /state_must_be_outside_origin/);
  const linkedState = path.join(fx.root, 'linked-state.json');
  fs.symlinkSync(path.join(fx.sources[0].sourceOrigin.path, 'README.md'), linkedState);
  assert.throws(() => validateConfig({ ...config(fx), statePath: linkedState }), /state_must_be_outside_origin/);
  const linkedParent = path.join(fx.root, 'linked-parent');
  fs.symlinkSync(fx.sources[0].sourceOrigin.path, linkedParent);
  assert.throws(() => validateConfig({ ...config(fx), statePath: path.join(linkedParent, 'new.json') }), /state_must_be_outside_origin/);
  assert.throws(() => validateConfig({ ...config(fx), statePath: path.join(linkedParent, 'missing', 'deeper', 'new.json') }), /state_must_be_outside_origin/);
});

test('corrupt state fails closed without replacing the evidence', t => {
  const fx = fixture(t);
  const corrupt = '{not-json}\n';
  fs.writeFileSync(fx.statePath, corrupt);
  const result = runRefresh(config(fx), { dependencies: deps(fx), now: 1_000 });
  assert.equal(result.status, 'attention');
  assert.equal(result.reason, 'state_invalid');
  assert.equal(fs.readFileSync(fx.statePath, 'utf8'), corrupt);
});

test('stale-lock recovery serializes through its recovery guard', t => {
  const fx = fixture(t);
  const lockPath = `${fx.statePath}.lock`;
  const exited = cp.spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: exited.pid }));
  fs.writeFileSync(`${lockPath}.recovery`, 'guard');
  t.after(() => fs.rmSync(`${lockPath}.recovery`, { force: true }));
  const result = runRefresh(config(fx), { dependencies: deps(fx), now: 1_000 });
  assert.equal(result.status, 'locked');
  assert.equal(fs.existsSync(lockPath), true);
});

test('non-regular and symlink lock entries fail closed before reading', t => {
  const fx = fixture(t);
  const lockPath = `${fx.statePath}.lock`;
  const target = path.join(fx.root, 'lock-target');
  fs.writeFileSync(target, JSON.stringify({ pid: process.pid }));
  fs.symlinkSync(target, lockPath);
  assert.equal(runRefresh(config(fx), { dependencies: deps(fx), now: 1_000 }).status, 'locked');
  fs.unlinkSync(lockPath);
  cp.execFileSync('mkfifo', [lockPath]);
  assert.equal(runRefresh(config(fx), { dependencies: deps(fx), now: 1_000 }).status, 'locked');
});

test('one bad source does not stop independent sources', t => {
  const fx = fixture(t);
  fs.appendFileSync(path.join(fx.sources[0].path, 'README.md'), 'stale\n');
  fs.appendFileSync(path.join(fx.sources[1].path, 'README.md'), 'stale\n');
  const result = runRefresh(config(fx), {
    now: 1_000,
    dependencies: deps(fx, { syncAtelier: sourcePath => {
      if (sourcePath === fx.sources[0].path) throw new Error('one_source_failed');
      return syncAtelier(sourcePath, { build: fx.build });
    } }),
  });
  assert.equal(result.sources.find(source => source.id === 'good').status, 'failed');
  assert.equal(result.sources.find(source => source.id === 'bad').status, 'refreshed');
});

test('refresh budget bounds one pass without stopping source inspection', t => {
  const fx = fixture(t);
  for (const source of fx.sources) fs.appendFileSync(path.join(source.path, 'README.md'), 'stale\n');
  let syncs = 0;
  const result = runRefresh({ ...config(fx), maxRefreshes: 1 }, {
    now: 1_000,
    dependencies: deps(fx, { syncAtelier: sourcePath => { syncs += 1; return syncAtelier(sourcePath, { build: fx.build }); } }),
  });
  assert.equal(syncs, 1);
  assert.equal(result.sources.filter(source => source.status === 'refreshed').length, 1);
  assert.equal(result.sources.filter(source => source.status === 'deferred').length, 1);
  assert.equal(result.status, 'pending');
});

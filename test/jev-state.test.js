'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readState, writeMetrics, appendLedger } = require('../src/decision/jev-state');
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('legacy metrics migrate on read until a separate metrics file exists', t => {
  const dir = home(t);
  const config = path.join(dir, 'config.json');
  const metrics = path.join(dir, 'jev-shadow-metrics.json');
  const original = JSON.stringify({ stage: 'authoritative', metrics: { old: 1 }, promotionNote: 'keep' });
  fs.writeFileSync(config, original);
  assert.deepEqual(readState(config).metrics, { old: 1 });
  assert.equal(readState(config).config.promotionNote, 'keep');
  assert.equal(writeMetrics(metrics, { newer: 2 }), true);
  assert.deepEqual(readState(config).metrics, { newer: 2 });
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  fs.writeFileSync(metrics, '{torn');
  assert.deepEqual(readState(config).metrics, {});
  assert.equal(readState(config).metricsUnreadable, true);
});
test('metrics publication uses same-directory atomic rename and cleans failed writes', t => {
  const dir = home(t);
  const file = path.join(dir, 'metrics.json');
  fs.writeFileSync(file, '{"old":1}');
  const rename = fs.renameSync;
  let called = false;
  let blocked = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (blocked) throw new Error('blocked');
    called = true;
    assert.equal(path.dirname(from), dir);
    assert.match(from, /metrics\.json\.\d+\.[a-f0-9]+\.tmp$/);
    assert.deepEqual(JSON.parse(fs.readFileSync(to)), { old: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(from)), { fresh: 2 });
    rename(from, to);
  });
  assert.equal(writeMetrics(file, { fresh: 2 }), true);
  assert.equal(called, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { fresh: 2 });
  blocked = true;
  assert.equal(writeMetrics(file, {}), false);
  assert.deepEqual(fs.readdirSync(dir), ['metrics.json']);
});
test('ledger rotates above 50 MB before appending and preserves existing rotations', t => {
  const dir = home(t);
  const file = path.join(dir, 'jev-shadow.jsonl');
  fs.writeFileSync(file, 'old');
  fs.truncateSync(file, 50 * 1024 * 1024 + 1);
  appendLedger(file, { fresh: 1 });
  const rotated = fs.readdirSync(dir).find(name => /^jev-shadow\.\d{8}-\d{6}\.jsonl$/.test(name));
  assert.ok(rotated);
  assert.equal(fs.statSync(path.join(dir, rotated)).size, 50 * 1024 * 1024 + 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { fresh: 1 });
  fs.truncateSync(file, 50 * 1024 * 1024 + 1);
  appendLedger(file, { fresh: 2 });
  assert.equal(fs.readdirSync(dir).length, 3);
});

test('a busy rotation lock preserves archives and still permits observations', t => {
  const dir = home(t);
  const file = path.join(dir, 'jev-shadow.jsonl');
  fs.writeFileSync(file, '');
  fs.truncateSync(file, 50 * 1024 * 1024 + 1);
  fs.mkdirSync(`${file}.rotate-lock`);
  appendLedger(file, { next: 1 });
  assert.equal(fs.statSync(file).size, 50 * 1024 * 1024 + 1 + Buffer.byteLength('{"next":1}\n'));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['jev-shadow.jsonl', 'jev-shadow.jsonl.rotate-lock']);
});

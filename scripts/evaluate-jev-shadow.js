#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual: equal } = require('node:util');
const { resolveDispatchPlan, collectDispatchSignals } = require('../src/workspace-context');
const { compactRoute, toolSafetyLabels } = require('../bin/myos-dispatch-hook');
const { buildPromptPack, buildToolPack } = require('../src/decision/jev-packs');
const { attachJevShadow, attachJevToolSafety } = require('../src/decision/jev-shadow');
const { createJevClient } = require('../src/runtime/jev-client');
const { summarizeCalibration, isFieldEligibleForPromotion } = require('../src/decision/jev-promotion-policy');

function parseArgs(argv) {
  const args = { limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (['live', 'json', 'strict'].includes(key)) args[key] = true;
    else if (['ledger', 'prompt-corpus', 'tool-corpus', 'field', 'limit'].includes(key)) args[key] = argv[++i];
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  if (args.limit !== Infinity) {
    args.limit = Number(args.limit);
    if (!Number.isInteger(args.limit) || args.limit < 0) throw new Error('limit must be a nonnegative integer');
  }
  return args;
}

function inputFiles(input) {
  if (fs.existsSync(input)) return fs.statSync(input).isDirectory()
    ? fs.readdirSync(input).filter(name => /^jev-shadow(?:\..+)?\.jsonl$/.test(name)).sort().map(name => path.join(input, name)) : [input];
  if (!/[?*]/.test(input)) return [];
  const parts = path.resolve(input).split(path.sep).filter(Boolean);
  let files = [path.parse(path.resolve(input)).root];
  for (const part of parts) {
    const pattern = new RegExp('^' + part.split('').map(char => char === '*' ? '.*' : char === '?' ? '.'
      : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$');
    files = files.flatMap(dir => {
      try { return fs.readdirSync(dir).filter(name => pattern.test(name)).map(name => path.join(dir, name)); }
      catch { return []; }
    });
  }
  return files.filter(file => fs.statSync(file).isFile()).sort();
}

function readRows(file, limit, optional = false) {
  if (!file) return [];
  const files = inputFiles(file);
  if (!files.length && !optional) throw new Error(`Input not found: ${file}`);
  const rows = [];
  for (const name of files) {
    if (rows.length >= limit) break;
    const text = fs.readFileSync(name, 'utf8').trim();
    if (!text) continue;
    const entries = text.startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/).filter(Boolean).map(JSON.parse);
    for (const row of entries) {
      if (rows.length >= limit) break;
      rows.push(row);
    }
  }
  return rows;
}

function metric() {
  return { n: 0, agree: 0, sumConfidence: 0, bins: Array.from({ length: 10 }, () => ({ n: 0, agree: 0 })) };
}

function observe(metrics, name, agrees, confidence) {
  const row = metrics[name] ||= metric();
  const certainty = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;
  row.n++;
  row.agree += Number(agrees);
  row.sumConfidence += certainty;
  const bin = row.bins[Math.min(9, Math.floor(certainty * 10))];
  bin.n++;
  bin.agree += Number(agrees);
}

function summarize(metrics = {}, stateMetrics = metrics) {
  return Object.fromEntries(Object.entries(metrics).map(([field, row]) => [field, {
    n: row.n, agreement: row.n ? row.agree / row.n : null,
    meanConfidence: row.n ? row.sumConfidence / row.n : null,
    reliability: summarizeCalibration(stateMetrics[field]?.bins),
    eligibleForPromotion: isFieldEligibleForPromotion(stateMetrics[field]),
  }]));
}

function valueOf(plan, field) {
  if (field.startsWith('blockedBy.')) return (plan.blockedBy || []).includes(field.slice(10));
  return plan[field];
}

function scoreAnswer(answer) {
  if (answer.type === 'noul' || Object.hasOwn(answer, 'noul')) return { value: answer.noul >= 0.5, confidence: Math.max(answer.noul, 1 - answer.noul) };
  return { value: Object.hasOwn(answer, 'score') ? Math.round(answer.score) + 1 : answer.choice, confidence: answer.confidence };
}

function labelScores(predictions, truth, fields) {
  for (const name of Object.keys(fields)) {
    const row = fields[name];
    const predicted = predictions.includes(name);
    const actual = truth.includes(name);
    row.tp += Number(predicted && actual);
    row.fp += Number(predicted && !actual);
    row.fn += Number(!predicted && actual);
  }
}

function finishLabels(fields) {
  return Object.fromEntries(Object.entries(fields).map(([name, row]) => {
    const precision = row.tp + row.fp ? row.tp / (row.tp + row.fp) : 0;
    const recall = row.tp + row.fn ? row.tp / (row.tp + row.fn) : 0;
    return [name, { ...row, precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0 }];
  }));
}

async function evaluate(args) {
  const home = process.env.MYOS_HOME_ROOT || path.join(os.homedir(), '.myos-dispatch');
  const ledger = args.ledger || path.join(home, 'logs');
  const selected = field => !args.field || field === args.field || field === `safety.${args.field}`;
  const metrics = {};
  const promptPack = buildPromptPack('synthetic');
  const toolPack = buildToolPack('ls -la', 'List files');
  const map = { ...promptPack.fields, ...toolPack.fields, lane: { planField: 'executionLane' }, project: { planField: 'projectSlug' } };
  for (const row of readRows(ledger, args.limit, true)) {
    if (row.engine !== 'jev') continue;
    for (const [key, answer] of Object.entries(row.decided || {})) {
      const field = (row.event === 'tool' ? toolPack.fields[key] : promptPack.fields[key])?.planField || map[key]?.planField;
      if (!field || !selected(field) || !Object.hasOwn(row.legacy || {}, field)) continue;
      const scored = scoreAnswer(answer);
      observe(metrics, field, equal(scored.value, row.legacy[field]), scored.confidence);
    }
    if (row.decided?.goal_scale && Object.hasOwn(row.legacy || {}, 'goalConfidence') && selected('goalConfidence')) {
      const confidence = row.decided.goal_scale.confidence;
      observe(metrics, 'goalConfidence', equal(confidence, row.legacy.goalConfidence), confidence);
    }
  }
  const report = { mode: args.live ? 'live' : 'rules', ledger: { path: ledger, fields: summarize(metrics) },
    eligibleFields: Object.entries(metrics).filter(([field, row]) => selected(field) && isFieldEligibleForPromotion(row)).map(([field]) => field),
    prompts: { n: 0, fields: {} }, tools: { n: 0, engines: {}, reliability: {} }, regressions: [] };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-evaluate-'));
  try {
    const opts = { env: { ...process.env, MYOS_HOME_ROOT: scratch, MYOS_JEV_STAGE: 'shadow' },
      client: args.live ? createJevClient({ timeoutMs: Number(process.env.MYOS_JEV_TIMEOUT_MS) || 1500, maxRetries: 1 }) : undefined };
    for (const row of readRows(args['prompt-corpus'], args.limit)) {
      const legacy = resolveDispatchPlan(row.prompt, { env: { ...process.env, MYOS_BACKGROUND_AGENTS_ENABLED: '0' } });
      const signals = opts.client?.isConfigured() ? collectDispatchSignals(row.prompt) : {};
      const result = await attachJevShadow(row.prompt, legacy, signals, opts);
      report.prompts.n++;
      const fields = new Set([...Object.keys(row.incumbent || {}), ...Object.keys(row.truth || {})]);
      for (const field of fields) {
        if (!selected(field)) continue;
        const totals = report.prompts.fields[field] ||= {};
        const values = { legacy: valueOf(legacy, field), [result.jev.engine]: result.jev.comparison[field]?.decided ?? valueOf(legacy, field) };
        for (const [engine, value] of Object.entries(values)) {
          const count = totals[engine] ||= { n: 0, agree: 0, truthN: 0, correct: 0, incumbentN: 0, pairedCorrect: 0, incumbentCorrect: 0 };
          if (Object.hasOwn(row.incumbent || {}, field)) { count.n++; count.agree += Number(equal(value, row.incumbent[field])); }
          if (row.truth && Object.hasOwn(row.truth, field)) {
            count.truthN++; count.correct += Number(equal(value, row.truth[field]));
            if (Object.hasOwn(row.incumbent || {}, field)) {
              count.incumbentN++; count.pairedCorrect += Number(equal(value, row.truth[field]));
              count.incumbentCorrect += Number(equal(row.incumbent[field], row.truth[field]));
            }
          }
        }
      }
    }
    for (const [field, engines] of Object.entries(report.prompts.fields)) for (const [engine, count] of Object.entries(engines)) {
      count.agreement = count.n ? count.agree / count.n : null;
      count.accuracy = count.truthN ? count.correct / count.truthN : null;
      count.incumbentAccuracy = count.incumbentN ? count.incumbentCorrect / count.incumbentN : null;
      if (count.incumbentN && count.pairedCorrect < count.incumbentCorrect) report.regressions.push(`${field}:${engine}`);
    }
    const reliability = {};
    const pairedTools = {};
    for (const row of readRows(args['tool-corpus'], args.limit)) {
      const pack = buildToolPack(row.command, row.description, { cwd: scratch });
      const plan = resolveDispatchPlan(row.command, { env: { ...process.env, MYOS_BACKGROUND_AGENTS_ENABLED: '0' } });
      const labels = toolSafetyLabels(compactRoute(plan));
      const result = await attachJevToolSafety(row.command, row.description, { cwd: scratch }, labels, opts);
      const decided = Object.entries(result.jev.comparison).filter(([, value]) => value.decided).map(([field]) => field.slice(7));
      const engines = { legacy: labels, [result.jev.engine]: decided };
      if (Array.isArray(row.incumbent_labels)) engines.incumbent = row.incumbent_labels;
      report.tools.n++;
      for (const [engine, predictions] of Object.entries(engines)) {
        const fields = report.tools.engines[engine] ||= Object.fromEntries(Object.values(pack.fields)
          .filter(field => field.planField && selected(field.planField)).map(field => [field.planField.slice(7), { tp: 0, fp: 0, fn: 0 }]));
        labelScores(predictions, row.truth_labels, fields);
        if (Array.isArray(row.incumbent_labels)) {
          const paired = pairedTools[engine] ||= Object.fromEntries(Object.keys(fields).map(label => [label, { tp: 0, fp: 0, fn: 0 }]));
          labelScores(predictions, row.truth_labels, paired);
        }
        for (const label of Object.keys(fields)) {
          observe(reliability[engine] ||= {}, label, predictions.includes(label) === row.truth_labels.includes(label),
            engine === 'legacy' || engine === 'incumbent' ? 1 : result.jev.comparison[`safety.${label}`].confidence);
        }
      }
    }
    for (const [engine, fields] of Object.entries(report.tools.engines)) {
      report.tools.engines[engine] = finishLabels(fields);
      report.tools.reliability[engine] = summarize(reliability[engine]);
    }
    const pairedScores = Object.fromEntries(Object.entries(pairedTools).map(([engine, fields]) => [engine, finishLabels(fields)]));
    for (const [engine, fields] of Object.entries(pairedScores)) {
      if (engine === 'incumbent') continue;
      for (const [label, row] of Object.entries(fields)) {
        if (row.f1 < (pairedScores.incumbent?.[label]?.f1 ?? 0)) report.regressions.push(`safety.${label}:${engine}`);
      }
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  return report;
}

function printHuman(report) {
  console.log(`Jev evaluation (${report.mode})`);
  console.log('Ledger field                       n    agreement confidence eligible');
  for (const [field, row] of Object.entries(report.ledger.fields)) console.log(`${field.padEnd(34)} ${String(row.n).padStart(4)} ${String(row.agreement).padEnd(9)} ${String(row.meanConfidence).padEnd(10)} ${row.eligibleForPromotion}`);
  console.log(`Eligible fields: ${report.eligibleFields.join(', ') || 'none'}`);
  console.log('Prompt field / engine              n    agreement accuracy');
  for (const [field, engines] of Object.entries(report.prompts.fields)) for (const [engine, row] of Object.entries(engines)) console.log(`${`${field}/${engine}`.padEnd(34)} ${String(row.n).padStart(4)} ${String(row.agreement).padEnd(9)} ${row.accuracy}`);
  console.log('Tool label / engine                precision recall    F1');
  for (const [engine, fields] of Object.entries(report.tools.engines)) for (const [label, row] of Object.entries(fields)) console.log(`${`${label}/${engine}`.padEnd(34)} ${row.precision.toFixed(3).padEnd(9)} ${row.recall.toFixed(3).padEnd(9)} ${row.f1.toFixed(3)}`);
  console.log('Reliability field / engine         bin n    empirical midpoint gap');
  for (const [engine, fields] of Object.entries({ ledger: report.ledger.fields, ...report.tools.reliability })) for (const [field, row] of Object.entries(fields)) for (const bin of row.reliability) console.log(`${`${field}/${engine}`.padEnd(34)} ${bin.bin}   ${String(bin.n).padEnd(4)} ${String(bin.empiricalAgreement).padEnd(9)} ${bin.midpoint.toFixed(2)}     ${bin.gap}`);
  console.log(`Regressions: ${report.regressions.join(', ') || 'none'}`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    const report = await evaluate(args);
    if (args.json) console.log(JSON.stringify(report)); else printHuman(report);
    if (args.strict && report.regressions.length) process.exitCode = 1;
  } catch (error) {
    if (args?.json || process.argv.includes('--json')) console.log(JSON.stringify({ error: error.message }));
    else console.error(error.message);
  }
}
if (require.main === module) main();

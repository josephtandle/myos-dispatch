#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const { resolveDispatchPlan } = require("../src/workspace-context");
const {
  DEFAULT_REPLAY_CORPUS_FILE,
  evaluateTypedEvidenceReplayCases,
  loadTypedEvidenceReplayCorpus,
  recordTypedEvidenceReplayEvaluation,
} = require("../src/promotion/typed-evidence-shadow-policy");

function parseArgs(argv) {
  const args = {
    corpusFile: DEFAULT_REPLAY_CORPUS_FILE,
    stateFile: "",
    strict: false,
    json: false,
    noRecord: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--corpus") args.corpusFile = argv[++i];
    else if (arg === "--state-file") args.stateFile = argv[++i];
    else if (arg === "--strict") args.strict = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--no-record") args.noRecord = true;
    else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: node scripts/evaluate-typed-evidence-shadow.js [--strict] [--json] [--no-record]",
        "       [--corpus <file>] [--state-file <file>]",
      ].join("\n"));
      process.exit(0);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.corpusFile)) {
    console.error(`Replay corpus not found: ${args.corpusFile}`);
    process.exit(2);
  }

  const cases = loadTypedEvidenceReplayCorpus(args.corpusFile);
  const evaluation = evaluateTypedEvidenceReplayCases(cases, (prompt) => resolveDispatchPlan(prompt, {
    typedEvidenceShadowPolicy: {
      disableAuthority: true,
      stateFile: args.stateFile || undefined,
    },
  }));
  const progression = args.noRecord
    ? null
    : recordTypedEvidenceReplayEvaluation(evaluation, {
        stateFile: args.stateFile || undefined,
      });

  const summary = {
    replayCases: evaluation.replayCases,
    replayPassedCases: evaluation.replayPassedCases,
    replayFailedCases: evaluation.replayFailedCases,
    replayPassRate: evaluation.replayPassRate,
    hardGatePassRate: evaluation.hardGatePassRate,
    safeCanaryCases: evaluation.safeCanaryCases,
    dangerousMismatches: evaluation.dangerousMismatches,
    promoted: progression?.promoted || null,
    activeStage: progression?.state?.activeStage || null,
    failed: evaluation.failed.map((entry) => ({
      id: entry.id,
      prompt: entry.prompt,
      mismatches: entry.mismatches,
      dangerousMismatch: entry.dangerousMismatch,
    })),
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, evaluation, progression }, null, 2));
  } else {
    console.log(`Typed-evidence shadow replay: ${summary.replayPassedCases}/${summary.replayCases} passed`);
    console.log(`Pass rate: ${summary.replayPassRate}`);
    console.log(`Hard-gate pass rate: ${summary.hardGatePassRate}`);
    console.log(`Safe canary cases: ${summary.safeCanaryCases}`);
    console.log(`Dangerous mismatches: ${summary.dangerousMismatches}`);
    console.log(`Active stage: ${summary.activeStage || "not recorded"}`);
    if (summary.promoted) console.log(`Promoted: ${summary.promoted.from} -> ${summary.promoted.to}`);
    for (const failure of summary.failed) {
      console.log(`FAIL ${failure.id}: ${failure.prompt}`);
      for (const mismatch of failure.mismatches || []) {
        console.log(`  ${mismatch.field}: expected ${JSON.stringify(mismatch.expected)} got ${JSON.stringify(mismatch.actual)}`);
      }
      if (failure.dangerousMismatch) console.log("  dangerous mismatch: would authorize a must-not-authorize case");
    }
  }

  if (args.strict && evaluation.replayFailedCases > 0) process.exit(1);
  if (args.strict && evaluation.dangerousMismatches > 0) process.exit(1);
}

main();

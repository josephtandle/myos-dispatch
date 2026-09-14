"use strict";

function validateEmbedResult(result) {
  const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
  const failuresValid = result?.failures === undefined || Array.isArray(result.failures);
  const durationValid = result?.durationMs === undefined
    || (Number.isFinite(result.durationMs) && result.durationMs >= 0);
  return Boolean(result && isCount(result.docsProcessed) && isCount(result.chunksEmbedded)
    && isCount(result.errors) && failuresValid && durationValid
    && result.errors === 0 && (result.failures === undefined || result.failures.length === 0));
}

module.exports = { validateEmbedResult };

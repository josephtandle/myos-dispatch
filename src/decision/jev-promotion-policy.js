'use strict';

function summarizeCalibration(bins) {
  return Array.from({ length: 10 }, (_, bin) => {
    const entry = Array.isArray(bins) ? bins[bin] : null;
    const n = Number.isInteger(entry?.n) && entry.n > 0 ? entry.n : 0;
    const agree = Number.isInteger(entry?.agree) && entry.agree >= 0 && entry.agree <= n ? entry.agree : 0;
    const empiricalAgreement = n ? agree / n : null;
    const midpoint = (bin + 0.5) / 10;
    return { bin, n, empiricalAgreement, midpoint, gap: n ? Math.abs(empiricalAgreement - midpoint) : null };
  });
}

function isFieldEligibleForPromotion(fieldMetrics, { minN = 200, minAgreement = 0.9, maxCalibrationError = 0.1 } = {}) {
  const { n, agree, bins } = fieldMetrics || {};
  if (!Number.isInteger(n) || n <= 0 || n < minN || !Number.isInteger(agree) || agree < 0 || agree > n || agree / n < minAgreement) return false;
  if (!Array.isArray(bins) || bins.length !== 10 || bins.some((entry) => !Number.isInteger(entry?.n) || entry.n < 0
    || !Number.isInteger(entry?.agree) || entry.agree < 0 || entry.agree > entry.n)) return false;
  const rows = summarizeCalibration(bins);
  if (rows.reduce((sum, row) => sum + row.n, 0) !== n || bins.reduce((sum, row) => sum + row.agree, 0) !== agree) return false;
  const calibrationError = rows.reduce((sum, row) => sum + row.n * (row.gap || 0), 0) / n;
  return calibrationError <= maxCalibrationError;
}

module.exports = { isFieldEligibleForPromotion, summarizeCalibration };

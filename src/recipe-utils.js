const { RecipeInputError } = require("./recipe-errors");

function sanitizeFilename(value, fallback = "artifact", maxLength = 64) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength) || fallback;
}

function extractQuotedText(text, maxLength = 250) {
  const match = String(text || "").match(new RegExp(`["“]([^"”]{1,${maxLength}})["”]`));
  return match ? match[1].trim() : "";
}

function ensureText(value, message) {
  const text = String(value || "").trim();
  if (!text) {
    throw new RecipeInputError(message);
  }
  return text;
}

function formatCurrency(amount, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: String(currency || "usd").toUpperCase(),
  }).format(Number(amount || 0) / 100);
}

function normalizeRecipeResult(recipe, result, extras = {}) {
  const metadata = {
    ...(result?.metadata || {}),
    route: {
      recipeId: recipe.id,
      layer: recipe.layer,
      owner: recipe.owner,
      ...extras.route,
    },
  };

  return {
    status: result?.status || "ok",
    reply: String(result?.reply || "").trim(),
    artifacts: Array.isArray(result?.artifacts) ? result.artifacts : [],
    recipeId: recipe.id,
    metadata,
    usage: result?.usage || null,
    sessionId: result?.sessionId || null,
  };
}

module.exports = {
  ensureText,
  extractQuotedText,
  formatCurrency,
  normalizeRecipeResult,
  sanitizeFilename,
};

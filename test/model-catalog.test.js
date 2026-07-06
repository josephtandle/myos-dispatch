const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadCatalog,
  resolveProfileModel,
} = require("../src/model-catalog");

test("OpenAI catalog exposes gpt-5.4-mini as the bot default profile", () => {
  const catalog = loadCatalog("openai");
  const resolved = resolveProfileModel(catalog, "bot_default");

  assert.equal(catalog.provider, "openai");
  assert.equal(resolved.model.id, "openai.gpt-5.4-mini");
  assert.equal(resolved.model.model, "gpt-5.4-mini");
  assert.equal(resolved.profile.id, "bot_default");
});

test("legacy Claude alias resolves through the Anthropic catalog", () => {
  const catalog = loadCatalog("claude");
  const resolved = resolveProfileModel(catalog, "bot_smart");

  assert.equal(catalog.provider, "anthropic");
  assert.equal(resolved.profile.id, "bot_smart");
  assert.match(resolved.model.id, /^anthropic\./);
});

test("Catalog models carry runtime capability fields", () => {
  const catalog = loadCatalog("openai");
  const model = catalog.models.find((entry) => entry.id === "openai.gpt-5.4-mini");

  assert.ok(model);
  assert.equal(typeof model.context_window, "number");
  assert.equal(typeof model.max_output_tokens, "number");
  assert.equal(typeof model.supports_text, "boolean");
  assert.equal(typeof model.supports_tools, "boolean");
  assert.equal(typeof model.supports_streaming, "boolean");
});

test("Google catalog loads and resolves the bot_default profile", () => {
  const catalog = loadCatalog("google");
  const resolved = resolveProfileModel(catalog, "bot_default");

  assert.equal(catalog.provider, "google");
  assert.equal(resolved.profile.id, "bot_default");
  assert.equal(resolved.model.id, "google.gemini-2.5-flash");
  assert.match(resolved.model.model, /gemini/);
});

test("Google catalog resolves google_heavy_reasoning to gemini-2.5-pro", () => {
  const catalog = loadCatalog("google");
  const resolved = resolveProfileModel(catalog, "google_heavy_reasoning");

  assert.equal(resolved.model.id, "google.gemini-2.5-pro");
});

test("Google catalog resolves google_cheap_extraction to gemini-2.5-flash-lite", () => {
  const catalog = loadCatalog("google");
  const resolved = resolveProfileModel(catalog, "google_cheap_extraction");

  assert.equal(resolved.model.id, "google.gemini-2.5-flash-lite");
});

test("OpenAI catalog resolves cheap_routing to gpt-5-mini", () => {
  const catalog = loadCatalog("openai");
  const resolved = resolveProfileModel(catalog, "cheap_routing");

  assert.equal(resolved.model.id, "openai.gpt-5-mini");
});

test("Anthropic catalog exposes Fable 5 as the advisor route with Opus fallback", () => {
  const catalog = loadCatalog("anthropic");
  const resolved = resolveProfileModel(catalog, "anthropic_advisor");

  assert.equal(resolved.profile.id, "anthropic_advisor");
  assert.equal(resolved.model.id, "anthropic.claude-fable-5");
  assert.equal(resolved.model.pricing_per_1m_tokens.input_usd, 10);
  assert.equal(resolved.model.pricing_per_1m_tokens.output_usd, 50);
  assert.deepEqual(resolved.model.allowed_auth_modes, ["oauth"]);
  assert.equal(resolved.model.api_allowed, false);
  assert.deepEqual(resolved.profile.fallback, ["anthropic.claude-opus-4-8"]);
  assert.equal(resolved.model.fallback_policy.fallback_profile, "anthropic_safety_fallback");
  assert.equal(resolved.model.cost_control.myos_policy, "oauth_only");
});

test("Anthropic catalog documents Fable 5 platform retention policy", () => {
  const catalog = loadCatalog("anthropic");

  assert.equal(catalog.platform_policies.data_retention.default_days, 30);
  assert.deepEqual(catalog.platform_policies.data_retention.applies_to, ["inputs", "outputs"]);
  assert.equal(catalog.platform_policies.safety_fallback.fallback_profile, "anthropic_safety_fallback");
});

test("Google catalog models carry standard capability fields", () => {
  const catalog = loadCatalog("google");
  const model = catalog.models.find((entry) => entry.id === "google.gemini-2.5-flash");

  assert.ok(model);
  assert.equal(typeof model.context_window, "number");
  assert.equal(typeof model.max_output_tokens, "number");
  assert.equal(typeof model.supports_text, "boolean");
  assert.equal(typeof model.supports_tools, "boolean");
  assert.equal(typeof model.supports_streaming, "boolean");
});

test("normalizeProvider maps gemini alias to google", () => {
  const { normalizeProvider } = require("../src/model-catalog");
  assert.equal(normalizeProvider("gemini"), "google");
  assert.equal(normalizeProvider("google"), "google");
  assert.equal(normalizeProvider("GOOGLE"), "google");
});

test("Google catalog resolves google_search_grounded to gemini-2.5-flash", () => {
  const catalog = loadCatalog("google");
  const resolved = resolveProfileModel(catalog, "google_search_grounded");

  assert.equal(resolved.profile.id, "google_search_grounded");
  assert.equal(resolved.model.id, "google.gemini-2.5-flash");
  assert.equal(resolved.model.supports_search_grounding, true);
});

test("Google catalog deep-research model is marked blocked_interactions_api", () => {
  const catalog = loadCatalog("google");
  const model = catalog.models.find((entry) => entry.id === "google.deep-research-pro");

  assert.ok(model, "deep-research-pro model must exist in catalog");
  assert.equal(model.status, "blocked_interactions_api");
  assert.ok(model.notes.includes("Interactions API"), "notes must document the API restriction");
});

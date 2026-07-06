const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveProvider,
  resolveProfileId,
} = require("../src/runtime/llm-call");

test("resolveProvider prefers MyOS env names", () => {
  process.env.MYOS_LLM_PROVIDER = "openai";
  delete process.env.OPENCLAW_LLM_PROVIDER;

  assert.equal(resolveProvider(), "openai");
});

test("resolveProfileId falls back to default_automation", () => {
  delete process.env.MYOS_MODEL_PROFILE_DEFAULT;
  assert.equal(resolveProfileId(), "default_automation");
});

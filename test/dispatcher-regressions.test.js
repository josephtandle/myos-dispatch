const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Self-contained fixture workspace with a generic create-only project recipe.
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-regressions-"));
const WORKSPACE_ROOT = path.join(FIXTURE_ROOT, "workspace");
const PROJECT_RECIPES_DIR = path.join(WORKSPACE_ROOT, "projects", "acme", "recipes");
fs.mkdirSync(PROJECT_RECIPES_DIR, { recursive: true });
fs.writeFileSync(
  path.join(WORKSPACE_ROOT, "projects", "_index.json"),
  JSON.stringify({ projects: { acme: { path: "acme", name: "Acme", aliases: ["acme"] } } }),
  "utf8",
);
fs.writeFileSync(
  path.join(PROJECT_RECIPES_DIR, "make-brochure.js"),
  "module.exports.runRecipe = async () => ({ reply: 'brochure created' });\n",
  "utf8",
);
fs.writeFileSync(
  path.join(PROJECT_RECIPES_DIR, "make-brochure.recipe.json"),
  JSON.stringify({
    id: "project/acme/make-brochure",
    layer: "project",
    owner: "acme",
    title: "Make Brochure",
    tags: ["brochure"],
    phrases: ["make an acme brochure", "acme brochure"],
    objects: ["brochure"],
    actions: ["create"],
    inputMode: "structured",
    outputMode: "artifact",
    requiredTextPatterns: ["brochure"],
    handler: "./make-brochure.js",
  }),
  "utf8",
);

process.env.MYOS_WORKSPACE = WORKSPACE_ROOT;

const { dispatchTask, pickRecipe } = require("../src/task-dispatcher");

test("homepage link request does not route into create-only recipe", async () => {
  const request = {
    text: "I need you get me the link for the Acme homepage and also the mentorship page",
    chatId: "dispatcher-test",
    caller: "agent/user",
    channel: "telegram",
  };

  // The create-only recipe may top the candidate list on project inference...
  const chosen = pickRecipe(request);
  if (chosen.recipe) {
    assert.equal(chosen.recipe.id, "project/acme/make-brochure");
  }

  // ...but a retrieval-style request must not actually execute it.
  await assert.rejects(
    dispatchTask(request),
    /No matching recipe and no fallback configured/,
  );
});

test("project-scoped structured recipes require direct evidence beyond project inference", () => {
  const request = {
    text: "can you help with the acme website",
    chatId: "dispatcher-test-2",
    caller: "agent/user",
    channel: "telegram",
  };

  const chosen = pickRecipe(request);
  if (chosen.recipe) {
    assert.equal(chosen.recipe.id, "project/acme/make-brochure");
    assert.ok((chosen.directEvidenceScore || 0) < 8);
  } else {
    assert.equal(chosen.recipe, null);
  }
});

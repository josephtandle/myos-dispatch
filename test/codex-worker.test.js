const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  buildWorkerPrompt,
  extractAssistantMessageText,
  extractFirstJsonObject,
  isToolArgumentParseError,
  normalizeStructuredReplyPayload,
  parseCodexJsonl,
  resolveCodexWorkerModelSelection,
  resolveRunOutboxDir,
  TOOL_ARGUMENT_PARSE_RECOVERY_HINT,
} = require("../src/background/codex-worker");

test("buildWorkerPrompt includes MyOS Dispatch guardrails", () => {
  const prompt = buildWorkerPrompt({
    systemPrompt: "system context",
    userText: "find the website",
    outboxDir: "/tmp/outbox",
    displayName: "User",
    sourceLabel: "text",
    graphContext: "",
  });

  assert.match(prompt, /Use MyOS Dispatch as the execution contract/);
  assert.match(prompt, /DISPATCH-FASTPATHS\.json, project _index\.json, capabilities-index\.json, TOOLS\.md/);
  assert.match(prompt, /Do not jump from a weak first hit into broad workspace or repo searches/);
  assert.match(prompt, /Stop after a strong fast-path, project context, or capability match/);
  assert.match(prompt, /Resolve the MyOS project\/data branch first/);
  assert.match(prompt, /Do not spawn ad hoc background scouts or call myos-sidecar\.js yourself/);
  assert.doesNotMatch(prompt, /you can spawn a background scout/);
});

test("parseCodexJsonl collects assistant content-array text", () => {
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "assistant_message",
        content: [
          { type: "output_text", text: "{\"reply\":\"ok\",\"artifacts\":[]}" },
        ],
      },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1, cached_input_tokens: 2, output_tokens: 3 },
    }),
  ].join("\n");

  const parsed = parseCodexJsonl(stdout);
  assert.equal(parsed.sessionId, "thread-1");
  assert.equal(parsed.summary, "{\"reply\":\"ok\",\"artifacts\":[]}");
  assert.deepEqual(parsed.usage, {
    inputTokens: 1,
    cachedInputTokens: 2,
    outputTokens: 3,
  });
});

test("extractAssistantMessageText joins structured content parts", () => {
  const text = extractAssistantMessageText({
    type: "assistant_message",
    content: [
      { type: "output_text", text: "{\"reply\":\"ok\"" },
      { type: "output_text", text: ",\"artifacts\":[]}" },
    ],
  });

  assert.equal(text, "{\"reply\":\"ok\",\"artifacts\":[]}");
});

test("extractFirstJsonObject prefers the last valid structured payload", () => {
  const text = [
    "Use this shape:",
    "{\"reply\":\"string\",\"artifacts\":[{\"path\":\"string\",\"caption\":\"string\",\"filename\":\"string\",\"mimeType\":\"string\",\"kind\":\"document|photo\"}]}",
    "Final:",
    "{\"reply\":\"done\",\"artifacts\":[]}",
  ].join("\n");

  const parsed = extractFirstJsonObject(text);
  assert.deepEqual(parsed, { reply: "done", artifacts: [] });
});

test("normalizeStructuredReplyPayload falls back to plain text summaries", () => {
  assert.deepEqual(
    normalizeStructuredReplyPayload(null, "Working on it now."),
    { reply: "Working on it now.", artifacts: [] }
  );
});

test("normalizeStructuredReplyPayload accepts reply-like objects missing artifacts", () => {
  assert.deepEqual(
    normalizeStructuredReplyPayload({ reply: "Done." }, ""),
    { reply: "Done.", artifacts: [] }
  );
});

test("buildWorkerPrompt includes retry guidance when provided", () => {
  const prompt = buildWorkerPrompt({
    systemPrompt: "system context",
    userText: "fix it",
    outboxDir: "/tmp/outbox",
    displayName: "User",
    sourceLabel: "text",
    graphContext: "",
    retryHint: TOOL_ARGUMENT_PARSE_RECOVERY_HINT,
  });

  assert.match(prompt, /Retry guidance:/);
  assert.match(prompt, /Start one fresh Codex session and retry with valid tool-call JSON\./);
});

test("isToolArgumentParseError matches duplicate-key tool argument failures", () => {
  assert.equal(
    isToolArgumentParseError(
      "2026-05-08T01:17:05.108432Z ERROR codex_core::tools::router: error=failed to parse function arguments: duplicate field `yield_time_ms` at line 1 column 291"
    ),
    true
  );
  assert.equal(isToolArgumentParseError("write_stdin failed: stdin is closed for this session"), false);
});

test("resolveRunOutboxDir falls back to tmp when primary outbox is full", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");

  const originalMkdirSync = fs.mkdirSync;
  let primaryAttempts = 0;

  t.mock.method(fs, "mkdirSync", (dirPath, options) => {
    if (String(dirPath).startsWith("/primary/outbox")) {
      primaryAttempts += 1;
      const error = new Error("no space left on device");
      error.code = "ENOSPC";
      throw error;
    }
    return originalMkdirSync.call(fs, dirPath, options);
  });

  const outboxDir = resolveRunOutboxDir("/primary/outbox", "667389795");

  assert.equal(primaryAttempts, 1);
  assert.match(outboxDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\\\]/g, "\\$&")}/myos-worker-outbox/667389795/`));
  assert.equal(fs.existsSync(outboxDir), true);

  fs.rmSync(path.join(os.tmpdir(), "myos-worker-outbox"), { recursive: true, force: true });
});

test("resolveCodexWorkerModelSelection defaults straightforward work to gpt-5.4-mini", () => {
  const originalDefault = process.env.MYOS_MODEL_PROFILE_DEFAULT;
  const originalSmart = process.env.MYOS_MODEL_PROFILE_SMART;
  const originalWrite = process.env.MYOS_MODEL_PROFILE_WRITE;
  const originalModel = process.env.MYOS_LOCAL_WORKER_MODEL;
  delete process.env.MYOS_MODEL_PROFILE_DEFAULT;
  delete process.env.MYOS_MODEL_PROFILE_SMART;
  delete process.env.MYOS_MODEL_PROFILE_WRITE;
  delete process.env.MYOS_LOCAL_WORKER_MODEL;

  try {
    const selection = resolveCodexWorkerModelSelection({
      dispatchPlan: {
        intentType: "directive",
        actionType: "read",
        route: { lane: "worker_skill" },
      },
    });

    assert.equal(selection.model, "gpt-5.4-mini");
    assert.equal(selection.profileId, "bot_default");
    assert.equal(selection.source, "routing_profile");
  } finally {
    if (originalDefault == null) delete process.env.MYOS_MODEL_PROFILE_DEFAULT;
    else process.env.MYOS_MODEL_PROFILE_DEFAULT = originalDefault;
    if (originalSmart == null) delete process.env.MYOS_MODEL_PROFILE_SMART;
    else process.env.MYOS_MODEL_PROFILE_SMART = originalSmart;
    if (originalWrite == null) delete process.env.MYOS_MODEL_PROFILE_WRITE;
    else process.env.MYOS_MODEL_PROFILE_WRITE = originalWrite;
    if (originalModel == null) delete process.env.MYOS_LOCAL_WORKER_MODEL;
    else process.env.MYOS_LOCAL_WORKER_MODEL = originalModel;
  }
});

test("resolveCodexWorkerModelSelection escalates exploratory work to gpt-5.4", () => {
  const originalDefault = process.env.MYOS_MODEL_PROFILE_DEFAULT;
  const originalSmart = process.env.MYOS_MODEL_PROFILE_SMART;
  const originalWrite = process.env.MYOS_MODEL_PROFILE_WRITE;
  const originalModel = process.env.MYOS_LOCAL_WORKER_MODEL;
  delete process.env.MYOS_MODEL_PROFILE_DEFAULT;
  delete process.env.MYOS_MODEL_PROFILE_SMART;
  delete process.env.MYOS_MODEL_PROFILE_WRITE;
  delete process.env.MYOS_LOCAL_WORKER_MODEL;

  try {
    const selection = resolveCodexWorkerModelSelection({
      dispatchPlan: {
        intentType: "exploratory",
        actionType: "read",
        requiresPlan: true,
        route: { lane: "worker_skill" },
      },
    });

    assert.equal(selection.model, "gpt-5.4");
    assert.equal(selection.profileId, "openai_heavy_reasoning");
    assert.equal(selection.source, "routing_profile");
  } finally {
    if (originalDefault == null) delete process.env.MYOS_MODEL_PROFILE_DEFAULT;
    else process.env.MYOS_MODEL_PROFILE_DEFAULT = originalDefault;
    if (originalSmart == null) delete process.env.MYOS_MODEL_PROFILE_SMART;
    else process.env.MYOS_MODEL_PROFILE_SMART = originalSmart;
    if (originalWrite == null) delete process.env.MYOS_MODEL_PROFILE_WRITE;
    else process.env.MYOS_MODEL_PROFILE_WRITE = originalWrite;
    if (originalModel == null) delete process.env.MYOS_LOCAL_WORKER_MODEL;
    else process.env.MYOS_LOCAL_WORKER_MODEL = originalModel;
  }
});

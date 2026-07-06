const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  loadCapabilityIndex,
  scoreCapabilityMatch,
  selectExecutionLane,
  shortlistCapabilities,
} = require("../src/capability-router");

function writeIndex(index) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "capability-router-"));
  const indexPath = path.join(tmpDir, "capabilities-index.json");
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  return indexPath;
}

test("selectExecutionLane chooses recipe lane for deterministic operational requests", () => {
  const indexPath = writeIndex({
    schema_version: 1,
    lanes: {},
    capabilities: [
      {
        id: "recipe:agent/godaddy/list-dns",
        execution_lane: "recipe_dispatcher",
        aliases: ["list dns", "dns records"],
        use_when: ["dns records", "list dns"],
        avoid_when: [],
        description: "List DNS records",
        priority: 50,
      },
      {
        id: "skill:architecture",
        execution_lane: "worker_skill",
        aliases: ["architecture"],
        use_when: ["architect systems"],
        avoid_when: [],
        description: "Architecture skill",
        priority: 40,
      },
    ],
  });

  const result = selectExecutionLane("update the dns records for my domain", { indexPath });
  assert.equal(result.lane, "recipe_dispatcher");
  assert.equal(result.candidates[0].capability.id, "recipe:agent/godaddy/list-dns");
});

test("selectExecutionLane does not route Decision Council mentions into workflow", () => {
  const indexPath = writeIndex({
    schema_version: 1,
    lanes: {},
    capabilities: [
      {
        id: "workflow:decision-council",
        execution_lane: "workflow",
        aliases: ["Decision Council", "hard decision", "evaluate plan", "evaluate this plan"],
        use_when: ["User asks for help making a hard decision"],
        avoid_when: [],
        description: "Decision council workflow",
        priority: 35,
      },
    ],
  });

  const result = selectExecutionLane("use Decision Council to make this decision", { indexPath });
  assert.equal(result.lane, "worker_skill");
});

test("selectExecutionLane ignores decision-council complaint prompts", () => {
  const indexPath = writeIndex({
    schema_version: 1,
    lanes: {},
    capabilities: [
      {
        id: "workflow:decision-council",
        execution_lane: "workflow",
        aliases: ["Decision Council", "hard decision", "evaluate plan", "evaluate this plan"],
        use_when: ["User asks for help making a hard decision"],
        avoid_when: [],
        description: "Decision council workflow",
        priority: 35,
      },
      {
        id: "skill:triage",
        execution_lane: "worker_skill",
        aliases: ["answer", "specific"],
        use_when: ["fix a bad answer", "routing issue"],
        avoid_when: [],
        description: "General issue triage",
        priority: 30,
      },
    ],
  });

  const result = selectExecutionLane(
    "What did you just do this is terrible this didn't give me an answer are you just use the decision council",
    { indexPath },
  );
  assert.equal(result.lane, "worker_skill");
});

test("scoreCapabilityMatch uses bounded aliases instead of substrings", () => {
  const result = scoreCapabilityMatch(
    {
      id: "agent:ai-tool",
      execution_lane: "worker_skill",
      aliases: ["ai"],
      use_when: [],
      avoid_when: [],
      description: "AI tool",
      priority: 50,
    },
    "hey what's the website for joachella that I've been working on on versail",
  );

  assert.equal(result.evidenceScore, 0);
  assert.equal(result.score, 0);
});

test("selectExecutionLane does not route hard decision prompts into Decision workflow", () => {
  const indexPath = writeIndex({
    schema_version: 1,
    lanes: {},
    capabilities: [
      {
        id: "workflow:decision-council",
        execution_lane: "workflow",
        aliases: ["Decision Council", "hard decision", "evaluate plan", "evaluate this plan"],
        use_when: ["User asks to evaluate a plan or options before deciding"],
        avoid_when: [],
        description: "Explicit decision evaluation workflow",
        priority: 35,
      },
    ],
  });

  const result = selectExecutionLane("we need to make a hard decision about this plan", { indexPath });
  assert.equal(result.lane, "worker_skill");
});

test("selectExecutionLane does not route plan evaluation prompts into Decision workflow", () => {
  const indexPath = writeIndex({
    schema_version: 1,
    lanes: {},
    capabilities: [
      {
        id: "workflow:decision-council",
        execution_lane: "workflow",
        aliases: ["Decision Council", "hard decision", "evaluate plan", "evaluate this plan"],
        use_when: ["User asks to evaluate a plan or options before deciding"],
        avoid_when: [],
        description: "Explicit decision evaluation workflow",
        priority: 35,
      },
    ],
  });

  const result = selectExecutionLane("evaluate this plan before we decide", { indexPath });
  assert.equal(result.lane, "worker_skill");
});

test("selectExecutionLane falls back to worker lane for adaptive requests", () => {
  const indexPath = writeIndex({
    schema_version: 1,
    lanes: {},
    capabilities: [
      {
        id: "skill:architecture",
        execution_lane: "worker_skill",
        aliases: ["architecture"],
        use_when: ["architect systems", "routing system"],
        avoid_when: [],
        description: "Architecture skill",
        priority: 50,
      },
    ],
  });

  const result = selectExecutionLane("help me architect a better routing system", { indexPath });
  assert.equal(result.lane, "worker_skill");
  assert.equal(result.candidates[0].capability.id, "skill:architecture");
});

test("shortlistCapabilities reads a supplied index path", () => {
  const indexPath = writeIndex({
    schema_version: 1,
    lanes: {},
    capabilities: [
      {
        id: "skill:teamwork",
        execution_lane: "worker_skill",
        aliases: ["teamwork"],
        use_when: ["multi-agent collaboration"],
        avoid_when: [],
        description: "Coordinate specialized roles",
        priority: 40,
      },
    ],
  });

  const results = shortlistCapabilities("I need multi-agent collaboration", "worker_skill", 5, { indexPath });
  assert.equal(results.length, 1);
  assert.equal(results[0].capability.id, "skill:teamwork");
  assert.equal(loadCapabilityIndex({ indexPath }).capabilities.length, 1);
});

test("scoreCapabilityMatch does not let priority create a match with zero evidence", () => {
  const result = scoreCapabilityMatch(
    {
      id: "workflow:decision-council",
      execution_lane: "workflow",
      aliases: ["Decision Council", "hard decision", "evaluate plan", "evaluate this plan"],
      use_when: ["User asks for help making a hard decision"],
      avoid_when: [],
      description: "Decision council workflow",
      priority: 35,
    },
    "what is the website for acme hq",
  );

  assert.equal(result.evidenceScore, 0);
  assert.equal(result.score, 0);
});

test("selectExecutionLane does not route factual website lookups into workflow by priority alone", () => {
  const indexPath = writeIndex({
    schema_version: 1,
    lanes: {},
    capabilities: [
      {
        id: "workflow:decision-council",
        execution_lane: "workflow",
        aliases: ["Decision Council", "hard decision", "evaluate plan", "evaluate this plan"],
        use_when: ["User asks for help making a hard decision"],
        avoid_when: [],
        description: "Decision council workflow",
        priority: 35,
      },
      {
        id: "skill:web-research",
        execution_lane: "worker_skill",
        aliases: ["website", "link"],
        use_when: ["find website", "look up links"],
        avoid_when: [],
        description: "General web and link research",
        priority: 30,
      },
    ],
  });

  const result = selectExecutionLane("what is the website for acme hq", { indexPath });
  assert.equal(result.lane, "worker_skill");
  assert.equal(result.candidates[0].capability.id, "skill:web-research");
});

test("shortlistCapabilities drops low-evidence generic capability matches", () => {
  const indexPath = writeIndex({
    schema_version: 1,
    lanes: {},
    capabilities: [
      {
        id: "skill:generic-helper",
        execution_lane: "worker_skill",
        aliases: ["help"],
        use_when: [],
        avoid_when: [],
        description: "Generic helper",
        priority: 50,
      },
    ],
  });

  const results = shortlistCapabilities("are you awake?", "worker_skill", 5, { indexPath });
  assert.equal(results.length, 0);
});

test("selectExecutionLane ignores routing complaint prompts that mention link negatively", () => {
  const indexPath = writeIndex({
    schema_version: 1,
    lanes: {},
    capabilities: [
      {
        id: "agent:events-manager",
        execution_lane: "worker_skill",
        aliases: ["events-manager", "events"],
        use_when: ["Direct command need: research, health, status"],
        avoid_when: [],
        description: "Project manager for User's live events and EventSchedule platform.",
        priority: 50,
      },
      {
        id: "skill:broken-link-checker",
        execution_lane: "worker_skill",
        aliases: ["broken-link-checker"],
        use_when: ["check broken links"],
        avoid_when: [],
        description: "Scans a directory for broken links.",
        priority: 40,
      },
    ],
  });

  const result = selectExecutionLane(
    "The routing is messed up on this. this is a command I'm not asking for a link log your mistake and fix it",
    { indexPath },
  );
  assert.equal(result.lane, "worker_skill");
  assert.equal(result.reason, "default_worker_skill");
  assert.deepEqual(result.candidates, []);
});

test("selectExecutionLane ignores bad routing error prompts that mention project context words", () => {
  const indexPath = writeIndex({
    schema_version: 1,
    lanes: {},
    capabilities: [
      {
        id: "agent:participant-records",
        execution_lane: "worker_skill",
        aliases: ["participant-records", "acme", "airtable"],
        use_when: ["Local DB sync for acme participants from Airtable", "Direct command need: sync"],
        avoid_when: [],
        description: "Local DB sync for acme participants from Airtable",
        priority: 50,
      },
      {
        id: "skill:acme-testimonial-questions",
        execution_lane: "worker_skill",
        aliases: ["acme-testimonial-questions"],
        use_when: [],
        avoid_when: [],
        description: "Use when User asks for the Acme testimonial questions.",
        priority: 40,
      },
    ],
  });

  const result = selectExecutionLane(
    "same bad routing error. I understand why it's happening it sees the context very quickly that it has a acme in the word testimonial it's not reading the whole context of the request. need to fix this in the routing",
    { indexPath },
  );
  assert.equal(result.lane, "worker_skill");
  assert.equal(result.reason, "default_worker_skill");
  assert.deepEqual(result.candidates, []);
});

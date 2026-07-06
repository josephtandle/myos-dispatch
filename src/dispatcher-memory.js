const fs = require("node:fs");
const path = require("node:path");
const { resolveWorkspacePath } = require("./myos-compat");

const DATA_DIR = resolveWorkspacePath("agents", "shared", "data");
const EVENTS_FILE = path.join(DATA_DIR, "dispatcher-events.jsonl");
const { recordDispatcherHealthEvent } = require("./promotion/dispatcher-health-policy");

function appendDispatcherEvent(event) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(EVENTS_FILE, `${JSON.stringify(event)}\n`, "utf8");
  } catch (error) {
    console.error(`[dispatcher] Failed to append event log: ${error.message}`);
  }
  try {
    recordDispatcherHealthEvent({
      source: "dispatcher",
      ...event,
    });
  } catch (error) {
    console.error(`[dispatcher] Failed to record health event: ${error.message}`);
  }
}

module.exports = {
  EVENTS_FILE,
  appendDispatcherEvent,
};

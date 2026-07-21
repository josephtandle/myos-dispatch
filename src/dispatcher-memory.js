const fs = require("node:fs");
const path = require("node:path");
const { resolveWorkspacePath } = require("./myos-compat");

const DATA_DIR = resolveWorkspacePath("agents", "shared", "data");
const EVENTS_FILE = path.join(DATA_DIR, "dispatcher-events.jsonl");
const { recordDispatcherHealthEvent } = require("./promotion/dispatcher-health-policy");

function resolveEventsFile() {
  return process.env.MYOS_DISPATCHER_EVENTS_FILE || EVENTS_FILE;
}

function appendDispatcherEvent(event) {
  try {
    const eventsFile = resolveEventsFile();
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    fs.appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, "utf8");
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

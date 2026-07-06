const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("dispatch fastpath audit rejects non-string target_id even without target_type", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-fastpath-audit-"));
  const workspaceRoot = path.join(tmpDir, ".myos", "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "TOOLS.md"), "# Tools\n", "utf8");
  fs.writeFileSync(
    path.join(workspaceRoot, "DISPATCH-FASTPATHS.json"),
    JSON.stringify({
      fastpaths: [
        {
          intent: "bad target id",
          match_terms: ["bad target"],
          reference_path: "TOOLS.md",
          target_id: 123,
          added_at: "2026-05-15",
          last_seen_at: "2026-05-15",
        },
      ],
    }),
    "utf8",
  );

  const result = spawnSync("node", ["scripts/audit-dispatch-fastpaths.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, HOME: tmpDir },
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /target_id must be a string when present/);
});

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveRepositoryTarget,
} = require("../src/repository-targets");

function initRepo(repoPath) {
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoPath });
}

test("configured nested repository aliases select one authoritative write target", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "myos-repo-target-"));
  const projectsDir = path.join(workspaceRoot, "projects");
  const portal = path.join(workspaceRoot, "projects", "mastermind", "portal");
  const homepage = path.join(workspaceRoot, "projects", "mastermind", "homepage");
  initRepo(portal);
  initRepo(homepage);
  fs.mkdirSync(projectsDir, { recursive: true });
  const indexPath = path.join(projectsDir, "_index.json");
  fs.writeFileSync(indexPath, JSON.stringify({
    projects: {
      mastermind: {
        repositories: [
          { id: "portal", path: "projects/mastermind/portal", aliases: ["course portal"] },
          { id: "homepage", path: "projects/mastermind/homepage", aliases: ["public homepage"] },
        ],
      },
    },
  }), "utf8");

  const target = resolveRepositoryTarget(
    "Fix the course portal session view",
    { projectSlug: "mastermind", searchScope: path.join(workspaceRoot, "projects", "mastermind") },
    { workspaceRoot, projectIndexPath: indexPath },
  );
  assert.equal(target.authoritative, true);
  assert.equal(target.primaryTarget.id, "portal");
  assert.equal(target.taskScope, portal);
  assert.equal(target.writableSafe, true);
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test("repository routing fails closed when scope is absent or nested target is ambiguous", () => {
  const absent = resolveRepositoryTarget("Fix it", {}, {});
  assert.equal(absent.reason, "no_repository_scope");
  assert.equal(absent.writableSafe, false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myos-repo-ambiguous-"));
  initRepo(path.join(root, "a"));
  initRepo(path.join(root, "b"));
  const ambiguous = resolveRepositoryTarget("Fix the project", { searchScope: root }, {});
  assert.equal(ambiguous.reason, "ambiguous_repository_target");
  assert.equal(ambiguous.writableSafe, false);
  fs.rmSync(root, { recursive: true, force: true });
});

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const WRITE_VERBS = new Set(["commit", "merge", "push", "cherry-pick", "revert", "am", "rebase", "pull"]);

// The shell expands these before git runs; the hook sees them literally.
function expandHome(dir, env = process.env) {
  const home = env.HOME || os.homedir();
  return dir.replace(/^~(?=$|\/)/, home).replace(/^\$(?:HOME|\{HOME\})(?=$|\/)/, home);
}

function gitWriteTarget(command) {
  if (typeof command !== "string") return null;
  const tokens = command.match(/&&|\|\||[;|]|(?:"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|\\.|[^\s;&|"'\\])+/g) || [];
  let dir = "";
  let words = [];
  for (const token of [...tokens, ";"]) {
    if (!["&&", "||", ";", "|"].includes(token)) {
      words.push(token.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|\\(.)/g,
        (_, double, single, escaped) => double === undefined ? single ?? escaped : double.replace(/\\(["\\$`])/g, "$1")));
      continue;
    }
    if (words[0] === "cd" && words.length === 2 && token === "&&") {
      const next = expandHome(words[1]);
      dir = path.isAbsolute(next) ? next : path.join(dir, next);
    } else if (words[0] === "git") {
      let gitDir = dir;
      let i = 1;
      for (; i < words.length && words[i].startsWith("-"); i++) {
        const option = words[i];
        if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(option)) {
          const value = words[++i];
          if (value === undefined) return null;
          if (option === "-C") gitDir = path.isAbsolute(expandHome(value)) ? expandHome(value) : path.join(gitDir, value);
        } else if (option.startsWith("-C")) {
          const value = option.slice(2);
          gitDir = path.isAbsolute(value) ? value : path.join(gitDir, value);
        }
      }
      const verb = words[i];
      const args = words.slice(i + 1);
      let writes = WRITE_VERBS.has(verb);
      if (["checkout", "switch"].includes(verb)) writes = args.some(arg => /^-[bBcC]/.test(arg));
      if (verb === "tag") {
        let hasName = false;
        let listsOrDeletes = false;
        for (let j = 0; j < args.length; j++) {
          const arg = args[j];
          if (/^--(?:list|delete|verify)(?:=|$)/.test(arg) || /^-[^mFu-]*[ldv]/.test(arg)) listsOrDeletes = true;
          if (["-m", "-F", "-u", "--message", "--file", "--local-user"].includes(arg)) j++;
          else if (!arg.startsWith("-")) hasName = true;
        }
        writes = hasName && !listsOrDeletes;
      }
      if (writes) return { verb, dir: gitDir || null };
    }
    words = [];
  }
  return null;
}

function realpathOrOriginal(dir, fsImpl) {
  try { return fsImpl.realpathSync(dir); } catch { return dir; }
}

function findRepoTop(dir, fsImpl = fs) {
  let top = path.resolve(dir);
  for (let level = 0; level < 64; level++) {
    const gitEntry = path.join(top, ".git");
    let stat;
    try { stat = fsImpl.statSync(gitEntry); } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    }
    if (stat) {
      let primary = top;
      if (stat.isFile()) {
        const match = fsImpl.readFileSync(gitEntry, "utf8").trim().match(/^gitdir:\s*(.+)$/);
        if (!match) return null;
        const gitDir = path.resolve(top, match[1]);
        try {
          const common = path.resolve(gitDir, fsImpl.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
          if (path.basename(common) === ".git") primary = path.dirname(common);
        } catch (error) {
          if (error.code !== "ENOENT") return null;
        }
      } else if (!stat.isDirectory()) return null;
      return { top: realpathOrOriginal(top, fsImpl), primary: realpathOrOriginal(primary, fsImpl) };
    }
    const parent = path.dirname(top);
    if (parent === top) break;
    top = parent;
  }
  return null;
}

function claimNudge({ command, cwd, sessionId, env = process.env, stateDir, now = Date.now(), fsImpl = fs }) {
  try {
    if (env.MYOS_GIT_CLAIM_NUDGE === "0") return null;
    const target = gitWriteTarget(command);
    if (!target) return null;
    const repo = findRepoTop(path.resolve(cwd, target.dir || "."), fsImpl);
    if (!repo) return null;
    const claimsFile = env.MYOS_GIT_CLAIMS_FILE || path.join(env.MYOS_WORKSPACE || path.join(os.homedir(), ".myos", "workspace"), "agents", "git-manager", "data", "claims.json");
    const store = JSON.parse(fsImpl.readFileSync(claimsFile, "utf8"));
    if (store?.schemaVersion !== 1 || !Array.isArray(store.enforcedRepos) || !Array.isArray(store.claims)) return null;
    if (!store.enforcedRepos.includes(repo.primary)) return null;
    if (store.claims.some(claim => {
      if (claim?.status !== "active" || typeof claim.worktree !== "string" || !path.isAbsolute(claim.worktree)) return false;
      const relative = path.relative(claim.worktree, repo.top);
      return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    })) return null;

    // State is best-effort; a failed write must not suppress the advisory.
    if (sessionId && stateDir) {
      const safeId = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 128);
      const file = path.join(stateDir, `${safeId}.json`);
      let nudged = [];
      try {
        const state = JSON.parse(fsImpl.readFileSync(file, "utf8"));
        if (Array.isArray(state.nudged)) nudged = state.nudged;
      } catch {}
      if (nudged.includes(repo.primary)) return null;
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        fsImpl.mkdirSync(stateDir, { recursive: true });
        fsImpl.writeFileSync(tmp, JSON.stringify({ nudged: [...nudged, repo.primary], updatedAt: now }));
        fsImpl.renameSync(tmp, file);
        for (const entry of fsImpl.readdirSync(stateDir)) {
          if (!entry.endsWith(".json")) continue;
          try {
            const old = path.join(stateDir, entry);
            if (now - fsImpl.statSync(old).mtimeMs > 7 * 24 * 60 * 60 * 1000) fsImpl.unlinkSync(old);
          } catch {}
        }
      } catch {
        try { fsImpl.unlinkSync(tmp); } catch {}
      }
    }
    return `[MyOS git check-in] First git ${target.verb} in ${repo.primary}${repo.top !== repo.primary ? ` (worktree ${repo.top})` : ""} this session with no git-manager claim. Check in first: git-manager start ${repo.primary} --task <slug> (creates a worktree, owner-prefixed branch and claim; POLICY.md rule 10). Advisory only: this command is not blocked.`;
  } catch {
    return null;
  }
}

module.exports = { gitWriteTarget, findRepoTop, claimNudge };

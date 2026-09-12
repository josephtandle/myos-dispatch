# Claude and Codex coauthoring

Claude can delegate one bounded implementation to Codex and receive a patch for independent review. This is an explicit human-interactive contract, not a general cross-provider sidecar permission.

## Agree before writing

1. Name the human goal, acceptance checks, exact model, repository, and owned paths.
2. Assign **one owner per file**. Do not run conflicting writes simultaneously, including in the source checkout. Split disjoint work between writers; the parent orchestrator owns all fan-out.
3. Name an independent verifier. The writer can report tests, but cannot approve its own patch. Claude may coordinate and review; Claude writable mode remains disabled.
4. Start from a clean repository with a committed HEAD. Finish or preserve existing changes yourself; this command does not stash, reset, clean, or commit them.

## Delegate once

From the installed Dispatch directory (or use `myos-writer` when the package bin entry is installed):

```sh
node bin/myos-writer.js --scope /absolute/path/to/repo \
  --paths src/example.js,test/example.test.js \
  --provider codex --model gpt-6-astra --caller-provider claude \
  --prompt "Implement the agreed change in the owned files. Run the agreed tests and report real results." \
  --json
```

`--prompt-file /path/task.txt` replaces `--prompt`. Exactly one is required, with a maximum of 32768 bytes. Paths are literal repository-relative files or directories, comma separated; no globs, repository-wide scope, traversal, Git internals, or symlink ownership. Scope must be the repository root. Unknown and duplicate arguments fail. There is no `--apply`, arbitrary command, config, environment override, billing fallback, or model fallback option.

`--timeout-ms` accepts an integer from 1 to 1800000 milliseconds. The default is 900000 (15 minutes); use `--timeout-ms 1800000` for a 30-minute bound. This CLI declares `taskClass: "heavy_synthesis"` while preserving the exact requested model. The timeout bounds provider execution; process cleanup can take up to four additional seconds, followed by artifact collection.

The CLI supplies this runner contract alongside the task's ownership paths:

```json
{
  "callerProvider": "claude",
  "workerProvider": "codex",
  "purpose": "code-write",
  "context": "human-interactive"
}
```

For an embedding, pass the object as `options.delegation`, also declare `options.callerProvider`, and request `task.mode: "workspace_write"`. Use `runBackgroundTasks` with an orchestrator context so quarantine and backpressure apply. Every caller must now declare its provider, including ordinary same-provider read-only calls. Omitting the caller cannot bypass affinity. The declaration is a trusted orchestrator assertion, not authentication or proof of a human's identity.

Embedding caller declarations accept the recognized names `codex`, `claude`, and `gemini`, executable paths, and the aliases `claude-code`, `claude_code`, `gemini-cli`, and `gemini_cli` (including `.exe`, `.cmd`, or `.bat` suffixes). Missing or unknown names fail closed. The dispatcher can take a caller from an explicit `callerProvider`, `workerCommand`, or worker `request.fallback.command`; `backgroundWorkerCommand` never establishes the root caller. The public delegation CLI still requires `--caller-provider claude` and `--provider codex`.

Cross-provider research, general sidecars, bot/unattended contexts, protected surfaces, nested workers, and caller/worker mismatches are refused. Existing global/writable disable switches, OAuth environment scrubbing, quarantine, disk/load checks, and concurrency limits remain active. If your environment disables background agents, the command fails; it does not override that policy or install a scheduler.

## Read the handback honestly

A successful writer run returns `status: "needs-review"`, never approval to integrate. Failures return `status: "failed"` and exit code 1. `reviewRequired` is always true. The result includes:

- `requestedModel` and `resolvedModel`: the explicit model requested and passed to the CLI, without substitution.
- `providerReportedModel`: a model explicitly reported in provider events, or `null` when the provider does not report it. A requested or resolved model is not proof of the actual served model. A reported mismatch fails the handback.
- `baseSha`, `ownershipPaths`, `changedFiles`, `ownedChangedFiles`, and any `ownershipViolations`.
- `patchArtifact`, its `patchSha256`, `manifestArtifact`, and retained `worktreePath`.
- `verificationEvidence`: runner patch integrity/applicability evidence, provider response validation, writer-reported checks, and independent review still pending. A reverse-apply check does not prove the feature works.

Patches preserve binary bytes and new files. Capture uses a separate temporary index and leaves the writer's index intact. Every worktree is retained, including failure, timeout, quota, malformed output, and ownership violations; failed patches are evidence only. Ignored files remain in the retained worktree and are not included by Git's ordinary add rules. Artifact directories are unique, outside the source checkout, and default to `~/.myos/state/myos-dispatch/sidecar-artifacts`. Retained worktrees are under the OS temporary directory: preserve them elsewhere before OS/manual cleanup if they contain needed ignored or partial work. There is no age-based deletion.

On POSIX, each provider starts in its own process group. Timeout or normal parent exit starts teardown: TERM, a two-second grace period, then KILL if the group remains. Parent exit and closed output pipes do not prove completion; the runner also waits until the owned group no longer exists. If that cannot be verified within the four-second cleanup bound, the result has `cleanupFailed: true`, status `failed`, and no patch capture. Preserve and inspect the retained worktree; it may still be changing. This controls descendants that remain in the owned group, not processes that deliberately escape into a new session. Windows writable execution is refused before allocation because scoped process-tree control is not implemented.

Codex loads host configuration and hooks and uses its existing ChatGPT OAuth context. The runner pins `forced_login_method="chatgpt"`, `model_provider="openai"`, workspace-write networking off, and no additional writable roots, without `--ignore-user-config`. The authentication restriction is documented in the [Codex configuration reference](https://developers.openai.com/codex/config-reference/). Claude read-only invocations omit `--bare`, which local CLI help documents as disabling hooks and OAuth. Missing authentication, unavailable models, or host hook/trust failures must be resolved by the human; no automatic login or token repair is performed by this command.

## Independent review and orchestrator integration

1. Preserve the JSON result and patch. Record the hash outside the mutable writer worktree; changing both a patch and an adjacent manifest cannot establish trust.
2. Recompute SHA256 and compare it with the exact handback hash. The exported `verifyPatchArtifact(file, expectedSha256)` throws on mismatch. Recheck immediately before any application. Any byte change invalidates earlier review.
3. Have a verifier other than the writer review the exact patch, every changed path, binary/new files, and the acceptance criteria. Reproduce the relevant tests in a separate clean review checkout at `baseSha`; do not rely solely on the writer's `checks` text.
4. Record the verifier identity, exact SHA256, base SHA, approved paths, commands, and observed outcomes. A writer's statement that it reviewed itself is not this record.
5. The parent orchestrator alone may integrate after confirming the target HEAD still equals `baseSha`, the target and ownership paths are clean, all changed paths are owned, the recorded hash still matches, and no conflicting writer is active. Run `git apply --check` before applying the reviewed patch. If HEAD or content changed, prepare and independently review a new patch against the new base.
6. Verify the integrated behavior before committing or publishing under the project's normal process. Retire retained work only after the parent confirms integration or explicit preservation. This CLI implements none of these application or cleanup steps.

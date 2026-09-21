# OAuth recovery acceptance, 2026-09-21

MyOS Dispatch 4.2.0 is installed in /Users/myos/myos-dispatch, the source used by desktop hooks and the MyOS wrapper. Implementation commit: 5a78e22. API upgrade and external publication remain out of scope.

## Implemented

- Exact model identity, registered OAuth task-class defaults, explicit read-only unsupported-model fallback and class-appropriate reasoning effort. Pins, intent routes and lane assignments retain priority. Writers and auth/quota failures do not retry.
- Foreground and sidecar execution use ChatGPT-only CLI transport, bounded owned-process cleanup, output validation and successful requested-model invocation receipts. Receipts are not provider-attested identity or task-quality benchmarks.
- Failure-triggered, coalesced doctor refresh with official paginated Codex metadata, cache fallback, provider auth provenance, atomic revisions, last-good snapshots and macOS dead-owner locks. No weekly jobs, automatic login, credential extraction or billing changes.
- The wrapper's TUI misclassification is repaired by starting OAuth argv with exec. API argv and execution plans remain unchanged.
- Warm-first local Qwen routing preserves existing offline-cache, memory-pressure, idle-unload and backoff controls. No permanent RAM residency or login autostart.

## Tests and review

- Full isolated Node 24 release suite: 881 tests, 862 passed, zero failed, 19 skipped. Focused integration run: 106/106 passed. New OAuth suites: 25/25 passed.
- Initial broad failures were traced to inherited MYOS_HOME_ROOT, Node 26 where search tests require Node 24, concurrent timing pressure, and Homebrew's group-writable ancestor directory. Tests passed with the live root unset, serial execution and a private Node 24 runtime copy. Safety checks and assertions were not weakened.
- Reproduction: env -u MYOS_HOME_ROOT MYOS_OAUTH_RECOVERY=0 MYOS_BACKGROUND_BACKPRESSURE_ENABLED=0 MYOS_TEST_NODE24=/Users/myos/.config/myos/node24-validation.OEiSWP/node /Users/myos/.config/myos/node24-validation.OEiSWP/node --test --test-concurrency=1 test/*.test.js
- Independent reviews found unchecked legacy fallback, stale-lock handling, waiter deadlines, premature/missing receipts, removed-model eligibility, lane override replacement and stale queued fallbacks. Each received a targeted fix and regression coverage. API transport crossover was not found.
- GitNexus change detection covered the exact staged worktree. Shared execution helpers have critical graph reach; changes remain OAuth-gated and API regression tests pass. Simplification inspection found no additional worthwhile behavior-preserving change.

## Installed-path readback

- myos-oauth-doctor resolves through ~/.local/bin to /Users/myos/myos-dispatch/bin/myos-oauth-doctor.js.
- Installed doctor reports version 4.2.0, 25 inventory records, Codex subscription authentication and codex-app-server discovery provenance.
- Installed foreground Luna returned INSTALLED_OAUTH_OK in 9.834 seconds, after safely skipping cold Qwen.
- Installed Sol planning sidecar returned INSTALLED_SIDECAR_OK in 8.672 seconds.
- Earlier worktree Luna and Sol canaries also passed. Only actual successful invocation evidence is retained; all qualityValidated flags remain false.

## Local/provider limits

- Claude CLI reports unavailable subscription login in this process context. Antigravity auth provenance remains unknown. Their discovered names are not automatically enabled fallbacks. Neither an account-wide logout nor free billing is inferred.
- Text-only OAuth does not implement audio transcription or speaker diarization. No text model is misrepresented as an audio engine.
- Qwen revision 1e20fd8d42056f870933bf98ca6211024744f7ec is restored in external storage. All four weight SHA-256 hashes matched the pinned metadata; config, tokenizer, weight index and offline main resolution passed.
- Live guarded Qwen startup refused at 4.77 GiB free versus 28 GiB required. Inference quality is therefore not claimed. Existing pressure backoff was honored, not bypassed. The cloud path remains available while local memory is constrained.
- Future unknown models are registered but not assigned task classes without evaluation. Non-macOS stale locks require operator recovery; native Windows inference requires WSL.

## Preservation and delivery

The pre-upgrade active checkout was clean at 3cc1efe. Verified Git bundle, tracked working-tree archive and byte-identical index backup are at /Users/myos/.config/myos/oauth-upgrade-backup.A7o6au. Integration was fast-forward only. No reset, cleanup or source deletion occurred.

Private Uni/Juno runtime, native agent profiles and All Sorted distribution files were not changed. The private workspace retains unrelated concurrent changes. No publication or API migration was performed.

# OAuth execution and recovery upgrade

## What / why

Optimize foreground MyOS work for time to accepted result using available subscription and local execution. Register discovery honestly, preserve exact model identity, and recover from model failures without changing API routes.

## Approach

Add an OAuth registry, discovery adapters, bounded CLI transport and failure-triggered doctor under src/runtime/oauth/. Integrate at the public runtime foreground OAuth branch, preserving explicit pins, intent overrides and the existing local-provider bridge. Registry records distinguish discovery from invocation and task-quality evidence. Persist model-specific failure state and atomic snapshots with concurrency protection. Add manual scan/doctor entrypoints, no weekly job. Restore exact Qwen weights to external storage and preserve loader/unloader controls. Reuse existing provider CLI credentials, never copy tokens.

Alternative rejected: rewriting shared API profiles or private bot runtime would widen the authorized change and could alter protected consumers.

## Acceptance criteria

- Explicit model IDs are preserved; unsupported IDs never silently become another model.
- Foreground OAuth default classes use appropriate model/effort and bounded fallback chains.
- Discovered models remain distinct from validated execution and quality evidence.
- Failures trigger coalesced inventory refresh and model-scoped quarantine without credential or billing changes.
- API plans and execution remain unchanged; private Uni/Juno files are untouched.
- Local cache is complete and integrity-checked; inference respects existing memory gates.
- Hermetic failure injection and safe foreground live canaries validate the actual installed path.

## The check

Run focused OAuth registry/recovery tests, existing routing/local-provider suites, independent review, then installed CLI discovery/readback and bounded foreground canaries. Record any blocked provider or modality explicitly rather than claiming it working.

## Out of scope

Paid API upgrade, hidden extra-credit purchases, credential extraction, automatic login, externally published releases, and protected Uni/Juno behavior changes. No recurring job is needed for failure-triggered repair.

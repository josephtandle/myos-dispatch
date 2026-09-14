# @myos/local-search

`@myos/local-search` is a local-only, bounded file catalogue and search CLI. It is disabled unless an explicit owner-only configuration enables it. It has no home-directory defaults, never changes original files, makes no model API calls, and does not download dependencies or models at runtime.

Version 1.3.1 restores `auto` as the desktop assistant's default so content and general questions retain exact-identifier, phrase, lexical, and optional semantic relevance signals. `native` remains available as an explicit fast option, but does not guarantee equivalent retrieval quality. The local discovery/reconciliation path batches provisional macOS residency checks in bounded, query-scoped groups before fresh verification; this is a mechanical overhead correction, not an unproven benchmark claim.

Technical screening has shipped, and the public fixture has been tested on a second Mac. Those checks do not prove whole-OS coverage, held-out retrieval quality, or a general performance upgrade. The package remains experimental and opt-in.

## Requirements and configuration

The package has its own Node 24 runtime boundary; the parent Dispatch repository continues to support its declared Node `>=20` range. The installed wrapper therefore requires an explicit absolute Node 24 executable and never imports this package into the parent runtime. Provide an absolute config path. `configure` writes it atomically with mode `0600`:

```sh
myos-local-search --node24 /absolute/path/to/node24 configure \
  --config /absolute/private/local-search.json \
  --request /absolute/config-request.json
```

`myos-local-search --help` is available on the parent runtime without a configuration or Node 24 path. The wrapper verifies the selected executable reports major version 24, forwards arguments without a shell, preserves nested JSON output and exit status, and relays SIGINT/SIGTERM to the foreground CLI.

A configuration contains `enabled`, an absolute `stateDirectory` outside all source roots, and approved roots shaped as `{id,path,contentEnabled,extensions,maxFiles,maxFileBytes}`. There are no root or whole-home defaults. Budgets are finite; results cap at 8 and packet content defaults to 12,000 bytes. `maxTokens` is an estimate-only limiter using an explicitly labelled character heuristic, not a tokenizer or hard token guarantee.

The default storage policy caps state plus configured external models, counted once by filesystem identity, at 20 GiB. A write must also leave at least `max(20 GiB, 10% of filesystem capacity)` free. Resource admission permits one heavy-inference slot per state directory. Its memory check is an admission estimate based on available memory, model size, and fixed overhead, not an RSS ceiling or process memory guarantee. Heavy hashing and embedding require the configured idle and healthy dwell. Bounded metadata refresh may continue while the user is active and during those dwell periods, but pauses on battery, under thermal pressure, or when the background probe fails.

Optional QMD configuration points to an externally provisioned Node executable, the pinned QMD 2.8.3 package root, and absolute local `.gguf` model paths. Optional SHA-256 hashes are verified before use. Runtime never invokes `npx`, fetches models, or inherits API keys/proxy variables. On macOS every QMD operation runs under `/usr/bin/sandbox-exec` with network denied. Queries call SDK `searchLex` or `searchVector` directly; they never invoke expansion, generation, or reranking. If strict network enforcement is unavailable, QMD search is unavailable and the current exact lexical overlay remains usable.

## Operations

```sh
myos-local-search --node24 /absolute/path/to/node24 status --config /absolute/local-search.json
myos-local-search --node24 /absolute/path/to/node24 index --config /absolute/local-search.json
myos-local-search --node24 /absolute/path/to/node24 search --config /absolute/local-search.json --query phrase --mode auto --roots docs --format json
myos-local-search --node24 /absolute/path/to/node24 read --config /absolute/local-search.json --source-id SOURCE_ID --format evidence
myos-local-search --node24 /absolute/path/to/node24 watch --config /absolute/local-search.json
```

JSON is the default output format, and the programmatic API is unchanged. `search` and `read` accept `--format json|evidence`. Evidence output is only used for piped output and consists of UTF-8 byte-length frames whose bodies are emitted verbatim. An interactive TTY request for evidence falls back to safe JSON. Framing is a transport boundary, not a hard output-token cap. `--request /absolute/request.json` can replace individual search/read arguments. Unknown flags, root IDs, duplicate roots, traversal, and out-of-bounds values fail closed. `watch` is a foreground process using filesystem notifications plus non-overlapping periodic reconciliation; it is not a daemon.

### Native-first discovery

Version 1.3.1 keeps explicit `--mode native` for bounded fast discovery without QMD. The desktop assistant defaults to `auto`; `filename` is for locating a known file, while `keyword`, `semantic`, and `auto` retain their existing meanings. A blank query or invalid mode is refused before search begins.

Native filename hits are metadata-only and do not carry a content hash. Before opening one, the UI separately reruns exact-path metadata checks inside the configured root. Content hits carry a hash; the UI uses the public `read` path and refuses to open the file if the fresh hash, root ID, or relative path no longer matches. Partial results and empty results with incomplete coverage do not establish absence.

Automatic technical screening is shipped, optional, and never configures roots automatically. A changed file hash is refused until a completed screening refresh validates its replacement; a hash change alone is never published. Permanent exclusions, read-time enforcement, and a durable disable-and-revoke protocol remain enforced release boundaries.

### Optional desktop assistant export

The current companion implementation is `packages/local-search/desktop-find.js` in the reviewed desktop integration. Its owner-only `0600` settings file has exactly this schema:

```json
{
  "version": 1,
  "enabled": true,
  "node24": "/absolute/path/to/node24",
  "configPath": "/absolute/private/local-search.json",
  "exportToAssistant": false
}
```

`myos-find search` defaults to 3 results, 1024 snippet bytes, and a 4096-byte whole response. These are defaults, not hard limits: validated requests may ask for up to 8 results and larger bounded byte budgets. With `exportToAssistant: false`, `myos-find search` refuses with `notOptedIn`. The direct CLI and local Terminal UI remain independently available because they are separate commands, not a local mode of `myos-find`.

### Optional Dispatch launcher and local Terminal UI

The distribution includes `myos-search-dispatch`, a disabled-by-default discovery and launcher bridge. It requires a separate Dispatch core and an owner-only regular settings file. Use portable absolute paths and create the file disabled first:

```json
{
  "version": 1,
  "enabled": false,
  "node24": "/absolute/path/to/node24",
  "configPath": "/absolute/private/local-search.json"
}
```

```sh
myos-search-dispatch --dispatch-root /absolute/separate/dispatch-core --settings /absolute/owner-private/local-search-dispatch.json describe
myos-search-dispatch --dispatch-root /absolute/separate/dispatch-core --settings /absolute/owner-private/local-search-dispatch.json status
myos-search-dispatch --dispatch-root /absolute/separate/dispatch-core --settings /absolute/owner-private/local-search-dispatch.json open
```

After reviewing both absolute paths, change only `enabled` to `true` to opt in. The enabled settings are exactly `{ "version": 1, "enabled": true, "node24": "/absolute/path/to/node24", "configPath": "/absolute/private/local-search.json" }`. Disabled or invalid settings fail before local-search configuration loads, writes, or child-process creation. The bridge reads the normal Dispatch capability authority, adds a private ephemeral overlay containing only `local:search-launcher`, and uses the real `resolveDispatchPlan` path to select that fixed capability. There is no automatic or global route, hook, or hosted-content path. The launched child is always the packaged sibling `myos-search.js`; Dispatch core is not bundled inside this local-search module.

`describe`, `status`, and `open` are the only bridge operations. `open` starts the interactive UI in macOS Terminal; searches and their results remain there. Setup records no root until metadata consent is explicit, and content indexing has its own consent. QMD setup asks only for the embedding model used by semantic search. The UI can run lexical-only without a model.

Each search prints its packet status, scan budget, unavailable-source count, semantic state, and negative-result qualification. A partial or unavailable zero-result response is not presented as proof that a file is absent. Before opening a content hit, the UI reads it again and compares its SHA-256 hash with the displayed result. A changed file requires a fresh search and selection. Metadata-only hits use exact-path metadata verification inside the configured root and do not ingest file content.

`watchstart` runs a manual foreground watcher owned by the current Terminal session. Closing the session, EOF, SIGINT, SIGTERM, or SIGHUP cancels active work and drains an owned watcher before exit. It does not install a service or persistent daemon. `status` checks prerequisites and saved state only; it is not proof of successful inference or current search coverage.

Watcher startup, filesystem signals, and periodic ticks run serialized reconcile/stage/update/embed maintenance rather than trusting saved readiness. Default maintenance is one bounded network-denied Node 24 worker; that worker owns a stable SQLite `BEGIN IMMEDIATE` mutex while it publishes pending state, stages, calls the QMD SDK `update`/`embed` methods, closes the store, disposes model state, and only then publishes readiness. SQLite crash recovery releases ownership without lock-file deletion. Process execution has a configured timeout, but after termination `stop()` waits for the owned process group to disappear and that cleanup wait has no absolute terminal bound. `status` is passive: it reports persisted catalogue freshness without reconciling, while its QMD status performs prerequisite probes only; it does not establish successful inference. Queries reconcile only selected roots within deadline, file-count, and aggregate content-byte budgets, and never publish over maintenance state. Every selected source is opened and verified again immediately before packet emission. QMD paths are accepted only through opaque content-bound staging names in a manifest; stale hashes and arbitrary QMD paths are discarded. A snapshot only describes what was verified through packet emission and cannot guarantee a file stays unchanged afterward.

### Experimental opt-in persistent service API

The implemented persistent-service interface is experimental and opt-in. It is not part of the default foreground `watch` or Terminal UI behavior:

```sh
myos-search-service --node24 /absolute/path/to/node24 enable --config /absolute/local-search.json --confirm
myos-search-service --node24 /absolute/path/to/node24 disable --config /absolute/local-search.json
myos-search-service --node24 /absolute/path/to/node24 status --config /absolute/local-search.json
```

This interface is for a logged-in macOS user's LaunchAgent only. Installation must not create a system daemon, and `enable` requires an already-enabled configuration plus explicit confirmation. An enable acknowledgement does not mean the index is ready. Paused, degraded, or stale-heartbeat state is not healthy. Disable the service before uninstalling or relocating its runtime. Disabling retains source files, configuration, index state, and models.

On 2026-09-13, an installed service using private, non-Documents synthetic runtime, configuration, and state locations acknowledged startup. Its exact owned PID `67106` was sent `SIGKILL`; launchd restarted it as PID `67699` after 30 seconds. Disabling the service then verified its absence while preserving the configured sources and configuration. The runtime test root remains private and is not a public documentation path.

A separate attempt with runtime, configuration, and state under Documents failed with `startupAckTimeout`; rollback verified the service was absent. This result is consistent with macOS background privacy restrictions, but does not prove that cause. For service use, choose an explicit private directory outside cloud storage, Desktop, and Documents for runtime, configuration, and state. Respect macOS file permissions. Do not change permissions or bypass TCC to make the service run. The exercise did not prove behavior across login or logout, index readiness, or a performance improvement.

## Scope and limits

Metadata is catalogued only for permitted ordinary files. Content search supports resident UTF-8 Markdown, text, JSON, YAML, VTT, and SRT files when `contentEnabled` is true.

The implemented experimental Office integration uses an optional parser object with an absolute `pythonPath` to an externally installed isolated Python. Parsing remains opt-in for approved `.docx`, `.pptx`, and `.xlsx` roots and provides bounded, partial native-format coverage. It requires externally provided `python-docx==1.2.0`, `python-pptx==1.0.2`, `openpyxl==3.1.5`, `lxml==6.1.1`, and `pypdf==6.10.0`; the runtime does not install or download them. On macOS, tests against the installed All Sorted integration passed across its Node 22 to Node 24 boundary for DOCX, PPTX, and XLSX hashing and native locators. PDF remains filename-only on macOS because parsing is refused with `UNSUPPORTED_SAFETY_BOUNDARY`; this is not a PDF-readiness claim.

Parser results are admitted only after the final original-content hash, parser identity, and parser fingerprint pass validation. Semantic passages use validated QMD UTF-16 chunk positions and extracted-text hashes, then reverify the source bytes before emission. Native `sourceLocators` values identify document structures. For Office files, a native segment is clipped to the validated extracted-text passage. An `extractedTextLocator` refers to the extracted text, not a byte offset in the original file. There is no extraction cache.

Hidden paths, common build/cache trees, secret/key names, obvious JSON/YAML credential values, browser profiles (including `.myos/agent-chrome`), known cloud directories, symlinks, hardlinks, foreign-owned files, oversized files, binary/invalid UTF-8 text, and macOS dataless placeholders are refused. Cloud placeholders are never hydrated.

The JSON metadata catalogue is intentionally a small bounded-v1 implementation and is not suited to very large corpora. QMD supplies its own SQLite/vector/FTS storage. Offline or partial roots preserve previously observed rows so absence is never mistaken for deletion, and partial scans never produce a complete-negative claim. Corrupt index state degrades explicitly and is not automatically erased.

This is a same-account local CLI boundary, not a hosted MCP service or an authorization boundary against a hostile process running as the same OS account. State permissions and path checks reduce accidents; they do not provide universal same-account containment.

The synthetic suite covers freshness, privacy admission, mutex contention, shutdown idempotence, bounded scans, SDK operation selection, native-mode UI admission, and failure cleanup. The shipped screening and second-Mac public-fixture checks are narrower than whole-OS coverage or held-out quality evaluation, neither of which is proven. Real embedding inference may be unavailable inside a parent sandbox even when the pinned local model is present. This package installs no automatic hook, route, or feature flag.

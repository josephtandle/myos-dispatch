# Atelier automatic refresh

`bin/myos-atelier-refresh.js` is a deterministic, single-pass runner for refreshing derived Atelier graphs. It is designed to be called by an owner-managed scheduler. This change does not install a cron job, daemon, or scheduler.

The owner config path is the exact repository-local path `config/atelier-refresh.json`. A managed invocation may provide another absolute path with `--config`, but relative paths are rejected. The config is owner-local and should not be committed when it contains private source paths.

Minimal shape:

```json
{
  "schema": "myos.atelier-refresh@v1",
  "owner": "joe",
  "taskClass": "maintenance",
  "maxRefreshes": 5,
  "statePath": "/Users/myos/.myos/state/atelier-refresh.json",
  "retry": { "maxAttempts": 3, "baseDelayMs": 60000, "maxDelayMs": 3600000 },
  "sources": [
    {
      "id": "example",
      "mode": "atelier",
      "path": "/absolute/owned/estate/example",
      "audiences": ["team"],
      "sourceOrigin": {
        "path": "/absolute/canonical/origin/example",
        "files": { "README.md": "64-character-sha256" }
      }
    }
  ]
}
```

Every source must have an absolute canonical `sourceOrigin` and a state path outside all source views. A canonical local source may omit `sourceOrigin` only with an explicit `canonicalDirect: true` flag, and the path must be a real, non-symlink directory. The runner reads each source independently. Fresh sources are skipped. A stale derived graph is rebuilt through `syncAtelier`, then read back and accepted only when `readAtelierSource` is fresh. Canonical origin changes, invalid origins, missing origins, and failed post-refresh freshness are reported as bounded machine-readable statuses.

The state file and sibling lock live outside source repositories. Failed sources retain attempt counts and deterministic exponential backoff. `maxRefreshes` bounds derived rebuilds per pass, defaulting to 5, while remaining sources are reported as deferred for the next scheduled pass. A lock held by another invocation returns `{"status":"locked"}` without touching any source. One source failure does not stop other sources. Reports contain source IDs and reason codes only, never document bodies, credentials, or exception text.

The runner never edits canonical origins, source documents, Atelier audience metadata, or Git history. It only invokes the existing derived-state synchronizer. Run it with Node 24:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
  /opt/homebrew/opt/node@24/bin/node \
  bin/myos-atelier-refresh.js --config /absolute/path/config/atelier-refresh.json
```

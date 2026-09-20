# Optional host Qwen bridge

Public Dispatch can use an existing host Qwen service for bounded `cheap_routing`
text or JSON requests. It is disabled unless the process explicitly sets
`MYOS_PUBLIC_LOCAL_PROVIDER_CONFIG` to an absolute JSON registration path. Installing
the public package alone does not enable or start a local model.

The registration is trusted executable host configuration. It names an existing
module exporting `ensureLocalMlxServer(baseUrl)`:

```json
{
  "enabled": true,
  "runtimeModule": "/absolute/workspace/agents/shared/llm-call.js",
  "model": "mlx-community/Qwen3.5-35B-A3B-4bit",
  "cacheRoot": "/absolute/external/huggingface/hub",
  "snapshotPath": "/absolute/external/huggingface/hub/models--mlx-community--Qwen3.5-35B-A3B-4bit/snapshots/REVISION",
  "plistPath": "/absolute/home/.myos/launchd/com.myos.mlx-qwen-tier0.plist",
  "baseUrl": "http://127.0.0.1:8891"
}
```

Before registration, verify that the existing host loader actually uses the named
plist and that its Hugging Face cache resolves to the registered complete snapshot.
The bridge checks nonempty configuration/tokenizer/weight files, every indexed
weight shard, cache containment after symlink resolution, and an offline
`HF_HUB_OFFLINE=1` plist declaration before importing the host runtime. These checks
establish file presence, not cryptographic model integrity. Registration must be
controlled by the host operator. The bridge never downloads weights or creates,
installs, rewrites, or unloads a model service.

The initial supported endpoint is only `http://127.0.0.1:8891`. On connection refusal,
the bridge reuses the existing loader, including its memory/headroom admission,
pressure backoff, on-demand startup, and idle-unload policy. Cold startup remains
outside the per-request timeout. A warm service is used without restarting it.
The public bridge owns the small inference POST transport and sets `redirect:
"error"`; it never follows a model response redirect with the prompt. It does not
override global fetch or modify the private bot transport. JSON parsing, fenced
JSON cleanup, token usage normalization, and disabled reasoning are implemented
at this bridge boundary. Blank or missing text and malformed JSON are failed
attempts. Only socket connection refusal triggers the existing loader, never a
redirect, HTTP error, timeout, or invalid model response.

Local text requests default to 30 seconds and 512 output tokens. Input is limited
to 16,000 characters, and explicit larger output budgets exclude the local path.
Tools, media, search grounding, non-text message content, model/provider/profile
pins, and other task classes retain their existing routes. Explicit intents,
lane overrides, local routing overrides, and model assignment declarations also
exclude local substitution. Only the unmodified default task-class route is
eligible in this initial release.

`authMode` continues to identify the workflow, `oauth` or `api`. Local attempt and
result metadata separately record `transportAuthMode: "none"`,
`billingMode: "local"`, `authLabel: "local:none"`, zero estimated cloud cost, and
nonbillable ledger events. Cloud spend reservations do not apply to local work;
the global model kill switch still does.

A failed local attempt falls through to the workflow's existing candidates.
Interactive OAuth work therefore keeps its OAuth fallback, API work keeps its API
fallback, and a local-only lane gains no cloud candidate. Missing/incomplete cached
weights are an unavailable local attempt, not permission to download or cross lanes.

Remove the registration environment variable, or set registration `enabled` to
false, to restore the original routing immediately. Existing host residency/idle
policy remains responsible for unloading. This feature does not redirect native
CLI sidecars or change private Uni/Juno routing.

Hermetic checks:

```sh
node --test test/local-provider.test.js test/myos-routing.test.js test/llm-call.test.js
```

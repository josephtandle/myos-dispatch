# Claude connection and Qwen clarification

## Connection

Official CLI subscription login completed on 2026-09-21. Both the standalone and Desktop engine had previously reported no CLI login, despite the running Desktop app. This shell contained inherited Desktop settings and an unavailable messaging socket, which is not proof of reusable authentication. No Desktop token extraction or account-wide logout was performed.

Claude now reports claude.ai authentication and Max subscription. A real tool-free Sonnet invocation solved 17 + 25 as 42. The public myOSrunOauth entrypoint, explicitly pinned to claude-sonnet-5, returned 42 in 3.253 seconds with 8,927 input tokens including cache and 3 output tokens. Model usage also reported a Haiku helper, so exact requested-model participation is not described as exclusive execution.

Version 4.2.1 adds an eligible Sonnet fallback to cheap_routing, default_automation and planning. It remains third after the two Codex candidates and triggers only for unsupported-model failures. Explicit pins, quota/auth failures and writers do not retry. API work and private bot behavior are unchanged.

## Review and bounded follow-through

The full Node 24 suite passed: 888 tests, 869 passed, 19 skipped, zero failures. Focused transport, foreground routing and lane-boundary tests passed 24/24. The final simplification review retained the shared eligibility predicate and isolated CLI adapter because they enforce distinct safety boundaries; no additional behavioral changes were introduced.

The independent review identified capability dropping, omitted caller output budgets and incomplete cached-token accounting. Tests reproduce each case and the transport rejects unsupported capabilities, sets the documented output limit and includes cache usage.

One bounded adjacent-code sweep considered four improvements: strict capability eligibility, honest cache accounting, changing Qwen admission thresholds and broadening Claude to untested model families. The first two were implemented and tested. The latter two were rejected for this checkpoint because they require additional workload/quality evidence and would broaden runtime behavior.

## Qwen

This Mac has 96 GiB physical RAM. The 1.6 GiB free reading was transient, not a statement that the hardware cannot fit Qwen. A later live reading had 25.3 GiB free with 21.9 GiB compressed. Free pages are not all potentially reclaimable memory, but the current guard intentionally requires about 28 GiB free before loading this model.

The existing memory self-healer had unloaded the Qwen service and set a pressure backoff. No backoff or memory threshold was bypassed. External weights remain intact. The right target is fewer cloud calls per accepted result, not maximum local residency: deterministic routing first, then a measured local model only for suitable work. The current 35B model is not proven to be the best size for routine routing; replacing it or changing admission requires a bounded quality/latency/RAM evaluation. No unsupported historical throughput claims were reused.

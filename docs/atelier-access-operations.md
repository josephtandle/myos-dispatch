# Atelier access operations

`packages/atelier-access/doctor.mjs` is an owner-local, read-only readiness check. Run it with Node 24 and a private JSON config:

```sh
/opt/homebrew/opt/node@24/bin/node packages/atelier-access/doctor.mjs /path/to/atelier-access.json
```

The config may be disabled. Disabled access returns a safe report with `ready: false`; when registry or grants paths are supplied, it still performs local preflight without network access. Enabled access checks HTTPS issuer, `/mcp` resource, and JWKS URLs; private regular registry and grants files; the portfolio and grants schema; issuer metadata; protected-resource metadata at `/.well-known/oauth-protected-resource/mcp`; and a public RS256 or ES256 signing key. Provider requests reject redirects and are bounded to five seconds and 256 KiB.

The report contains booleans, counts, and stable error codes only. It never prints endpoint values, grant identities, tokens, or document content. `clientRegistrationRequired` is reported explicitly. Deployment and interactive login remain `false` until a separately authorized provider check verifies them, so this doctor never claims production readiness by itself.

This command does not create or modify grants, register clients, handle credentials, deploy a proxy, or expose a listener. Use the package tests for local contract coverage:

```sh
npm test --prefix packages/atelier-access
```

## Future local proxy shape

If a verified issuer and grants are later supplied, the owner-local process may listen on `127.0.0.1:8140` under Node 24. A dedicated hostname such as `atelier.mastermindshq.business` must be provisioned and verified before any public listener exists. The proxy should forward only the exact `Host` value for that hostname and the discovery, `/mcp`, and `/api/knowledge` paths. It must not cache authorization responses, and should enforce rate limits, bounded request bodies, and short upstream timeouts. Provider setup is acceptable only after issuer metadata, client registration, redirect URI, PKCE, token audience, grants, and an authenticated readback are independently verified. Until then, do not activate a public listener.

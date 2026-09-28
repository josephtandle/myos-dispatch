# Atelier employee onboarding

This is an operator-only maintenance CLI; it does not invite users, create public grants, or reload the running service. Commands are dry-run by default and only write with `--apply`.

```sh
node onboarding.mjs add --config /private/access.json --email employee@example.com --account-id ACCOUNT --app-id APP
node onboarding.mjs enroll --config /private/access.json --email employee@example.com --account-id ACCOUNT --app-id APP --projects project-a,project-b --assertion-file /private/current-access.jwt --apply
node onboarding.mjs revoke --config /private/access.json --email employee@example.com --account-id ACCOUNT --app-id APP --apply
```

`--all-team` may replace `--projects` for enrollment and expands only to the registry projects currently present. It is not a future-project wildcard. Cloudflare identifiers must be supplied explicitly, while the Cloudflare API credential is read only from `CF_API_TOKEN`; it is never accepted as an argument or printed.

The config must be an enabled Cloudflare Access config with an exact `/mcp` resource, pinned application audience, issuer and JWKS URI. `add` and `revoke` inspect the exact Access application host/audience and require exactly one simple allow policy containing email rules only; complex provider policies are not modified. Revocation deliberately removes local managed grants before inspecting the provider, so local changes can occur even when provider cleanup is refused.

Enrollment accepts only a mode-0600 private JWT assertion file. The signed Cloudflare Access application assertion is verified with the existing verifier, including issuer, JWKS, expiry, audience, `type: app`, subject, and exact email. Grants are only for explicit registry projects, their existing brand IDs, and `audiences: ["team"]`.

Before each local mutation the CLI takes a mode-0600 backup, takes an exclusive lock, compares the current file contents, and writes via rename. On provider failure it reports `status: "partial"`; it never rolls grants or local allowlist changes back as a claim of provider success. `restartRequired: true` means the owner must explicitly restart/reload the access service.

Revocation removes only grants marked `managedBy: "atelier-onboarding"` for that email. Legacy grants are retained and reported as requiring reconciliation. The last local allowlisted email cannot be removed.

## Employee sign-in and assertion capture

The employee must authenticate as themselves. An operator or the employee's own agent can use Cloudflare's supported `cloudflared access login https://team.mastermindshq.business` flow. Capture its output only into a new private file, never a chat, terminal transcript or source repository. After login, `cloudflared access token --app https://team.mastermindshq.business` returns the cached application JWT. Keep the file mode 0600 inside an owner-only directory, pass its path to enrollment, and dispose of it under your credential-retention policy after use. The CLI verifies the signed email and rejects the wrong user's cached token. Do not substitute a Managed OAuth opaque token, a tunnel token, or JSON from `/api/identity`.

Official acquisition reference: https://developers.cloudflare.com/cloudflare-one/tutorials/cli/

The operator needs this signed proof to enroll a new identity. Browser login alone does not yet automatically enroll the employee. Employees do not need Cloudflare administrative credentials. Never reuse Joe's login to represent a teammate.

## Recovery and automation

Exit 0 means a successful command or dry run, not proven employee retrieval. Exit 1 means rejection; exit 2 means partial application requiring follow-through. Preserve the emitted backup paths and inspect state before retrying. Local grant revocation happens before any provider inspection, so a provider outage cannot prevent that local step. Unknown legacy ownership is reported conservatively and must be reconciled before claiming full offboarding.

One workflow lock per config serializes this CLI's writes. Stop other provider editors during changes: Cloudflare policy PUT has no atomic compare-and-swap guarantee used by this CLI. It rechecks provider state immediately before PUT and verifies readback, but cannot prevent an external edit between those requests. Before each provider write it saves a private `.cloudflare-policy-<id>.json` snapshot beside the config. Do not restore snapshots blindly over newer work.

For this deployment the access daemon caches allowed emails: after an add or revoke reporting `restartRequired`, the operator runs `launchctl kickstart -k gui/502/ai.myos.atelier-access`, then runs the protected endpoint checks. Grants are re-read on every request. An already-applied retry may report no new restart requirement; if an earlier run required a restart, that obligation remains until independently verified.

Mark onboarding complete only after a real permitted read and out-of-scope denial from the employee's actual client. Google provider setup and hosted-client callback registration are separate prerequisites, not handled by this CLI.

# Optional Atelier access server

Read-only MCP and HTTP API for individually authenticated collaborators. Disabled until an owner supplies an enabled local configuration. No model credentials, shared accounts, uploads, public hosting or identity-provider account are created.

Use Node 24. Run `npm ci --ignore-scripts` in this directory, then `npm test`. From the repository root, `npm run test:atelier-access` runs the same suite after that install. These optional dependencies are separate from the core Dispatch install.

## Configuration

Use `access.config.example.json` as the shape for an owner-local `access.config.json`, which is ignored by Git. The issuer and JWKS endpoint must belong to the chosen identity provider. The resource URL must be the canonical HTTPS MCP endpoint ending in `/mcp`, and is also the exact access-token audience. Other resource paths fail startup. Configure the provider to issue short-lived signed RS256 or ES256 access tokens with `atelier:read`, and use the provider's normal authorization-code/PKCE flow for interactive clients. Service clients need their own issuer/subject grant and provider-managed credentials, never a model subscription token. The JSON API accepts tokens for this same resource, using preconfigured clients rather than a separate OAuth discovery flow.

The portfolio maps canonical brands and projects. The separate grants file maps verified issuer/subject pairs to project IDs, brand IDs and audiences. An empty grants list denies everybody. Invitations, user lifecycle, client registration, consent, PKCE and identity revocation belong to the provider. Local grant revocation takes effect on the next read; already-issued JWTs remain cryptographically valid until expiry unless the provider invalidates its signing keys. Remove the local grant for immediate knowledge-access revocation.

Run `npm start -- /absolute/private/access.config.json` only after configuring those fields. The CLI binds to `127.0.0.1`, not the public network. A separately approved HTTPS reverse proxy must preserve the configured Host and must not expose other local routes. No proxy or service autostart is installed here.

## Interfaces and checks

- `GET /.well-known/oauth-protected-resource/mcp`: OAuth resource discovery for the example `/mcp` resource. The path follows the configured resource URL.
- `POST /mcp`: stateless Streamable HTTP MCP, one read-only `search_knowledge` tool.
- `POST /api/knowledge`: JSON `{projectId, brandId?, query?}`.

Both read interfaces require a Bearer token and enforce the same grants. Unknown request fields cannot supply identity or audience. Tokens are checked for signature, issuer, audience, expiry, subject and scope. Local graph freshness and canonical audience restrictions remain enforced after authentication. Responses omit source filesystem metadata and use `atelier://` citations; authorized document text itself is not a redaction service. Audit events contain status and task class, not tokens or document/query contents.

The automated check uses an actual SDK MCP client and HTTP requests against a temporary loopback server, with ephemeral test keys. It covers discovery, accepted reads, project denial, hostile Origin, revocation and stale-source denial. It does not prove sign-in through an external identity provider or Claude/Codex application. That acceptance check requires the selected provider, approved HTTPS destination and a real collaborator identity.

Protocol references: [MCP authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization), [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth).

## Cloudflare Managed OAuth deployment

Set `authMode: "cloudflare-access"` explicitly to use this alternative to generic bearer JWTs. Configure `issuer` as the exact HTTPS team domain without a trailing slash, `jwksUri` as that issuer plus `/cdn-cgi/access/certs`, `applicationAudience` as the 64-character Access application AUD tag, and `allowedEmails` as a nonempty lower-case exact-email list. Keep `resource` as the public HTTPS `/mcp` endpoint. Unknown modes fail startup. Do not put real employee identities or local configuration in this public repository.

In this mode the server ignores client bearer tokens and verifies only the signed `Cf-Access-Jwt-Assertion` forwarded by Cloudflare. It pins RS256, issuer, application audience, expiry, nonempty subject, application token type and the signed email allowlist. No unverified email header or request-body identity is accepted. The generic bearer mode remains separate and still requires `atelier:read`.

Cloudflare owns authorization-code/PKCE, dynamic client registration, consent and opaque token exchange. Enable Managed OAuth on the exact Access application; use short-lived tokens and only the necessary redirect URIs. Configure a dedicated tunnel with the exact hostname, allowlisted paths and a terminal 404 ingress rule. Use the CLI loopback binding, never a publicly bound origin. Do not reuse a tunnel that serves unrelated applications. Keep tunnel credentials in a private token file rather than command-line values or diagnostic output.

`GET /api/identity` exists only in Cloudflare mode and returns the authenticated caller's verified issuer, subject and email with `Cache-Control: no-store`. This is an enrollment readback, not a grant or a directory of other users. The operator must reconcile it with the approved employee identity before recording stable subject grants. Unknown subjects still receive no knowledge. For team deployment each project's grant must use exactly `audiences: ["team"]`, and only that project's applicable brand IDs. Never auto-grant a subject from a supplied email or request body.

The doctor separately checks edge OAuth discovery and the assertion signing-key endpoint; it never promotes local checks into a claim of real login or deployment. Final acceptance requires a real OAuth client, authorized MCP and JSON reads, private/unknown-project denial, spoofed-assertion rejection and next-request revocation. Remove local subject grants atomically first during offboarding, then remove the Cloudflare entry rule. Rollback: atomically empty local grants, stop the dedicated origin/tunnel, then disable the Access application if necessary. Do not rely on DNS propagation or token expiry for immediate revocation.

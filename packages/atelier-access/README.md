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

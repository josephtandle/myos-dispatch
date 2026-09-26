# Atelier knowledge sources

Atelier is optional. Configure a source in the existing data-source registry:

```json
{
  "id": "atelier-example",
  "label": "Example project knowledge",
  "mode": "atelier",
  "path": "/absolute/path/to/approved/repository",
  "matchTerms": ["example project knowledge", "example project notes"],
  "audiences": ["private", "team"],
  "readOnly": true,
  "preferOverProject": true
}
```

The local config is `config/data-sources.json` or the file selected by `MYOS_DATA_SOURCES_CONFIG`. Never commit a private registry to the public package. `audiences` is a trusted host setting, not a user-supplied request parameter or authentication system. Use this reader only inside the trusted local MyOS host. External access requires authenticated identities mapped to separate project/audience grants.

Supported input is the single-repository `mnstry.atelier-knowledge-graph@v1` artifact from @mnstry/atelier 0.2.0-alpha.12. Source documents remain canonical. Retrieval returns original paths, SHA-256 digests, selected metadata, and one hop of declared relationships. Private repo boundaries cannot be weakened by node audience labels. Missing/invalid graphs or changed tracked documents fall back to current tracked Markdown and omit stale relationships. Results never claim an exhaustive negative.

Tracked symlinks are omitted from labeling and source snapshots, matching the pinned graph builder's regular-file walk. Their targets are not enrolled or edited. Replacing a link with a regular tracked document changes the manifest and requires a rebuild. A canonical Brand Brain must be a real enrolled source, not an external-link shortcut.

After staging intended source/sidecar additions, run `node bin/myos-atelier-sync.js REPOSITORY` using supported Node 24. It runs the pinned graph builder, checks source stability and graph validity, then atomically writes `.atelier-local/myos-dispatch-snapshot.json`. A failed build removes the freshness receipt and retains the prior snapshot as recovery data. This command refreshes derived state only, without editing Brand Brains or uploading anything. Existing GitNexus and Understand Anything indexes are unchanged. The older snapshot command is a diagnostic building block, not a substitute for synchronization.

## Audience automation

`node bin/myos-atelier-audience.js REPOSITORY` previews local decisions. `--apply` applies them; `--patch` emits an apply_patch-compatible patch. Only tracked Markdown and source sidecars are considered. The default is team. Specific sensitive paths/content are private. Giveaway candidates are reported but never made public automatically. No network request or Jev API call is made because document classification must honor the current local-only workflow.

`atelier.audience-policy.json` contains `overrides`, mapping repository-relative paths to private/team/public. Explicit overrides are authoritative, including public, with no second approval gate. Existing explicit labels are retained. Automatic decisions are recorded in ignored `.atelier-local/audience-decisions.json`; reruns preserve manual changes. Overrides and labels describe intent; they do not publish files or grant repository access. Run graph again after changes.

For a sharing surface, audiences must also be intersected with authenticated per-person repository permissions. Never expose the local reader or Atelier development server directly to the internet.

## Multiple brands and projects

Keep an owner-local registry with schema `myos.atelier-portfolio@v1`: `sources` maps IDs to repository paths, allowed audiences and optional `includePaths`; `brands` lists `{id, brain: {sourceId, path}}`; `projects` lists `{id, brandIds, primaryBrandId?, sourceIds}`. Every Brand Brain is a tracked canonical Markdown file. Duplicate canonical mappings and invalid references fail validation. Project sources require explicit path scopes, using exact files or directory prefixes ending in `/`. Shared tooling is a separate source, not a brand's identity. Project-specific brains can be registered as distinct brands and selected explicitly, rather than overwriting a shared parent brain.

Run `node bin/myos-atelier-query.js REGISTRY --validate`, then `node bin/myos-atelier-query.js REGISTRY PROJECT_ID QUERY`. Multi-brand projects need an explicit brand selection through `queryPortfolio`, or a configured primary brand. Unknown or ambiguous identities return no results. The CLI currently chooses the primary brand. Single-repository edges remain local; cross-repository brand relationships are declared in the portfolio, not fabricated in Atelier metadata.

## External access, optional local server

`readAuthorizedKnowledge` is an internal authorization function. Only trusted middleware that has verified an OAuth access token or service credential may supply its `principal` (issuer and subject). Never accept that object directly from an HTTP request. The optional `packages/atelier-access` package provides a maintained JWT verifier, Streamable HTTP MCP transport and JSON API around this boundary. It is separately installed, disabled until configured and loopback-only through its CLI. No identity account, public listener, proxy, autostart or hosted deployment is created.

Its owner-local `myos.atelier-grants@v1` policy lists grants containing issuer, subject, projectId, brandIds, audiences, optional expiresAt and disabled. Exactly one active matching grant is required. Policy is read for each call, so revocation applies on the next call; changes during retrieval deny the response. External reads require fresh graphs, remove local paths and relationships, and return `atelier://` citations. Source audiences default to private/team; public requires an explicit source allowance and grant. OAuth and API-backed agents share this policy boundary, independent of their model billing/authentication.

Next external deployment gate: select an established OAuth/OIDC provider and owner-controlled HTTPS host, configure its exact issuer/JWKS/resource values and individual grants, then test actual Claude/Codex sign-in and revocation. The package tests exercise real local HTTP and SDK MCP connections, not an external provider login. See its README for setup and token-lifecycle limits. Do not reuse model-subscription OAuth credentials as collaborator credentials.

# MyOS knowledge governance

This additive MyOS contract does not redefine `mnstry.atelier-knowledge-graph@v1` or `atelier-export@v1`. It describes local knowledge authority, not MNSTRY runtime admission.

## Authority and identities

A repository stores files. A project names a job or outcome. A brand names an identity and its approved Brand Brain. A deployed system owns current runtime state. A collection identifies an explicitly scoped set of sources with an accountable owner and a conflict rule. None is interchangeable with the others.

Use stable IDs for collection, project, brand, source and claim. Minimal relationships are `project uses brand`, `collection cites source`, `claim supported by source`, `claim supersedes claim`, and `person granted project`. Existing Atelier source relations remain source-local. MyOS portfolio links remain in the owner-local portfolio; runtime grants remain in the grant policy. Do not invent memberships from an audience label.

Canonical authored material wins over its generated or distributed copy. Conflicting canonical material goes to its owner rather than being resolved by newest timestamp. Current payments, memberships, deliveries and device states require a fresh query to their owning operational system, not a Markdown snapshot. All current Atelier collections have documentary authority, never live-fact authority.

## File classes and ingestion

Keep authored sources, immutable original evidence, generated projections, distributed runtime copies and machine-local state separate. A runtime copy remains source in its owning repository and a copy in consumers. Unknown files remain source until classified; this contract authorizes no deletion or mass movement.

Stages: `enrolled` identifies an original source; `extracted` requires a verified extractor receipt; `proposed` records interpretation and uncertainty; `accepted` records an attributable reviewed claim; explicit supersession preserves old records. A sidecar is enrollment only. The installed Atelier intake module can preserve source/output hashes and extractor attempts, but does not perform extraction or semantic acceptance. Its receipt is not proof that a statement is true.

`resolveClaim` is a deterministic local record resolver. Accepted claims require a stable key, collection, source path/hash, verified confidence, acceptance actor/time and supersession list. Contradictory active claims return `conflict`, changed current source hashes return `stale`, malformed/dangling/cyclic supersession returns `invalid`. It never silently chooses the latest record. Acceptance actor strings are audit attribution, not authenticated identity; only a trusted owner process may write this ledger. This module does not import, accept or publish claims automatically, and the source search API does not read a claims ledger.

The first resolver accepts Markdown/plain-text evidence only. A PDF, Word file or enrollment sidecar cannot directly substantiate an accepted claim. Binary intake must first yield a separately verified text source with its original-source/extractor provenance retained by the intake process. This restriction does not claim that such extraction has already happened.

## System responsibilities

Atelier owns source census and source relationships. MyOS owns collection/project/brand mapping and authority contracts. GitNexus and Graphify/Understand Anything remain code/structure indexes. Search retrieves bounded references. Memory carries working context, not a competing operational database. Dispatch selects the task and sources. Jev may assist eligible typed semantic decisions but cannot grant authority, authenticate people or overrule deterministic permissions.

Source retrieval explicitly returns `evidenceStatus: source_reference` and `liveFactAuthority: false` through the local reader and authorized API. This is a machine-readable limitation, not a claim of completed semantic governance or an automatic fact-checker.

## Permissions

Audience is intended readership. Repository access controls who can read repository bytes. Runtime grants control authenticated project/brand/audience access. Publication is a separate authorized action. A private label cannot protect a file from someone with repository access; sensitive material must use a genuinely restricted store before direct repository sharing. Team remains the ordinary audience default, and explicit public choices need no repeated confirmation. Neither label alone creates a membership, grant, invitation or publication.

## Audit

The owner-local, ignored `config/atelier-governance.json` uses schema `myos.knowledge-governance@v1` and a `collections` list. Each entry has `id`, `sourceId`, `owner`, absolute `canonicalPath`, `role`, `authority: documentary`, `conflictRule: owner-review`, and `operationalFacts: live-system-only`.

Run `node bin/myos-atelier-governance.js` on the trusted local host. It verifies coverage of configured Atelier sources, canonical origins and graph freshness. It does not create accepted facts, inspect databases, change grants or enable a server. Run this audit alongside graph refresh and the integration check. The three acceptance jobs are correct-brand work, operational answers from their live authority, and permissioned collaboration; no green graph alone establishes all three.

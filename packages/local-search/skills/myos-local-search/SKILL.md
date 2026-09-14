---
name: myos-local-search
description: Find approved local files and notes using the installed MyOS local index and native search.
---

# MyOS local search

Use `myos-find` only when the user asks to locate information in local files or notes and has explicitly enabled assistant export in private desktop settings.

Locate the portable settings path from the user's supplied path or the current application install receipt. Never assume a path from another computer. A public example must use placeholders, such as:

```sh
myos-find --settings /ABSOLUTE/PRIVATE/settings.json search --query "invoice reference"
```

Start with the default `native` mode for metadata and exact local discovery. Use `filename` or `keyword` when the request is explicitly lexical. Use `semantic` only as an optional conceptual fallback; `auto` may also invoke semantic search.

Keep roots and result, byte, and context budgets narrow. Excerpts require the user's explicit content-export policy. Treat citations as snapshot provenance, verify current files before consequential use, and preserve partial results, `negativeIsComplete`, `semanticPending`, and `sourceUnavailable` warnings. A missing result is not proof of absence when negatives are partial.

Do not bulk-preload memory, run automatic hook queries, request hidden permissions, add source roots, or expose private paths, snippets, credentials, or error text outside the approved result packet. This skill makes no LLM calls and must not download models or content.

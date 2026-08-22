# Background workers: what runs your sidecars

On bigger tasks Dispatch launches a few short-lived read-only "scouts" in the
background and feeds their findings into your next message. This page explains what
they run on, how that is chosen, and how to change it.

## What gets chosen, and why

If you have not pinned anything, Dispatch uses the first of these that is actually
installed on your machine:

| Order | Command | Why here |
|---|---|---|
| 1 | `codex` | Strongest at bounded read-only scouting. Preferred when present. |
| 2 | `claude` | Works well and is already on most machines running this. |
| 3 | `antigravity` | Used when it is what you have. |
| 4 | `gemini` | Same. |

If none is installed, **nothing is spawned**. Dispatch falls back to advising the
lanes in your route context, exactly as it behaved before background execution
existed. That is a deliberate quiet degrade, not an error: a machine without a
worker CLI should not be nagged on every prompt.

## Pinning one

Set either variable to the command you want. An absolute path works too.

```sh
export MYOS_BACKGROUND_PROVIDER=claude
```

A pinned provider that is **not** installed disables background work rather than
falling back. If you name it, you mean it, and silently substituting something else
would spend your quota on a tool you did not choose.

## Turning it off

```sh
export MYOS_AUTO_FANOUT=0              # no automatic scouts; lanes are advised only
export MYOS_BACKGROUND_AGENTS_ENABLED=0 # disables background work entirely
```

## Checking what it picked

```sh
which codex claude antigravity gemini
```

The first one that prints a path is what Dispatch will use. Your route context also
names the lanes it dispatched, so a turn reporting lanes "ALREADY RUNNING" is
telling you a worker was found and used.

## What these workers may do

Scouts are **read-only**. They read and report; they do not edit files, and the
sidecar CLI forces read-only mode on every task regardless of what it is handed.
Writing is a separate, deliberate path that you invoke yourself.

They also cost tokens on whichever provider is chosen, which is why the preference
order matters and why the cap exists: at most three lanes per turn and six per
session-hour.

## History

Before v3.5.2 the availability check and the spawn disagreed. On a Claude Code
surface the gate ran `which claude` while the sidecar spawned `codex`, so a machine
with `claude` and no `codex` passed the gate and every lane died with
`spawn codex ENOENT`. Reported from the field by Nicola Harvey. The gate now resolves
the provider that will actually run and passes it to the sidecar explicitly, so the
thing that was checked is the thing that runs.

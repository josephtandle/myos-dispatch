# myos-dispatch

MyOS Dispatch is a standalone routing and execution core for agentic systems. It resolves an operator request into an execution plan by applying hard safety gates, typed evidence, capability routing, execution-lane selection, parallelization planning, goal scale, and model/runtime selection.

This repository is scaffolded as a public extraction of the generic dispatch core. Private operator context, generated capability indexes, runtime state, fastpath data, project indexes, and personal documents are intentionally excluded.

## What Is Included

- Core routing and dispatch modules in `src/`
- Promotion and shadow-policy modules in `src/promotion/`
- Background worker helpers in `src/background/`
- Optional model/runtime helpers in `src/runtime/`
- Generic routing policies and empty example indexes in `config/`
- The native dispatch hook in `bin/myos-dispatch-hook`
- Dispatch-focused tests in `test/`

## Install

Installation instructions will be filled in after genericization and packaging.

## Configuration

Set `MYOS_HOME_ROOT` to the root directory where Dispatch should read local operator-owned configuration and write runtime state. Keep real secrets in your local environment only; use `.env.example` as the placeholder reference.

## Smoke Test

```sh
npm test
```

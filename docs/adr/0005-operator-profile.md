# ADR 0005: Operator-owned profile for LLM defaults

## Status

Accepted

## Context

ADR 0003 moved LLM execution policy out of repository config into operator-supplied CLI flags. Operators who repeatedly run `scan` / `diff` with the same provider settings must pass the same flags on every invocation.

Setup UX (Phase 3) needs a durable, operator-owned place for defaults that does not violate ADR 0003's untrusted-repository boundary.

## Decision

- Store operator defaults in `~/.config/r3-doctor/profile.json` (override path with `--profile`).
- Profile schema (`schemaVersion: 1`) may include partial `llm` settings and optional `locale`.
- Merge order for LLM execution policy: **CLI flags > operator profile > built-in defaults**.
- Repository config (`r3-doctor.config.json`) remains forbidden from owning `llm` execution policy.
- Profile files are operator-owned trusted configuration, not scanned repository data.

## Consequences

- CI can continue passing explicit `--llm-provider` flags; profiles simplify local development.
- Profile merge is covered by `tests/semantic/execution-policy.test.ts` and `tests/operator/profile.test.ts`.
- Setup wizard may suggest creating a profile but never writes LLM policy into repository config.

## Alternatives

- Environment variables only: rejected — no structured schema/versioning.
- Repository-local `.r3-doctor/profile.json`: rejected — violates ADR 0003 trust boundary.

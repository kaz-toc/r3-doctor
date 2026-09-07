# ADR 0002: Semantic providers via ACP over stdio

## Status

Accepted

## Context

r3-doctor needs optional LLM-backed semantic analysis for the Semantic Ambiguity axis. External HTTP REST APIs would duplicate provider auth, increase secret handling risk, and diverge from guilz-trace's proven integration path.

## Decision

- Adopt **ACP over stdio** with provider CLIs (`copilot`, `agent`, `codex-acp`, `claude-agent-acp`).
- Use a **one-shot spawn model** per scan (spawn → initialize → session → prompt → dispose).
- Do **not** store API keys in r3-doctor config; inherit provider env vars at spawn time only.
- Keep `ASSESSMENT_CONTRACT_VERSION` at v2; bump `SemanticProvider.implementationVersion` for semantic output changes.
- Accept config aliases: `openai` → `codex`, `anthropic` → `claude`.

## Consequences

- Requires users to install provider CLIs locally or in CI optional jobs.
- Copilot launches with tool/MCP disabling flags for text-only analysis.
- Empty semantic findings remain valid but leave the axis unevaluated by design.

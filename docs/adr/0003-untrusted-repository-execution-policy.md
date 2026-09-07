# ADR 0003: Untrusted repositories cannot own execution policy

## Status

Accepted

Supersedes the repository-owned execution-policy and config-alias portions of ADR-0002.

## Context

r3-doctor scans repositories that may originate from pull requests or other untrusted sources. A repository-local `r3-doctor.config.json` previously controlled LLM enablement, provider selection, executable path, and send scope. That allowed scanned data to select a child process which inherited the selected provider's credential allowlist.

Repository paths and filenames also cross persistence and GitHub reporting boundaries. Treating the repository as configuration authority would therefore combine code execution, credential exposure, and output injection risks.

## Decision

- Treat the target repository, its config, refs, filenames, and source as untrusted data.
- Restrict `r3-doctor.config.json` to declarative analysis and storage settings. Reject an `llm` property.
- Keep LLM execution disabled unless the operator explicitly supplies `--llm-provider` to `scan` or `diff`.
- Source provider, executable, model, send scope, and prompt/file limits only from operator-owned CLI options. An executable override without an explicit provider is invalid.
- Preserve provider-specific environment allowlists and ACP capability confinement as defense in depth.
- Escape GitHub workflow-command and Markdown channels at their output boundaries.
- Replace generated regular expressions with a bounded glob matcher, validate Git object IDs, and place finite limits on repository-controlled config.
- Replace external and persisted `metadata.repositoryPath` values with `[REPOSITORY]`.

## Consequences

- Existing repository configs containing `llm` fail validation and must move those values to CLI invocations or trusted CI configuration.
- Enabling semantic analysis is an explicit operator consent event for each invocation.
- Analysis still records the effective LLM policy in its context fingerprint, preserving comparison compatibility checks.
- Stored baselines no longer reveal an operator's absolute filesystem path.

## Alternatives

- Allow repository-local LLM settings behind a confirmation prompt: rejected because non-interactive CI cannot establish durable operator consent and a prompt does not make repository-owned executable selection safe.
- Keep inherited `PATH` unchanged and rely on `shell: false`: rejected because direct process spawning still resolves a bare command through repository-influenced search entries.
- Escape only annotation output: rejected because ordinary CLI output and job summaries are separate untrusted output channels.

## Enforcement

- Execution ownership and executable search: `tests/intake.test.ts`, `tests/semantic/execution-policy.test.ts`, and `tests/semantic/acp-client.test.ts`.
- Output and workflow isolation: `tests/github.test.ts`.
- Bounded input, Git, policy, prompt, and path privacy: `tests/intake.test.ts`, `tests/git-provider.test.ts`, `tests/operations.test.ts`, `tests/semantic/semantic-prompt.test.ts`, and `tests/redaction.test.ts`.
- Incident mapping: `docs/incidents/LEDGER.md` and active cases `REG-2026-001` through `REG-2026-009`.
- Repository-wide validation: `npm run validate`.

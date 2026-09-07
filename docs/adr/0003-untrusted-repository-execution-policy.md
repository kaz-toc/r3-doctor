# ADR 0003: Untrusted repositories cannot own execution policy

## Status

Accepted

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

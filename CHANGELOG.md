# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Assessment contract v4 with contribution points, score breakdown, calibration status, and actionable intervention fields
- Report views (`facts`, `summary`, `actions`, `all`) for independently selectable human-readable output
- Calibration quality summary (`uncalibrated`, `provisional`, `validated`) on standard diagnosis reports
- Regression contract `REG-2026-021` for actionable report quality

### Changed

- Markdown and console formatters project a single view model instead of dumping all evidence in every view
- v3 baselines and diffs return explicit incompatibility reasons instead of silent score deltas

### Fixed

- Human-readable reports no longer hide score meaning, calibration status, or top actionable next steps

## [0.1.1] - 2026-09-07

### Added

- Cursor release skill (`.cursor/skills/r3-doctor-release/`) for version bump, validate, tag, and npm publish workflow
- Untrusted repository boundary documentation and hardened release diagnostics

### Changed

- PROJECT.md branding aligned with Recovery Doctor positioning
- Release runbook updated for ongoing semver releases
- LLM execution separated from repository-controlled config; operator policy preserved without repo config
- Repository paths anonymized by default in reports

### Fixed

- GitHub advisory output escaping
- Bounded handling of repository-controlled inputs (config, glob, provider overrides)
- Centralized hardened Git execution
- Versioned semantic prompt contract
- Release hardening gaps from security review (PR #8, #9)

## [0.1.0] - 2026-09-07

### Added

- **r3-doctor** CLI — Regression Risk Recovery Doctor
- `scan` — repository snapshot diagnosis with Regression Risk Score, risk clusters, evidence, and interventions
- `diff` — baseline-aware risk delta against a Git ref
- `baseline`, `trend`, `policy`, `calibration`, `priorities`, `plugins`, `llm inspect` commands
- TypeScript / JavaScript deterministic analysis (Python / Go experimental stubs)
- Optional LLM semantic axis via ACP providers (copilot, cursor, codex, claude)
- Markdown, JSON, and console report formats
- GitHub PR advisory workflow integration

### Fixed

- Package runtime fixtures, plugin capability listing, semantic grounding/reporting, import and rename-aware blast-radius analysis, prompt/ACP deadlines, trend snapshot identity, and literal glob matching
- Assessment contract updated to v3 for corrected semantic cluster scoring and confidence

### Notes

- Read-only diagnostic tool; does not auto-fix code
- Regression Risk Score is a relative indicator, not a failure probability guarantee
- Persistence defaults to `.r3-doctor/` in the target repository

[0.1.1]: https://github.com/kaz-toc/r3-doctor/releases/tag/v0.1.1
[0.1.0]: https://github.com/kaz-toc/r3-doctor/releases/tag/v0.1.0

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

### Notes

- Read-only diagnostic tool; does not auto-fix code
- Regression Risk Score is a relative indicator, not a failure probability guarantee
- Persistence defaults to `.r3-doctor/` in the target repository

[0.1.0]: https://github.com/kaz-toc/r3-doctor/releases/tag/v0.1.0

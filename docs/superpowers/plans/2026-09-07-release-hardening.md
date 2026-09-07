# r3-doctor Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all eleven reproduced release, semantic, dependency-analysis, diff, glob, and trend correctness defects and publish the result as one reviewed PR.

**Architecture:** Keep ownership at existing boundaries: package metadata owns runtime assets; Semantic validates and budgets provider interaction; Evidence parses source syntax and resolves paths; Assessment clusters grounded signals; Persistence verifies snapshot identity before writing. The CLI only orchestrates and renders these contracts.

**Tech Stack:** TypeScript, Node.js 22, TypeScript Compiler API, Zod, Vitest, Git, npm

**Spec:** `docs/superpowers/specs/2026-09-07-release-hardening-design.md`

## Global Constraints

- Implement every behavior change test-first and record the failing focused test before production edits.
- Preserve existing public schemas unless correctness requires a version bump; bump the assessment contract when score meaning changes.
- Do not send a prompt larger than `maxPromptBytes` and do not retain hallucinated repository paths.
- Do not derive persistence identity from mutable Git state after diagnosis.
- Verify the installed tarball, not only source-tree behavior.

---

### Task 1: Package Runtime Assets and Plugin Catalog

**Files:**
- Modify: `package.json`, `package-lock.json`, `README.md`
- Modify: `src/cli.ts`
- Modify/Create: package and CLI tests under `tests/`

- [x] Add a package regression test that packs, extracts, and runs golden calibration and policy evaluation.
- [x] Add a CLI regression test requiring every registered plugin to report non-empty capabilities.
- [x] Run the focused tests and verify RED.
- [x] Include runtime fixtures in the package and render plugin declarations directly.
- [x] Run the focused tests and verify GREEN.

### Task 2: Ground Semantic Results and Preserve Them in Reports

**Files:**
- Modify: `src/semantic/provider.ts`
- Modify: `src/assessment/risk.ts`
- Modify: `src/reporting/format.ts`
- Modify: `src/schema/report.v1.ts`
- Test: semantic, risk, and reporting test files under `tests/`

- [x] Add regressions for absolute, escaping, prefix-sibling, and missing finding paths.
- [x] Add semantic-only formatting and cluster path/score/confidence regressions.
- [x] Add unrelated same-mechanism evidence clustering regression.
- [x] Run focused tests and verify RED.
- [x] Validate finding paths against exact snapshot membership and related evidence membership.
- [x] Split non-cycle clusters by path and derive semantic cluster values from findings.
- [x] Treat semantic findings as visible axis signals and update the assessment contract.
- [x] Run focused tests and verify GREEN.

### Task 3: Enforce Prompt and ACP Setup Deadlines

**Files:**
- Modify: `src/semantic/context-budget.ts`, `src/semantic/semantic-prompt.ts`
- Modify: `src/semantic/providers/acp-semantic-provider.ts`
- Modify: `src/semantic/acp/acp-client.ts`, `src/semantic/acp/constants.ts`
- Test: semantic prompt/provider/ACP tests under `tests/`

- [x] Add a provider-spy regression proving an oversized completed prompt is never sent.
- [x] Add silent initialize and silent session setup timeout regressions with short injected deadlines.
- [x] Run focused tests and verify RED.
- [x] Validate final UTF-8 prompt bytes before provider dispatch.
- [x] Add independently configurable initialization and session-setup deadlines with process cleanup.
- [x] Run focused tests and verify GREEN.

### Task 4: Parse Imports and Retain Deleted-Target Blast Radius

**Files:**
- Modify: `src/evidence/deterministic.ts`
- Modify: `src/commands/diff.ts`
- Modify: `package.json`, `package-lock.json`
- Test: evidence and diff tests under `tests/`

- [x] Add regressions for comments, `require()`, dynamic `import()`, and all index extension variants.
- [x] Add deleted and renamed TypeScript target blast-radius regressions.
- [x] Run focused tests and verify RED.
- [x] Replace regex extraction with TypeScript AST traversal and move TypeScript to runtime dependencies.
- [x] Resolve against snapshot files plus changed-file virtual targets with extension substitution.
- [x] Run focused tests and verify GREEN.

### Task 5: Escape Glob Literals and Bind Trend Writes to Snapshots

**Files:**
- Modify: `src/intake/snapshot.ts`
- Modify: `src/persistence/snapshot-integrity.ts`, `src/persistence/trend-store.ts`
- Test: snapshot/config and trend tests under `tests/`

- [x] Add literal regex-metacharacter glob regressions.
- [x] Add a Git fixture that advances HEAD after diagnosis and requires trend persistence to reject it.
- [x] Add report/snapshot mismatch and unchanged-state success regressions.
- [x] Run focused tests and verify RED.
- [x] Compile glob patterns character-by-character with explicit wildcard semantics.
- [x] Persist `snapshot.sourceCommitSha` only after repository-state and metadata validation.
- [x] Run focused tests and verify GREEN.

### Task 6: Verification, Review, and PR

- [x] Run all focused regression files.
- [x] Run `npm run validate` and `git diff --check`.
- [x] Build an npm tarball in a temporary directory and run installed CLI smoke tests.
- [x] Review `main...HEAD` against repository standards and this spec; fix every confirmed issue.
- [x] Re-run full verification after review fixes.
- [ ] Commit coherent changes, push `fix/release-hardening`, and create a PR with findings and verification evidence.

# Untrusted Repository Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a scanned repository from selecting processes, receiving provider secrets, injecting GitHub commands, or causing unbounded glob work.

**Architecture:** Keep an effective `llm` config in the snapshot for compatibility, but source it exclusively from an operator-owned CLI execution policy. Sanitize each output and subprocess boundary at the module that owns it.

**Tech Stack:** Node.js 22, TypeScript, Commander, Zod, Vitest, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-09-07-untrusted-repository-boundary-design.md`

## Global Constraints

- The target repository and every file/config/ref originating in it are untrusted.
- LLM execution remains disabled unless the operator supplies `--llm-provider`.
- Provider environment allowlists and ACP confinement remain intact.
- Every behavior change follows a witnessed RED/GREEN test cycle.
- Full completion requires `npm run validate`.

---

### Task 1: Operator-owned LLM execution policy

**Files:**
- Modify: `src/shared/config.ts`
- Create: `src/semantic/execution-policy.ts`
- Modify: `src/intake/snapshot.ts`
- Modify: `src/cli.ts`
- Modify: `src/commands/diff.ts`
- Test: `tests/intake.test.ts`
- Test: `tests/phases.test.ts`
- Test: `tests/integration.test.ts`

**Interfaces:**
- Consumes: Commander option values and the target repository config JSON.
- Produces: `parseLlmExecutionPolicy(options, dryRun): LlmConfig` and `createRepositorySnapshot(path, unitId, llmConfig)`.

- [x] Add tests proving a target `llm` block is rejected and an operator-injected policy alone can start the fake ACP provider.
- [x] Run the focused tests and confirm failures originate from the current repo-controlled `llm` behavior.
- [x] Split `repositoryConfigSchema` from `effectiveConfigSchema`, add bounded operator policy parsing, and thread it through scan/diff.
- [x] Run focused semantic, intake, integration, comparison, and assessment tests to green.
- [x] Commit the completed boundary.

### Task 2: Safe GitHub reporting and workflow

**Files:**
- Modify: `src/reporting/github.ts`
- Modify: `tests/github.test.ts`
- Modify: `.github/workflows/r3-doctor-advisory.yml`

**Interfaces:**
- Consumes: schema-validated but untrusted diff strings.
- Produces: percent-escaped workflow commands and flattened escaped Markdown.

- [x] Add failing tests with newline, comma, colon, percent, Markdown, and HTML payloads.
- [x] Confirm the tests expose separate workflow command lines and injected Markdown.
- [x] Implement `escapeWorkflowData`, `escapeWorkflowProperty`, and `escapeMarkdownText`; least-privilege the advisory workflow.
- [x] Run GitHub reporting and integration tests to green.
- [x] Commit the reporting boundary.

### Task 3: Bounded glob and Git input handling

**Files:**
- Modify: `src/intake/snapshot.ts`
- Modify: `src/shared/config.ts`
- Modify: `src/adapters/git-provider.ts`
- Test: `tests/intake.test.ts`
- Test: `tests/diff.test.ts`

**Interfaces:**
- Consumes: untrusted exclude glob strings and CLI Git refs.
- Produces: memoized glob matching and a validated full commit object ID.

- [x] Add failing tests for regex metacharacter literals, adversarial wildcard input, leading-dash refs, and malformed object output.
- [x] Confirm the matcher test either mis-matches or exceeds its bounded runtime and the Git test reaches option parsing.
- [x] Replace regex construction with memoized matching, add config bounds, use `--end-of-options`, and validate object IDs.
- [x] Run intake, diff, comparison, and integration tests to green.
- [x] Commit the input boundary.

### Task 4: Default repository-path privacy and documentation

**Files:**
- Modify: `src/shared/redaction.ts`
- Modify: `tests/redaction.test.ts`
- Modify: `tests/persistence.test.ts`
- Modify: `.gitignore`
- Modify: `r3-doctor.config.json`
- Modify: `README.md`
- Modify: `docs/spec/provider-adapters.md`
- Modify: `docs/spec/audit-retention-policy.md`
- Create: `docs/adr/0003-untrusted-repository-execution-policy.md`

**Interfaces:**
- Consumes: reports containing an internal absolute repository path.
- Produces: external and persisted reports with `metadata.repositoryPath === '[REPOSITORY]'`.

- [x] Add failing redaction and baseline persistence tests for default path anonymity.
- [x] Confirm the absolute path remains in current output before the fix.
- [x] Apply fixed repository-path anonymization and update configuration examples, trust-boundary docs, ignore rules, and LLM smoke invocation.
- [x] Run redaction, persistence, package, and documentation-adjacent tests to green.
- [x] Commit the privacy and documentation boundary.

### Task 5: Review and release evidence

**Files:**
- Modify only files required by review findings.

**Interfaces:**
- Consumes: `git diff main...HEAD`, repository standards, and the design spec.
- Produces: a reviewed, validated branch and pull request.

- [ ] Run `npm run validate` and inspect the complete output.
- [ ] Run parallel Standards and Spec reviews against `main` and resolve every Critical or Important finding.
- [ ] Re-run `npm run validate`, confirm the worktree is clean after commit, and push the branch.
- [ ] Create a pull request against `main` with security impact, RED/GREEN evidence, and validation results.

# Codebase review fixes implementation plan

**Goal:** Verify all 25 findings against current main and fix remaining defects with executable regression evidence, then push an isolated branch.
**Base:** origin/main `2a5d0ec` (PR #26 already addresses several validation findings).
**Spec:** `docs/reviews/2026-09-13-codebase-review.md`, Accepted ADRs, current public contracts.
**Architecture:** Keep fixes in their existing owners: validation persistence, repository intake/evidence, semantic execution, reporting. Preserve existing assessment weights and strength rubrics.
**Tech Stack:** TypeScript, Node.js >=22, Vitest, Git CLI.

## Constraints

- Preserve original checkout and its untracked review document.
- Verify each claim against current main; record already-fixed or unsupported claims explicitly.
- Add regression tests before fixes; run focused tests after each group.
- Implementation agents do not spawn reviewers or commit. Parent integrates and records incident contracts.
- One final independent review of fixed BASE..HEAD, at most one bundled correction and one scoped re-review.
- Push the branch; no merge, release, deployment, or external messages.

## Tasks

- [x] Validation: verify H3/M1/M2/M6/M7/M8/L2/L6/L8 against current main; fix remaining persistence and input-contract defects. Own `src/validation/`, validation tests. Coordinate cross-boundary changes with parent.
- [x] Intake/evidence: reproduce H2/M5/L4/L5/L9 with dense graphs, symlink roots, duplicate imports, Unicode/space churn paths, oversized source; fix in intake/evidence/git adapter, preserving score rubrics.
- [x] Semantic: verify H1/M9/M10/L10 using fake ACP and dry-run prompts; isolate provider runtime, enforce documented send scope and partial profile behavior. Coordinate scan integration with parent.
- [x] CLI/reporting/calibration: reproduce M3/M4/M11/M12/L1/L3/L7 and fix output composition, bounded reads, eligibility handling, Markdown escaping, early option validation, harness diagnostics.
- [x] Record every finding's disposition in review follow-up, register active incident regression cases and boundary evidence.
- [ ] Run `npm run validate`; run applicable persistence, provider, policy and CLI boundary checks.
- [ ] Commit, one fixed-range independent review, address blocking findings once if needed, scoped re-review, push and verify remote SHA.

## Verification commands

Run each relevant file with `npx vitest run <test files>` after first observing its new regression fail on the prior production code. Harness corrections use `npm run harness:test`. Final acceptance requires `npm run validate` with no weakened checks.

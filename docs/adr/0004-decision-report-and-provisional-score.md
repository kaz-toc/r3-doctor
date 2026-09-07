# ADR 0004: Actionable report contract and provisional score

## Status

Accepted

## Context

Regression Risk Score and human-readable reports previously mixed display formatting with underspecified scoring semantics. Severity bands could diverge from underlying measurements, axis contribution was expressed as a ratio rather than points, and saved baselines could be compared across contract versions without an explicit incompatibility reason. Teams could not audit why a score changed or start work from a report without reading the full evidence dump.

## Decision

- Adopt assessment contract v4 with versioned schema boundaries: report schema v2, baseline schema v4, diff schema v3.
- Treat `Evidence.strength` as the canonical continuous signal intensity (0–100). Derive `Evidence.severity` as a display band from strength; callers must not override severity independently of strength.
- Require actionable report fields: `Evidence.rationale`, `Evidence.pathRole`, `Evidence.relatedPaths`; axis `contributionPoints` and `scoreBreakdown`; repository `scoreBreakdown`, `confidenceBreakdown`, and `calibration`; intervention `rationale`, `firstStep`, `priorityScore`, and `verificationHorizon`.
- Use a provisional v4 score formula documented in the assessment contract. Change strength rubrics or axis weights only through a new assessment contract version after calibration, never by silently migrating stored reports.
- Keep reporting formatters read-only over the versioned report. Do not ask an LLM to rescore or reprioritize for display.
- Compare baselines only when assessment contract, report schema, redaction policy, and analysis context all match. Return an explicit incompatibility reason and suppress `riskDelta` and signal change sets otherwise. Do not implicitly migrate v3 baselines or trends.

## Consequences

- Saved v3 baselines and reports become incompatible until rescanned under v4.
- Implementations must populate new required fields even before Task 2–6 refine their values.
- Formatter-only shortcuts cannot hide score or intervention quality problems; contract and assessment owners must change together.
- Calibration changes interpretation status and future contract versions; they do not rewrite historical score values in place.

## Alternatives

- Formatter-only report shortening: rejected because it preserves ambiguous scores and non-actionable interventions.
- LLM scoring and summarization: rejected because it breaks reproducibility, offline use, and evidence traceability.
- Silent migration of stored baselines: rejected because it hides contract drift and invalid comparisons.

## Enforcement

- Schema and compatibility: `tests/schema.test.ts`, `tests/comparison.test.ts`
- Regression contract: `test-fixtures/regressions/REG-2026-021/case.json`, `docs/incidents/LEDGER.md`
- Contract docs: `docs/spec/assessment-contract.md`, `docs/spec/deterministic-signals.md`, `docs/spec/feedback-collection.md`, `CONTEXT.md`

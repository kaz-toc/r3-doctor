# Decision report fixture

Synthetic v4 `DiagnosisReport` used by `tests/reporting.test.ts` and `REG-2026-021`.

## Shape

- 70 `Evidence` items for the same `dependency-cycle` mechanism
- 7 clusters with repeated mechanism/trigger patterns
- 6 interventions (actions view shows top 5)
- Semantic ambiguity unevaluated
- Python and Go analyzers partially unevaluated

## Source

The report payload is built programmatically in `tests/fixtures/reporting/decision-report.fixture.ts` via `buildDecisionReportFixture()`.

## View expectations

| View | Top-level chapter | Line budget | Must not include |
|---|---|---|---|
| `facts` | `Current state` | 180 | `Improvement points`, score interpretation |
| `summary` | `Assessment summary` | 100 | `Improvement points`, raw evidence table |
| `actions` | `Improvement points` | 120 | `Current state`, full axis table |
| `all` | `Diagnosis summary`, `Improvement points`, `Current state` (in order) | 300 | duplicate evidence excerpts |

Fixture line counts (2026-09-07): `facts` 46, `summary` 93, `actions` 57, `all` 146. `summary` shows 5 clusters (2 remaining), `actions` shows 5 interventions (1 remaining).

JSON output always returns the full report regardless of `--view`.

## Regression contract

`REG-2026-021` protects:

- `facts` stays within the 180-line budget while grouping evidence
- `summary` shows calibration status and top clusters without dumping all evidence
- `actions` shows the top 5 actionable interventions
- `all` renders exactly three chapters once
- JSON retains every evidence ID for traceability from human-readable views

Executable contract: `test-fixtures/regressions/REG-2026-021/report-quality.test.ts`

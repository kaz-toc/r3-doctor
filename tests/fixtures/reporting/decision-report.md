# Decision report fixture

Synthetic v4 `DiagnosisReport` used by `tests/reporting.test.ts` and `REG-2026-021`.

## Shape

- 70 `Evidence` items for the same `dependency-cycle` mechanism
- 7 clusters with repeated mechanism/trigger patterns
- 6 interventions (actions view shows all 6 within the 8-item limit)
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

Fixture line counts (2026-09-07): `facts` 47, `summary` 91, `actions` 68, `all` 159. `summary` shows 5 clusters (2 remaining), while `actions` shows all 6 interventions.

JSON output always returns the full report regardless of `--view`.

## Regression contract

`REG-2026-021` protects:

- `facts` stays within the 180-line budget while grouping evidence
- `summary` shows calibration status and top clusters without dumping all evidence
- `actions` shows up to 8 actionable interventions with priority score, confidence, cost, 5 target paths, and 5 linked evidence IDs
- `all` renders exactly three chapters once
- JSON retains every evidence ID for traceability from human-readable views

Executable contract: `test-fixtures/regressions/REG-2026-021/report-quality.test.ts`

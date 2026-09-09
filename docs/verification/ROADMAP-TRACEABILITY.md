# ROADMAP 追跡表

設計仕様 `2026-09-06-roadmap-completion-design.md` の完了条件とテストの対応。

| ROADMAP Phase / 成功条件 | 状態 | テスト |
|---|---|---|
| Phase 0: schema と golden fixtures | 完了 | `tests/schema.test.ts`, `tests/golden.test.ts` |
| Phase 1: scan と決定論的診断 | 完了 | `tests/scan.test.ts`, `tests/evidence.test.ts`, `tests/intake.test.ts` |
| Phase 2: intervention と before/after | 部分完了 | `tests/intervention.test.ts` |
| Phase 3: diff / blast radius / GitHub | 部分完了 | `tests/diff.test.ts`, `tests/github.test.ts`, `.github/workflows/r3-doctor-advisory.yml` |
| Phase 4: calibration / golden regression | スタブ | `tests/calibration.test.ts`, `tests/redaction.test.ts` |
| Phase 5: plugin capability negotiation / ACP semantic | 部分完了 | `tests/phases.test.ts`, `tests/operations.test.ts`, `tests/integration.test.ts`, `tests/semantic/acp-client.test.ts` |
| Phase 6: trend / policy / retention | 部分完了 | `tests/operations.test.ts`, `tests/redaction.test.ts` |
| 成功条件 1: scan が capability を報告 | — | `tests/scan.test.ts`, `tests/phases.test.ts` |
| 成功条件 2: diff が DiffReport を返す | — | `tests/diff.test.ts` |
| 成功条件 3: schema 参照整合性 | — | `tests/schema.test.ts` |
| 成功条件 4: mechanism-based clustering | — | `tests/assessment.test.ts`, `tests/scan.test.ts` |
| 成功条件 5: Risk Assessment が score を確定 | — | `tests/assessment.test.ts` |
| 成功条件 6: 言語 capability negotiation | — | `tests/phases.test.ts` |
| 成功条件 7: semantic 未評価 fallback | — | `tests/scan.test.ts` |
| 成功条件 8: redaction / retention / gate | — | `tests/redaction.test.ts`, `tests/phases.test.ts` |
| 成功条件 9: 全出力に根拠 | — | `tests/scan.test.ts`, `tests/integration.test.ts`, `tests/github.test.ts` |
| 成功条件 10: validate + 境界テスト | — | `npm run validate`, `tests/integration.test.ts`, `docs/verification/BOUNDARY-MATRIX.md` |

## PR #2 focused verification

| 検証対象 | 正確な focused test / command |
|---|---|
| 物理保存先 containment | `npm test -- tests/persistence.test.ts -t "rejects an intermediate storage component symlink without touching its target"`; `npm test -- tests/persistence.test.ts -t "rejects a storage directory symlink without touching its target"`; `npm test -- tests/persistence.test.ts -t "rejects a trend history symlink without reading its target"` |
| commit-bound comparison | `npm test -- tests/comparison.test.ts -t "suppresses every baseline-derived field when the saved commit does not match --base"`; `npm test -- tests/comparison.test.ts -t "derives the displayed base and risk delta from the one commit-matched baseline"`; `npm test -- tests/comparison.test.ts -t "preserves baselines for different commits that have the same analysis input ID"` |
| redaction comparison | `npm test -- tests/comparison.test.ts -t "compares a redacted current copy without mutating the raw current report"`; `npm test -- tests/comparison.test.ts -t "keeps reordered overlapping redaction policies compatible without false signal changes"` |
| semantic injection / ACP factory | `npm test -- tests/phases.test.ts -t "returns available for a configured codex provider"`; `npm test -- tests/phases.test.ts -t "returns findings from the actual provider supplied by an injected semantic factory"`; `npm test -- tests/integration.test.ts -t "evaluates semantic ambiguity through the default factory with fake ACP spawn"`; `npm test -- tests/integration.test.ts -t "routes an injected semantic provider through runDiagnosis"` |
| runtime capability | `npm test -- tests/phases.test.ts -t "marks git churn unevaluated when a TypeScript snapshot has no Git history"`; `npm test -- tests/assessment.test.ts -t "does not let unsupported git churn evidence override capability negotiation"`; `npm test -- tests/integration.test.ts -t "marks change volatility unevaluated for a non-Git repository snapshot"` |
| custom calibration conditions | `npm test -- tests/phases.test.ts -t "requires each policy-defined calibration condition for gate eligibility"`; `npm test -- tests/calibration.test.ts -t "rejects blank or duplicate persisted calibration conditions"` |
| shallow-checkout independence | `npm test -- tests/review-fixes.test.ts -t "creates two commits without seed files"`; a local `file://` depth-1 clone followed by `npm ci` and `npm run validate` |
| llm provider catalog CLI smoke | `npm run verify:llm-catalog`; runs after build inside `npm run validate` |
| real codex-acp semantic smoke | `R3_DOCTOR_LLM_INTEGRATION=1 OPENAI_API_KEY=... npm run smoke:llm-integration`; CI: `.github/workflows/llm-integration.yml` (`workflow_dispatch`, requires repo var `R3_DOCTOR_LLM_INTEGRATION=1`, runs `llm list --inspect --provider codex` before smoke) |

## Persistence rollback procedure

Task 6 changes TypeScript module ownership and CLI audit output only. Baseline schema v2 and trend schema v1 stay unchanged, so an on-disk migration rollback is N/A: there is no migration to reverse and the pre-Task-6 build reads the same persisted entries.

Operational rollback is:

1. Stop concurrent `r3-doctor` persistence commands.
2. Reinstall or rebuild the immediately preceding known-good revision (`ac5308e`).
3. Re-run the baseline round-trip and trend parsing focused tests before resuming writers.
4. If expired entries must be recovered, restore `.r3-doctor/baselines/*.json` and `.r3-doctor/trends/history.jsonl` from the pre-deployment repository backup. Verify `.r3-doctor` and its storage directories are not symbolic links before restoring; do not copy through a symlink.

Retention intentionally removes expired entries and is not itself reversible. Operational deployment must therefore back up retained persistence files before enabling the new build when expired history may still be needed.

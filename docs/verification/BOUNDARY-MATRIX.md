# 境界検証マトリクス

変更された境界から証拠を選ぶ。複数境界が変更された場合は、それぞれの証拠の和が必要。

| 変更された境界 | 必要な証拠 |
|---|---|
| 純ドメインまたは内部構造ロジック | 単体テストと影響を受ける回帰契約 |
| 永続化または migration | ラウンドトリップテスト、互換性証拠、ロールバック手順 |
| 認証、プロバイダ、外部 API | 契約テストと、環境がある場合の認証済み canary |
| UI | ブラウザプレビューまたは実プロダクトホストでの操作証拠 |
| パッケージ化、ホスト登録、デプロイ | パッケージ成果物またはデプロイ済み smoke test |
| CI またはポリシー | 意図した違反を検出することを証明する checker テスト |

プルリクエストに正確なコマンドまたは観測を記録する。`N/A` は、変更パスと契約に結びついた具体的理由がある場合のみ許可。

コピー先プロダクトは、スタック選択後に汎用証拠を正確なコマンドへ置き換える。

## report-quality-improvement (REG-2026-021)

| 境界 | 証拠 |
|---|---|
| Risk Assessment | `npm test -- tests/assessment.test.ts tests/golden.test.ts` — `fragile-cart > fragile-cart-improved >= stable-cart`、連続 metric の単調性 |
| Recommendation | `npm test -- tests/recommendation.test.ts tests/reporting.test.ts` — 同一 basis Evidence から path / metric / verification ID を導出し、実効 confidence で優先度を算出 |
| Diff relevance | `npm test -- tests/diff.test.ts tests/integration.test.ts` — new/worsened → direct change → blast radius、baseline 非互換・未保存時の direct/blast action |
| Reporting | `npm test -- tests/reporting.test.ts test-fixtures/regressions/REG-2026-021/report-quality.test.ts` — summary 上限の維持、actions/facts 上限の拡張、3章 `all`、calibration status |
| schema compatibility | `npm test -- tests/schema.test.ts tests/comparison.test.ts` — v3 baseline は明示的 incompatibility reason |

Fixture contract (2026-09-07): `facts` 47 lines, `summary` 91 lines, `actions` 68 lines, `all` 159 lines with 3 chapters. Summary remains 5 clusters (+2 remaining); actions shows all 6 fixture interventions within the 8-item limit.

Dogfood on r3-doctor (2026-09-07):

- `node dist/cli.js scan . --locale en --format markdown --view actions`: 88 Markdown lines, 8 actions (+0 remaining), maximum 5 visible target paths per action. All 8 actions include priority/confidence/cost, linked Evidence ID, and the exact rescan command. No PR relevance is emitted for scan, and no path/metric Evidence mismatch was observed.
- `node dist/cli.js diff . --base origin/main --locale en --format markdown --view actions`: no stored baseline; 96 Markdown lines plus one warning line, 8 relevant actions (+0 remaining), maximum 5 visible target paths. All 8 include PR relevance (5 `direct-change`, then 3 `blast-radius`), priority/confidence/cost, linked Evidence ID, and the rescan command; no unrelated action was emitted.
- `npm run validate`: 44 harness tests and 284 Vitest tests passed, followed by successful typecheck and build.

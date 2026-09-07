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
| Recommendation | `npm test -- tests/reporting.test.ts` — 上位 5 actions、各 action に rationale / first step / verification |
| Reporting | `npm test -- test-fixtures/regressions/REG-2026-021/report-quality.test.ts` — view 別 line budget、3章 `all`、calibration status |
| schema compatibility | `npm test -- tests/schema.test.ts tests/comparison.test.ts` — v3 baseline は明示的 incompatibility reason |

Dogfood on r3-doctor (2026-09-07, fixture contract): `facts` 46 lines, `summary` 93 lines, `actions` 57 lines, `all` 146 lines with 3 chapters; summary shows 5 clusters (+2 remaining), actions shows 5 interventions (+1 remaining); golden score distinctness PASS.

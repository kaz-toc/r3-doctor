# 2026-09-13 コードベースレビュー対応

元の指摘は [レビュー原文](2026-09-13-codebase-review.md)（d0626c9）を保持。対応ブランチは最新 default `origin/main` の `2a5d0ec`（PR #26）から作成した。

25件を照合し、19件を修正、5件は現在の main で既修正、1件は仕様を明記した。外部エージェントでの悪用実験は実施せず、H1 は起動境界の違反を fake ACP で再現・保護した。

| ID | 結論・対応 | 証拠 |
|---|---|---|
| H1 | 起動時・session とも毎回空の一時 cwd。対象 repo の executable/PATH 排除は独立して維持 | REG-2026-030 |
| H2 | 全経路探索を反復 SCC 検出へ置換。成分ごとに1件、再帰なし | REG-2026-029 |
| H3 | 既知の未追跡 validation artifact だけ clean 判定から除外。tracked/rename/任意ソースは検出 | REG-2026-028 / 029 |
| M1 | threshold は PR #26 で修正済み。残るスコア変化の衝突は非時刻 payload 全体のハッシュで修正 | REG-2026-028 |
| M2 | PR #26 で修正済み。非標準 cohort は現行 spec の exploratory。miss-rate 自体は保存閾値で計算 | validation-issues.test.ts |
| M3 | setup 内 scan に出力先を注入し stdout を抑止。setup の JSON 値は1つ | REG-2026-032 |
| M4 | calibration の物理境界・通常ファイル・256 KiB制限。JSON/schemaエラーに内容を含めない | REG-2026-031 |
| M5 | unit root と祖先の symlink を拒否、実パス包含を確認。`..sources` は許可 | REG-2026-029 |
| M6 | PR #26 で修正済み。無関係なファイルは無視、不正JSON artifactは拒否 | REG-2026-028 |
| M7 | PR #26 で修正済み。occurredAt > observedAt は拒否 | REG-2026-028 |
| M8 | PR #26 で修正済み。既存policyに合わせ小数・逆順thresholdを保存可能 | validation-issues.test.ts |
| M9 | changed は実 Git 差分、cluster-context は対象＋直接の依存先/元。dry-run と実送信で共通選択 | REG-2026-030 |
| M10 | audit-retention-policy の既存仕様は出力・保存時のマスク。LLM prompt の送信制御とは別とREADMEにも明記 | README / audit-retention-policy |
| M11 | スコア対象 finding が0件なら semantic 軸を集計から除外し、診断所見は保持 | REG-2026-033 |
| M12 | Markdown の動的文字列を境界でescape。コードスパンには適切な backtick 区切り | REG-2026-034 |
| L1 | diff format/view を intake・診断より先に検証 | REG-2026-032 |
| L2 | 残る outcome 入力エラーを簡潔な ConfigError へ。format の R3DoctorError 化は既修正 | REG-2026-028 |
| L3 | harness の変数展開・単一 backslash の検査を修正 | REG-2026-035 |
| L4 | 同じ依存先/元の import を重複排除 | REG-2026-029 |
| L5 | Git churn をNUL区切りで取得し、空白除外を削除。Unicode・tab・改行も保持 | REG-2026-029 |
| L6 | PR #26 で120秒へ既修正。最新mainの基準実行362件全成功 | validation-cli.test.ts |
| L7 | calibration quality の省略時policyを defaultConfig と共有 | REG-2026-031 |
| L8 | snapshot の contract version を既存定数へ統一 | REG-2026-028 |
| L9 | source 1 MiB/ファイル、合計64 MiBの上限。超過理由を返す | REG-2026-029 |
| L10 | providerを持たない部分 profile はinactive。明示CLIのprovider必須制約は保持 | REG-2026-030 |

## 回帰証拠

- 基準: `npm test` — 51 files / 362 tests 成功。
- intake/evidence 新規テストは修正前10件失敗（密なDAG timeout、20,000頂点のstack overflowを含む）。関連67件成功、Git/送信scopeの最終関連41件成功。
- validation の残るM1/L2は修正前2件失敗→修正後5件成功。H3 CLI同時保存は実際のexit 2を観測→修正後成功。
- semantic: H1 6件、M9 5件＋特殊パス1件、L10 2件の失敗を確認。最終関連84件成功。
- calibration/CLI/assessment/Markdown: `tests/codebase-review.test.ts` は修正前13件失敗→修正後13件成功。
- harness: 新規ケースの変数名表示が修正前失敗→設定テスト9件成功。
- 最終レビューの追加2件: operator home からの setup と Python/Go 旧baseline比較の新規4件が修正前失敗→修正後成功。周辺8 files / 56 tests、typecheck、diff check成功。

## 互換性と復旧

v4の強度式・axis重みは維持。正しい循環成分・依存数・churnによりEvidence/scoreは変わり得るため、TypeScript analyzerを1.2.0、semantic providerを2.3.0へ更新した。全言語共通の `intakeImplementationVersion: "1.0.0"` もanalysis contextに追加し、source上限導入前のPython/Go baselineを含めて条件不一致とする。旧baselineは再scanして取得する。

validationのschema v1は維持。旧artifactを読み取り可能とし、削除・暗黙移行・スコア再計算を行わない。sample ID方式の更新後は同じcommitの再記録が別IDになることがある。復旧は修正前のCLIへ戻すことで可能。生成済みartifactは保持し、新旧方式の重複はsample IDと記録時刻を確認して運用で扱う。

## 境界検証

| 境界 | 実施する証拠 / 非該当理由 |
|---|---|
| 純ドメイン・内部構造 | SCC/依存/churn/semantic eligibilityの回帰テスト、golden |
| 永続化 | validation/baseline同時保存・再記録、旧schema読取、dirty/rename拒否、上記復旧手順 |
| provider | fake ACP process/session cwd・PATH・起動拒否・prompt scope。実provider canaryの結果は最終検証欄に記録 |
| UI | N/A: ブラウザ/GUI変更なし。CLI JSON/Markdownは実コマンド・formatterテストで確認 |
| パッケージ化/配備 | package.test.tsを全体validateで実行。配布設定・host登録・deploy変更なし |
| CI/policy | harnessの違反検出テスト。CI定義・チェック閾値・権限・依存の変更なし |

## 最終検証

- 初回の固定差分レビューは `2a5d0ec..a3f2437` を1回実施。Important 2件（setupの実対象path伝播、全言語intake互換性）を指摘。
- 1回の修正波 `a3f2437..b5f5135` に上記2件とM11に対応するcanary期待値修正を集約。同じ担当者が元の指摘と修正差分だけを1回再レビューし、2件の解消と残るCritical/Importantなしを確認。
- 修正波前の全体validateは45 harness tests / 55 files / 413 Vitest tests、typecheck、build、provider catalog検証が成功。
- 修正波後の最終 `npm run validate` は **exit 0**。45 harness tests、harness validate、typecheck、**57 files / 417 Vitest tests**、build、provider catalog 4件の検証がすべて成功。Vitest実行時間304.68秒。
- 実providerは通常環境で `@agentclientprotocol/codex-acp@1.10.0` のinspectがavailable。既定canaryの `gpt-5-mini` は当該認証環境で `model_unavailable` だったため、model discoveryが提示した `gpt-5.6-luna` を明示して最終ビルドを検証した。
- `R3_DOCTOR_LLM_INTEGRATION=1 R3_DOCTOR_LLM_MODEL=gpt-5.6-luna npm run smoke:llm-integration` — **exit 0 / ok: true**。provider available、所見2件。決定的な根拠のないfixtureでsemantic軸が未評価・score 0となるM11の契約も成功。canaryのモデル既定値は維持し、利用環境に応じた明示overrideを追加した。

既定並列の再実行中にホストの load average が約149まで上がり、異なるCLI/Gitテストで同時にタイムアウトした。他プロジェクトのテストも動作していたため、この作業のVitestプロセスと子プロセスだけを同定して停止。インストール済みVitestが対応する `VITEST_MAX_FORKS=2 VITEST_MIN_FORKS=1 VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=1` で並列数を抑えて最終検証を実施した。テストの除外、タイムアウト延長、CI設定変更は行っていない。

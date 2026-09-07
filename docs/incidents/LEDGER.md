# Incident Ledger

テンプレートにはプロダクト incident は含まれません。コピー先プロダクトは、確認済みのユーザー影響障害ごとに 1 行追加します。

## 保護状態

- `protected`: 既知の bad behavior または同等 mutant に対して実行可能テストが失敗し、active 回帰ケースが証拠を結ぶ
- `partially protected`: 関連パスの一部はテストされているが、元の観測可能な障害が証明されていない
- `unprotected`: 既知の障害を検出する実行可能契約がない

## Ledger

| Incident | User impact | Status | Root cause | Fix | Regression contract | Protection | Follow-up |
|---|---|---|---|---|---|---|---|
| codebase-review-2026-09-07#package-runtime-fixtures | 公開 package の calibration / policy が起動時に失敗する | fixed | runtime fixture が npm `files` から除外されていた | golden fixtures を配布物へ追加 | REG-2026-001 | protected | none |
| codebase-review-2026-09-07#semantic-path-grounding | 存在しない path の LLM 所見が score に影響する | fixed | repository prefix の文字列比較だけで grounding していた | snapshot file の完全一致を必須化 | REG-2026-002 | protected | none |
| codebase-review-2026-09-07#import-syntax | comment を依存と誤認し require / dynamic import を欠落する | fixed | import を正規表現で抽出していた | TypeScript AST で構文解析 | REG-2026-003 | protected | none |
| codebase-review-2026-09-07#deleted-target-blast-radius | 削除・rename 対象の依存元が diff に表示されない | fixed | current snapshot の存在 path だけで import を解決し rename の旧 path を失っていた | changed path の virtual resolution と name-status の old/new 保持 | REG-2026-004 | protected | none |
| codebase-review-2026-09-07#semantic-reporting | semantic score が人間向け出力で no signals と表示される | fixed | formatter と cluster が deterministic evidence だけを参照していた | semantic finding を表示・cluster score に反映 | REG-2026-005 | protected | none |
| codebase-review-2026-09-07#mechanism-clustering | 無関係な同種 signal が一つの cluster に混ざる | fixed | non-cycle mechanism の全 path を無条件に一括化していた | path-local component に分割 | REG-2026-006 | protected | none |
| codebase-review-2026-09-07#trend-snapshot-identity | 古い診断値が新しい commit の trend として保存される | fixed | 保存時 HEAD を entry identity に使用していた | snapshot/report/Git state を検証して snapshot SHA を保存 | REG-2026-007 | protected | none |
| codebase-review-2026-09-07#semantic-prompt-budget | 設定上限を超える source が LLM へ送信される | fixed | context packet だけを byte 計測していた | 完成 prompt を送信前に byte 検証 | REG-2026-008 | protected | none |
| codebase-review-2026-09-07#acp-setup-timeout | provider 無応答時に scan / inspect が終了しない | fixed | timeout が prompt 開始後にしか存在しなかった | initialize と session setup に deadline を追加 | REG-2026-009 | protected | none |
| codebase-review-2026-09-07#plugin-catalog | `plugins` が登録済み analyzer の capabilities を空表示する | fixed | 空 snapshot の negotiation を catalog に流用していた | plugin declaration を直接列挙 | REG-2026-010 | protected | none |
| codebase-review-2026-09-07#glob-escaping | `+` や `[]` を含む literal path の exclude が誤動作する | fixed | glob を不完全に正規表現へ置換していた | wildcard 以外の正規表現文字を escape | REG-2026-011 | protected | none |

証拠なしに root cause を推測しない。調査で確定するまで `unknown` を使う。

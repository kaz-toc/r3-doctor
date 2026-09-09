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
| SEC-2026-001 | Target config could enable/select an LLM process | fixed | Execution policy was mixed with repository config | CLI-owned strict LLM policy | REG-2026-012 | protected | — |
| SEC-2026-002 | Filenames could inject Actions commands or Markdown | fixed | Untrusted report values crossed output channels unescaped | Escape dedicated outputs and isolate ordinary logs | REG-2026-013 | protected | — |
| SEC-2026-003 | Adversarial exclude globs could exhaust CPU | fixed | Generated regex and aggregate work had no bound | DP matcher with scan-wide operation budget | REG-2026-014 | protected | — |
| SEC-2026-004 | Git refs could be parsed as options or non-OIDs | fixed | Missing option terminator and result validation | Reject leading dash, terminate options, validate full OID | REG-2026-015 | protected | — |
| SEC-2026-005 | Persisted reports revealed absolute repository paths | fixed | Path masking depended on optional policy | Fixed `[REPOSITORY]` external token | REG-2026-016 | protected | — |
| SEC-2026-006 | Oversized repository config was parsed without a byte cap | fixed | Unbounded read occurred before schema validation | Fixed-size bounded reader | REG-2026-017 | protected | — |
| SEC-2026-007 | Prompt limit excluded fixed/evidence content and leaked absolute path | fixed | Budgeting covered only a partial context packet | Budget final prompt and use repository token | REG-2026-018 | protected | — |
| SEC-2026-008 | Repository policy path could escape through traversal or symlink | fixed | Direct path join/read had no physical containment check | Contained regular-file resolver and policy bounds | REG-2026-019 | protected | — |
| SEC-2026-009 | Repository-influenced PATH could select Git/provider executables | fixed | Child lookup inherited unsafe PATH and Git inherited secrets | Sanitize lookup path, reject repo executables, allowlist Git env | REG-2026-020 | protected | — |
| report-quality-improvement#non-actionable-report | Human-readable report hides score meaning and actionable next steps | fixed | Contract v3 lacked strength, contribution points, calibration status, and view boundaries | ADR-0004 contract v4 and report views | REG-2026-021 | protected | none |
| pr-18-review#baseline-save-consistency | setup/check/scan で baseline 保存可否と dirty 時の remediation が食い違う | fixed | setup 独自の non-Git 拒否、dirty 判定より先の generic state 判定、未展開の path placeholder | persistence 契約へ eligibility とエラー順を揃え、実 repository path を案内 | REG-2026-023 | protected | none |
| PR #20 | 初回 scan を選ぶ前に LLM provider / model と operator profile を設定できない | fixed | scan prompt が LLM 設定ブロックより前に配置されていた | LLM 設定または defer 通知の完了後へ scan / baseline prompt を移動 | REG-2026-025 | protected | none |
| recent-pr-review-2026-09-09#setup-llm-coherence | setupで選択したLLMが初回scanへ反映されず、profile切替時に旧実行ファイルが残る | fixed | setupのscan境界へoperator選択を渡さず、profile更新時にprovider固有値を保持していた | 選択provider/model/profile pathを一貫して伝播し、provider変更時に旧実行ファイルを削除 | REG-2026-026 | protected | none |
| recent-pr-review-2026-09-09#catalog-profile-isolation | 壊れたoperator profileにより情報提供用`llm list`とrepository検証が失敗する | fixed | catalog生成が表示用profile metadataを必須入力として読み込んでいた | profile metadataをbest-effortにし、catalog verifierを隔離環境で実行 | REG-2026-027 | protected | none |

証拠なしに root cause を推測しない。調査で確定するまで `unknown` を使う。

# 決定論的リスクシグナル一覧 v4

LLM を使わず再現可能なシグナル。同一入力・同一設定で同一 Evidence Set を生成する。

| ID | 評価軸 | 説明 | 抽出方法 |
|---|---|---|---|
| `dep-cycle` | structural-fragility | 循環 import | import グラフ DFS |
| `high-fan-out` | change-blast-radius | 1 ファイルから多数へ依存 | fan-out > 閾値 |
| `high-fan-in` | change-blast-radius | 多数から 1 ファイルへ依存 | fan-in > 閾値 |
| `large-file` | structural-fragility | 大規模ソース | 非空行 > 閾値 |
| `missing-test-pair` | verification-gap | 対応テストファイル不在 | colocated ペアまたは tests/ からの import 参照 |
| `git-churn` | change-volatility | 短期間の高変更 | git log 集計 |
| `barrel-reexport` | structural-fragility | barrel 再エクスポート集中 | `export *` 検出 |
| `deep-nesting` | structural-fragility | 深いネスト | 括弧深度ヒューリスティック |
| `unresolved-import` | structural-fragility | 解決不能 import | 相対パス存在確認 |

各シグナルは `evidenceId`, `signalId`, `path`, `strength`, `rationale`, `pathRole`, `relatedPaths`, `severity`, `message`, `metrics` を持つ。

- `strength`: 0–100 の連続強度。binary signal は assessment contract に固定した provisional strength を使う。
- `rationale`: 再計算可能な根拠文字列（例: `value=10, onset=5, formula=v4-log2`）。
- `pathRole`: `product` / `test` / `tooling` / `generated` / `fixture`
- `relatedPaths`: 同じ mechanism 内で影響を受ける関連 path
- `severity`: strength から導出する表示 band。独立に書き換え不可。

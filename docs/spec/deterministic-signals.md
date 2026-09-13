# 決定論的リスクシグナル一覧 v4

LLM を使わず再現可能なシグナル。同一入力・同一設定で同一 Evidence Set を生成する。

| ID | 評価軸 | 説明 | 抽出方法 |
|---|---|---|---|
| `dep-cycle` | structural-fragility | 循環 import | 反復 Kosaraju による強連結成分（SCC） |
| `high-fan-out` | change-blast-radius | 1 ファイルから多数へ依存 | 重複を除いた依存先モジュール数 > 閾値 |
| `high-fan-in` | change-blast-radius | 多数から 1 ファイルへ依存 | 重複を除いた依存元モジュール数 > 閾値 |
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

循環は2頂点以上の強連結成分（または自己ループ）ごとに1件の Evidence を生成します。単純経路・循環の全列挙は行いません。グラフ走査は O(V+E) で、出力の安定化にはソートを使います。analyzer implementation version 1.2.0 でこの修正と依存の重複排除を識別し、旧解析条件の baseline との比較を抑止します。v4 の強度式・重みは変更しません。

Repository intake は symlink を含む unit root を拒否します。ソースは1ファイル1 MiBまで読み込み、それを超えるファイルは intake issue として除外します。収集したソースの合計が64 MiBを超える場合は IntakeError で終了します。calibration JSON は256 KiB上限で、symlink・非通常ファイルを拒否します。

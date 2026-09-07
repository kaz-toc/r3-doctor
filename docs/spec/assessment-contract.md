# 評価契約 v4

`schemaVersion: 2` の Assessment Contract（`assessmentContractVersion: 4`）。スコアは障害発生確率ではなく、同一契約内の優先順位と時系列比較に用いる相対指標である。

## 評価軸

| 軸 ID | 名称 | 方向 | 主シグナル |
|---|---|---|---|
| `structural-fragility` | Structural Fragility | 高いほど危険 | 循環依存、fan-out、責務混在 |
| `change-blast-radius` | Change Blast Radius | 高いほど危険 | 推移依存、共有契約、高 fan-in |
| `verification-gap` | Verification Gap | 高いほど危険 | テスト欠落、境界テスト不足 |
| `change-volatility` | Change Volatility | 高いほど危険 | churn、修正反復 |
| `semantic-ambiguity` | Semantic Ambiguity | 高いほど危険 | LLM 意味所見（決定論のみ時は未評価） |

## Signal Strength と severity

- `Evidence.strength`（0–100）が canonical な強度。障害確率ではない。
- `Evidence.severity` は strength から導出する表示 band であり、独立に上書きできない。
  - `strength >= 70` → `high`
  - `strength >= 40` → `medium`
  - それ以外 → `low`

## Axis score と contribution

各 axis は `scoreBreakdown`（`peak`、`breadth`、`diversity`）を必須とする。

```
score = round(0.65 * peak + 0.25 * breadth + 0.10 * diversity)
```

`contributionPoints` は Repository score のうち当該 axis が実際に加えた点数。旧 `contribution`（構成比）は廃止する。

## Repository score

`scoreBreakdown.axisBase` は評価済み axis の等重み平均。最大 cluster がそれを上回る場合のみ `criticalClusterUplift`（差分の 30%）を加える。

```
repositoryScore = round(axisBase + 0.30 * max(0, maxClusterScore - axisBase))
```

`confidenceBreakdown` は signal coverage、semantic analysis、git history、input completeness を 0–1 で示す。

`calibration.status` は outcome data に基づく解釈状態（`uncalibrated`、`provisional`、`validated`）。score 値そのものを実行時に書き換えない。

## 確信度

`confidence` は 0–1。`confidenceBreakdown` と整合する総合値。

## リスククラスター

同一 `failureMechanism` に関与するファイル群。クラスタースコアは関連シグナルの最大値と平均の混合。

## Intervention

各 intervention は `rationale`、`firstStep`、`priorityScore`、`verificationHorizon` を必須とする。

- primary path、metric、verification の Evidence ID は、同一の basis Evidence から導出する。
- priority に使う confidence は repository confidence と linked cluster confidence の小さい方とする。
- verification には `r3-doctor scan . --format json` と basis Evidence ID を含め、対象 signal の消失または弱化を再検証可能にする。
- human-readable な diff action は `new-or-worsened` → `direct-change` → `blast-radius` の順で PR 関連度を持ち、無関連の action は表示しない。比較可能な baseline がなくても、changed files と blast radius による関連度は評価する。
- summary は最大 5 clusters・各 3 Evidence を維持する。facts は各 group 8 Evidence、actions/all は最大 8 actions・各 5 target paths、actions 単体は各 5 linked Evidence まで表示する。

## 比較規則

- `assessmentContractVersion` と report schema version が一致するベースラインのみ差分可能。
- 契約不一致時は parse error ではなく「比較不能」として reason を返し、`riskDelta` と signal changes を出力しない。
- 保存済み v3 baseline / trend を暗黙 migration しない。

## 表示上の免責

すべてのレポートに locale に応じた disclaimer prose を含める（既定 `en`）:

> Regression Risk Score does not guarantee future regression probability. Use it with evidence and confidence for prioritization.

`locale: ja` では従来の日本語 disclaimer を使用する。

## レポート locale（`metadata.reportLocale`）

- 設定: `r3-doctor.config.json` の `"locale": "en" | "ja"`（既定 `en`）、または `scan` / `diff` の `--locale`
- 診断時に `metadata.reportLocale` へ記録（後方互換のため optional）
- **ハイブリッド表示**（`locale: ja` でも固定英語）: メトリクス行ラベル（Regression Risk Score, Confidence, Calibration, Unevaluated axes）、セクション見出し、フィールドラベル、軸名、Limitations 行
- **locale 依存**: disclaimer / mechanism / evidence.message / intervention 全文、formatter の残件 suffix（`and N more evidence` ↔ `他 N evidence`）
- legacy JSON（`reportLocale` なし）: formatter は suffix のみ `metadata.reportLocale ?? 'en'` で決定。本文 prose は生成時の言語のまま

## analysisContext fingerprint と locale

`analysisContextFingerprint` には **locale を含めない**。locale 変更は score / evidence ID に影響せず、同一リポジトリで `en` / `ja` を切り替えても baseline score 比較は可能。文言差分は `metadata.reportLocale` と各 message フィールドで追跡する。

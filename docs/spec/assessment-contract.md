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

## 比較規則

- `assessmentContractVersion` と report schema version が一致するベースラインのみ差分可能。
- 契約不一致時は parse error ではなく「比較不能」として reason を返し、`riskDelta` と signal changes を出力しない。
- 保存済み v3 baseline / trend を暗黙 migration しない。

## 表示上の免責

すべてのレポートに次を含める:

> Regression Risk Score は将来のデグレ発生確率を保証しません。根拠と確信度とともに優先順位付けに使用してください。

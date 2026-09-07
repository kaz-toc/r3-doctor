# 診断フィードバック収集形式 v2

チームが診断の有用性を記録し、校正データへ反映するための JSON 形式。

```json
{
  "schemaVersion": 2,
  "reportInputId": "8bdc00e7b38300bb",
  "assessmentContractVersion": 4,
  "submittedAt": "2026-09-05T14:00:00.000Z",
  "outcome": "false-positive",
  "clusterId": "cluster:structural-fragility",
  "signalId": "dep-cycle",
  "actionTaken": "cycle を許容し監視のみ継続",
  "verificationOutcome": "follow-up scan で score は変化せず",
  "scoreBefore": 62,
  "scoreAfter": 58,
  "notes": "既知の許容サイクル。実際のデグレは発生していない。",
  "linkedIncident": "optional-issue-or-hotfix-id"
}
```

## outcome 値

| 値 | 意味 |
|---|---|
| `confirmed-risk` | 診断どおりデグレが発生または発生しそうだった |
| `false-positive` | リスクは過大評価だった |
| `missed-risk` | 診断が見逃したデグレが発生した |
| `helpful` | 打ち手が有効だった |
| `not-actionable` | 根拠は正しいが実行可能でなかった |

## v4 追加フィールド

| フィールド | 意味 |
|---|---|
| `actionTaken` | チームが実際に取った対応 |
| `verificationOutcome` | 再診断・運用確認の結果 |
| `scoreBefore` | 対応前の Regression Risk Score |
| `scoreAfter` | 対応後の Regression Risk Score |
| `assessmentContractVersion` | フィードバック対象の評価契約 version |

保存先: `.r3-doctor/feedback/*.json`（gitignore 推奨）

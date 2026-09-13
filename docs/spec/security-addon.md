# Security Add-on 契約 v1

`SecurityAssessment`（`schemaVersion: 1`、`analysisContractVersion: 1`）と、それを core report と合成する `AnalysisResult` envelope の公開契約。設計判断は [ADR 0006](../adr/0006-security-addon.md)、実装は `src/schema/security-assessment.v1.ts` と `src/schema/analysis-result.v1.ts` にある。

所見は「要確認の脆弱性候補」であり、再現済みの脆弱性や安全性の保証ではない。Regression Risk Score、Semantic Ambiguity、calibration、shadow score、core baseline fingerprint へ加算しない。

## 完了状態

| `status` | 定義 | 追加の不変条件 |
|---|---|---|
| `disabled` | 機能が要求されていない。通常出力へ追加しない | findings 空、provider 呼び出し 0 |
| `blocked` | 要求はあるが operator の許可がない | findings 空、呼び出し 0、reason 1 件以上 |
| `unavailable` | provider 未設定・未導入・認証不可・実行制限未確認・対象言語なし | findings 空、呼び出し 0、reason 1 件以上 |
| `failed` | 有効な評価単位が 0 | findings 空、`evaluatedUnits = 0`、reason 1 件以上 |
| `partial` | 有効な評価単位があり、未評価または未完了が残る | `evaluatedUnits > 0`、reason 1 件以上 |
| `completed` | 宣言した scope の評価対象単位をすべて処理した | `evaluatedUnits = eligibleUnits`、`incompleteByReason` の合計 0 |

`completed` かつ findings 空は「その scope で候補なし」を意味し、repository 全体の安全性を意味しない。差分が正しく空の場合は `completed` と reason `no-applicable-changes` を記録する。

## Coverage

| フィールド | 意味 |
|---|---|
| `eligibleFiles` / `eligibleUnits` | 除外後に評価対象となったファイル・調査単位 |
| `selectedFiles` / `selectedUnits` | 上限内で送信計画に入ったもの |
| `evaluatedFiles` / `evaluatedUnits` | 応答検証を通過して評価済みになったもの |
| `excludedByReason` | eligible の外に置いた件数（理由別） |
| `incompleteByReason` | budget、timeout、応答欠落、無効所見などで未完了の件数（理由別） |
| `intakeTruncated` | snapshot 収集が上限で打ち切られたか |

各軸で `evaluated <= selected <= eligible` を満たす。coverage は host が実送信 manifest と応答検証から算出し、モデルの自己申告で更新しない。

## Finding

| フィールド | 規則 |
|---|---|
| `findingId` | `security-finding:<sha256>`。host が生成し、モデルの ID を採用しない |
| `status` | `candidate` のみ |
| `category` | `authorization`、`sql-injection`、`command-injection`、`ssrf`、`path-traversal`、`xss`、`deserialization`、`cryptography`、`secret-handling` |
| `cweIds` | `CWE-<正の整数>`、重複なし、最大 8。分類対応は参考値 |
| `severity` / `confidence` | 別軸。severity は成立時の影響、confidence は証拠と前提の明確さ |
| `primaryLocation` | repository 相対 path、`current` / `base`、1-based の行範囲。いずれかの `evidenceRefs` の範囲内 |
| `evidenceRefs` | 1〜16 件。host 発行の `snippet:` ID と `source` / `sink` / `guard` / `context` の役割 |
| `relevance` | `diff` では必須（`direct-change` / `related-change`）、`scan` では指定不可 |

path は `/` 区切りの相対 path に限り、絶対 path、Windows drive、`\`、空・`.`・`..` segment を拒否する。すべての object は strict であり、未知フィールドを拒否する。

## 上限（contract v1）

| 項目 | 上限 |
|---|---|
| title | 200 文字 |
| その他の narrative | 各 4,000 文字 |
| preconditions / limitations | 各 16 要素 |
| evidenceRefs | 16 / finding |
| findings | 256 / assessment |
| scope roots | 1,000 |
| reason code | 64 種、各 64 文字の kebab-case |

これらを変更する場合は `analysisContractVersion` を更新する。

## Metadata

- `scope`: `mode`、`roots`、`unitId`、`baseSha`、`headSha`、`inputId`。取得できない値は明示的に `null`。
- `provider`: provider ID、agent version、要求 model、解決済み model。起動していなければ `null`。
- `versions`: selector、prompt、validator、outboundFilter、severity の各 semver。
- `usage`: 呼び出し数、送信・応答 bytes、経過時間。token は provider が返した場合のみ数値、それ以外は `null`（0 と表示しない）。
- `fingerprints`: effective policy、入力、実送信 packet の SHA-256。
- 絶対 path、実行ファイル、profile path、認証値、source 本文、prompt、生応答は公開しない。

## AnalysisResult envelope

security が要求された実行だけ、core report を次の形で包む。要求されない実行は従来の `DiagnosisReport` / `DiffReport` をそのまま返す。

```json
{
  "schemaVersion": 1,
  "kind": "r3-doctor-analysis",
  "mode": "scan",
  "core": { "…": "DiagnosisReport v2（diff では DiffReport v3）" },
  "addons": { "security": { "…": "SecurityAssessment v1" } }
}
```

`addons.security.scope.mode` は envelope の `mode` と一致する。利用側は `kind` で識別し、従来の診断には `core` からアクセスする。

## Dry-run 要約

`kind: "r3-doctor-security-dry-run"` の要約は、状態（`planned` / `disabled` / `blocked` / `unavailable` / `failed`）、scope、coverage、batch ごとの unit 数・ファイル数・prompt bytes、policy / input fingerprint だけを持つ。source 本文、秘密値、prompt を含めない。`planned` 以外は batch を持たない。

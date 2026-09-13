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

## 有効化と実行許可

repository の `r3-doctor.config.json` に書けるのは要求だけである。

```json
{ "schemaVersion": 1, "addons": { "security": { "enabled": true, "scope": "changed" } } }
```

`addons.security` は `enabled` と `scope`（`repository` / `changed`）だけを受け付け、provider、実行ファイル、prompt、上限、許可 root、未知の add-on を拒否する。宣言は core config から分離して読み、core の `inputId` と analysis context fingerprint を変えない（`src/intake/snapshot.ts` の `parseRepositorySettings()`）。

operator profile の `addons.security` が実行許可と budget を持つ。

| キー | 規則 |
|---|---|
| `enabled` | root が一致したときの既定の要求 |
| `repositories` | 絶対 path、最大 128 件、各 1,024 文字。canonical path の完全一致だけで照合し、親 directory・glob・prefix は一致としない。存在しない root は読み込み時に除外する |
| `scope` | `repository` / `changed` |
| `maxBatches` | 1〜16（既定 4） |
| `maxTotalPromptBytes` | 1〜2,000,000（既定 240,000） |
| `timeoutMs` | 1,000〜600,000（既定 180,000） |

範囲外の値は丸めずに拒否する。解決規則（`src/addons/security/policy.ts`）:

- 機能要求: CLI（`--security` / `--no-security` / `--security-required`）> root が一致した operator 設定 > repository 宣言 > `false`。
- 実行許可: CLI の明示有効化、または root が一致した operator entry の `enabled: true`。どちらもなければ repository の要求は `blocked: operator-consent-required`。
- budget は root が一致した operator entry からだけ適用し、それ以外は既定値を使う。
- 分析 scope: CLI > 一致した operator 設定 > repository 宣言 > `repository`。`diff` は常に `changed` で、`--security-scope repository` は引数エラー。
- `--security-required` と `--no-security` の併用は引数エラー。
- provider の有無はここでは判定しない。既存の LLM 設定だけでは security を有効にしない。

## Operator profile の信頼境界

`loadTrustedOperatorProfile()`（`src/operator/trusted-profile.ts`）は default・XDG・`--profile` のすべての入口で同じ検査を行う。

- 解析対象 repository の canonical path 内（親 symlink 経由を含む）にある profile を拒否する。OS 標準の親 symlink（macOS の `/var` → `/private/var` など）は canonicalize して許可する。
- leaf symlink、通常ファイル以外、1 MiB 超を拒否する。descriptor を `O_NOFOLLOW` で開き、lstat と同じ inode であること、読み取り前後で size・mtime が変わらないことを確認する。
- POSIX では、別 UID 所有と group / world writable を拒否する。
- 明示した profile が存在しなければ設定エラー、default profile が存在しなければ `null`。`ENOENT` 以外（権限エラーなど）は設定なしとして扱わない。
- Windows では uid / mode で ACL を証明できないため、path・通常ファイル・サイズだけを検査し、operator 所有の OS 設定を信頼前提とする。

setup が既定 provider を保存し直すとき、既存の `addons` を保持する。

## Provider 実行境界

security 用の text port（`src/llm/acp-text-provider.ts`）は、呼び出しごとに次を守る。

- provider の `cwd` は repository 外に作った空の一時 directory とし、終了後に削除する。source をコピーしない。
- `cwd` と `untrustedRepositoryRoots` を分けて検査する。PATH の repository 内 entry を除外し、実行ファイルは symlink を解決した実体が repository 外にある場合だけ使う。
- client capability は filesystem / terminal を無効、MCP server は空、permission request は拒否する。最初の tool call で中断する。provider の safe mode（codex `read-only`、claude `plan`、cursor `ask`）が得られなければ prompt を送らない。
- initialize の直後、session 作成と prompt 送信の前に provider / agent version の confinement を照合する。未確認の組み合わせは `confinement-unsupported` とする。
- 呼び出し元の deadline から cleanup 用の予約（既定 1 秒）を差し引いた範囲で initialize・session・prompt を打ち切り、終了しない process は TERM の後に KILL する。
- token 使用量は provider が返した場合だけ記録する。

confinement 対応表（`SECURITY_CONFINEMENT_SUPPORT`）は現在空であり、すべての provider で security prompt は送られない。2026-09-13 時点で GitHub Copilot CLI 1.0.83 の help には `--available-tools`、`--disable-builtin-mcps`、`--no-custom-instructions`、`--log-level` が存在することを確認したが、ACP 実行時に global MCP、自動 instruction、ログ保持が抑止されることは認証済み canary で未確認のため登録していない。semantic 解析が動くことは security 対応の根拠にしない。

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

## 調査単位と送信計画

`src/addons/security/context.ts` と `plan.ts` は、immutable snapshot と差分で渡された base 本文だけを読む。

- 対象は TypeScript / JavaScript（`.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs`）。1 MiB を超えるファイルは解析せず `source-too-large` の未完了にする。
- 調査単位は、関数、class member（method、field initializer、static block）、関数引数を持つ top-level 呼び出し（route handler など）、それ以外の連続した top-level 文。import / export 宣言と型宣言は単位にしない。160 行を超える単位は 20 行重複の窓に分ける。同一ファイルで同じ symbol anchor が複数現れる場合は出現順の suffix を付け、別の宣言を同じ所見位置として統合しない。
- 優先度は、HTTP handler、外部入力、SQL / command / code / HTTP / file / HTML の sink、弱い暗号、guard の静的な手掛かりの重みの合計。手掛かりのない単位も列挙し、Regression Evidence や `diagnosticSkipRoots` を除外条件にしない。
- 関連コードは、static import の binding と同一ファイル内の名前参照から dependency / caller / guard を直接 1 段だけ解決する（1 単位あたり最大 8）。dynamic import、computed call、外部 middleware、解決できない import は limitation に残す。参照先が snapshot に存在しても、生成物・秘密ファイル・サイズ超過などで解析できない場合は `unresolved-import` とする。全プログラムの taint analysis ではない。
- 送信 scope `changed` は変更ファイルの base / current だけを送る。`cluster-context` と `all` はどちらも直接の関連コードまでに限る。分析 scope または送信 scope が `changed` で差分がなければ `base-required` とする。
- batch は priority 降順 → path → revision → 行の順に first-fit で詰める。1 request の UTF-8 bytes（指示を含む）、全 request の合計 bytes（再送した snippet を含む）、送信する一意 path 数（`llm.maxFiles`）、batch あたり 8 unit、batch 数を満たす場合だけ採用する。入らない unit は `budget-exhausted`、単独でも入らない unit は `prompt-too-large` とし、1 件も送れなければ reason `budget-insufficient` を記録する。
- prompt は固定指示の後に、送信内容から導いた nonce の fence で untrusted data を囲む。source の各行は `行番号| ` で始まり、fence 行を偽装できない。

## 送信フィルタ

`src/addons/security/outbound-filter.ts` は次のフィルタを適用する。送信計画は current / base それぞれのソース全体を先にマスクし、その結果から snippet を切り出す。窓の途中で始まる PEM や複数行の秘密値も、元の秘密領域としてマスクする。

- 送信しない: `.env*`、秘密鍵ファイル（`id_rsa` など、`.pem` `.key` `.p12` `.pfx` `.jks` `.keystore`）、名前に credential(s) / secret(s) を含むファイル、生成物（`dist` `build` `coverage` `node_modules` `vendor` `generated` 配下、`.d.ts` `.min.js` `.bundle.js` `.map`）、NUL を含む本文、制御文字・バックスラッシュ・絶対 path・`..` を含む path。
- マスクする: PEM 秘密鍵ブロック、既知の token 形式（AWS、GitHub、Slack、OpenAI / Anthropic、Google、Stripe、JWT）、password / secret / token / API key などの名前に代入された文字列リテラル。型注釈付き代入と複数行の値は TypeScript AST で検出し、コメントやコード例の単一行代入に対する文字列検出も維持する。行数を保ち、prompt には `redacted-lines` として snippet 内の元行番号だけを示す。送信する本文の hash は切り出したマスク済み本文から生成し、元本文の hash と区別する。
- マスク後にコードが残らない snippet は `masked-unanalyzable` として送らない。パターン検出は未知の秘密情報を完全には除去しない。

## 応答検証と severity

`src/addons/security/response.ts` と `severity.ts` の規則。

- 応答は 256 KiB 以下の単一 JSON object に限る。前後の文章、Markdown fence、複数の値、未知フィールドは batch 失敗。finding は batch あたり最大 64 件。
- batchId の不一致、送っていない unit や重複した unit は batch 失敗。応答にない unit は `unit-missing`、`insufficient-context` の unit は未完了とする。
- モデルが返す `findingId` / `status` / `severity` は受け付けない。evidence は同じ batch で送った snippet の path・revision・行範囲の内側、`primaryLocation` はいずれかの evidence の内側に限る。不正な finding は捨て、その unit を `invalid-finding` で未完了にする。unit を特定できない不正 finding は batch 全体を未完了にする。
- severity rubric v1: `arbitrary-execution` / `cross-tenant-access` は前提 `none` で critical、それ以外は high。`sensitive-data-access` は high、`limited-data-access` は medium、`defense-in-depth` は low。前提 `unknown` は最大 medium、evidence が `context` だけなら info。`severityRationale` にはモデル由来の分類であることを明記する。
- confidence は、前提 `unknown`、`insufficient-context`、未解決の関連（dynamic import など）、同じ箇所への食い違う報告のいずれかがあれば low に制限する。
- `findingId` は category と unit の path・revision・anchor の SHA-256。同じ ID の報告は統合し、severity は高い方、evidence は和集合（最大 16 件）とし、統合したことを limitations に残す。

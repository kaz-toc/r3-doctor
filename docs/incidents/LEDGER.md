# Incident Ledger

テンプレートにはプロダクト incident は含まれません。コピー先プロダクトは、確認済みのユーザー影響障害ごとに 1 行追加します。

## 保護状態

- `protected`: 既知の bad behavior または同等 mutant に対して実行可能テストが失敗し、active 回帰ケースが証拠を結ぶ
- `partially protected`: 関連パスの一部はテストされているが、元の観測可能な障害が証明されていない
- `unprotected`: 既知の障害を検出する実行可能契約がない

## Ledger

| Incident | User impact | Status | Root cause | Fix | Regression contract | Protection | Follow-up |
|---|---|---|---|---|---|---|---|
| SEC-2026-001 | Target config could enable/select an LLM process | fixed | Execution policy was mixed with repository config | CLI-owned strict LLM policy | REG-2026-001 | protected | — |
| SEC-2026-002 | Filenames could inject Actions commands or Markdown | fixed | Untrusted report values crossed output channels unescaped | Escape dedicated outputs and isolate ordinary logs | REG-2026-002 | protected | — |
| SEC-2026-003 | Adversarial exclude globs could exhaust CPU | fixed | Generated regex and aggregate work had no bound | DP matcher with scan-wide operation budget | REG-2026-003 | protected | — |
| SEC-2026-004 | Git refs could be parsed as options or non-OIDs | fixed | Missing option terminator and result validation | Reject leading dash, terminate options, validate full OID | REG-2026-004 | protected | — |
| SEC-2026-005 | Persisted reports revealed absolute repository paths | fixed | Path masking depended on optional policy | Fixed `[REPOSITORY]` external token | REG-2026-005 | protected | — |
| SEC-2026-006 | Oversized repository config was parsed without a byte cap | fixed | Unbounded read occurred before schema validation | Fixed-size bounded reader | REG-2026-006 | protected | — |
| SEC-2026-007 | Prompt limit excluded fixed/evidence content and leaked absolute path | fixed | Budgeting covered only a partial context packet | Budget final prompt and use repository token | REG-2026-007 | protected | — |
| SEC-2026-008 | Repository policy path could escape through traversal or symlink | fixed | Direct path join/read had no physical containment check | Contained regular-file resolver and policy bounds | REG-2026-008 | protected | — |
| SEC-2026-009 | Repository-influenced PATH could select Git/provider executables | fixed | Child lookup inherited unsafe PATH and Git inherited secrets | Sanitize lookup path, reject repo executables, allowlist Git env | REG-2026-009 | protected | — |

証拠なしに root cause を推測しない。調査で確定するまで `unknown` を使う。

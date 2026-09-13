# Shadow Score Validation

Shadow Score Validation は assessment contract v4 を変更せず、将来の実測 outcome に対して4つの v5 候補を比較する opt-in workflow です。Shadow score は障害発生確率ではなく、候補式の比較対象です。候補が review eligible になっても自動で有効化されず、CI gate と通常レポートは v4 のままです。

## Recording and outcomes

```bash
r3-doctor scan . --record-validation
r3-doctor validation status .
r3-doctor validation outcome . --sample <id> --outcome no-regression
r3-doctor validation outcome . --sample <id> --outcome regression --occurred-at 2026-09-02T00:00:00Z --replace
npm run validate
r3-doctor calibration compare . --repository-validation-passed
```

`--validation-horizon-days` は 1–365 の正の整数で、`--record-validation` と共にのみ使えます（既定30日）。記録には clean な Git worktree が必要です。生成した既知の未追跡 validation artifact は clean 判定から除外します（追跡済み変更、任意ファイル、ソースは除外しません）。ローカル記録を commit に含めないため、`.gitignore` への `.r3-doctor/validation/` 追加を推奨します。

Positive outcome (`regression`, `revert`, `hotfix`) には、recordedAt から dueAt までの `--occurred-at` が必須です（`2026-09-02T00:00:00Z` 形式を受理し、内部は UTC canonical へ正規化）。`no-regression` は dueAt 以降にのみ記録できます。未来の `observedAt` / `occurredAt` は拒否します。既存 outcome を訂正する場合は `--replace` を付けます。

## Candidates

- `v5-soft-saturation`: numeric evidence を onset で25、2倍で50、4倍で75、8倍で100へ soft saturation する。
- `v5-activity-modifier`: change-volatility を core の15% exposure modifier として適用する。
- `v5-confidence-uplift`: cluster uplift を cluster confidence で重み付けする。
- `v5-combined`: soft saturation、activity modifier、confidence-weighted non-volatility cluster uplift を組み合わせる。

中間値は丸めず、最終スコアだけを0–100に clamp して四捨五入します。registry と formula version は snapshot に保存され、保存済み sample を再計算しません。`sampleId` は repository ID、report input ID、HEAD SHA、analysis context fingerprint、diagnosis context fingerprint、policy thresholds、horizon days、shadow registry version、および記録時刻以外の保存 payload 全体から導出します。同じ commit でもスコアや集約特徴が変化すれば別 sample です。同一 payload の再実行は既存記録時刻を維持します。この導出方式より前の schema v1 artifact は読み取り可能で、暗黙の移行・書き換えは行いません。新方式での再記録は新しい sample ID を生成する場合があります。

## Storage and privacy

Artifact は `.r3-doctor/validation/` に、random UUID repository ID、snapshot、outcome として保存されます。snapshot は score、axis aggregate、signal/strength aggregate、coverage のみを含みます。repository/file path、source content、evidence message、cluster prose、任意 notes は保存しません。書込み前後に Git snapshot integrity と safe storage boundary を検証し、atomic rename を使います。Git 非利用時はディレクトリを作成せずに拒否します。

Artifact は schema version 1 の strict JSON です。未知キー、symlink、巨大/不正 JSON、sample ID と filename の不一致は error になります。`.json` 以外のファイルは読み込み時に無視します。retention は自動削除しません。status は policy の retentionDays を越えた sample を advisory として表示し、orphan outcome は warning として継続します。

## Comparison and promotion

`calibration compare` は保存済み score と complete outcome の inner join だけを使います。`dueAt <= now` の sample のみ母集団に含めます。AUC（ties は average rank）、advisory threshold での false-positive/miss rate、4 score band、v4 との差分、repository concentration を、candidate/formula/horizon/保存済み threshold ごとに分離します。30日・70/85 の cohort だけが primary で、他は `exploratory` として昇格判定対象外です。

Candidate は primary cohort で各 band 30 sample、5 repository、最大40% concentration、positive/negative 各10、v4以上かつ+0.03以上の AUC、miss-rate 悪化0.02以下、非減少 band rate、決定論的 serialization、v4/candidate golden ordering、明示的な validation attestation を満たす場合のみ `eligible-for-review` です。数量不足は `insufficient-data`、数量後の品質不合格は `rejected` です。

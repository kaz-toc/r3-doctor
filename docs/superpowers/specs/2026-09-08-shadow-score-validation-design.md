# Shadow Score Validation Design

## Purpose

Regression Risk Score v4 の公開契約、baseline、trend、CI gate を維持したまま、実際の regression outcome に対するスコアの妥当性を検証する。v4 の式を直感だけで変更せず、複数の shadow v5 候補を同一入力で計算し、事前に固定した基準で比較する。

## Goals

- `DiagnosisReport` と assessment contract v4 のスコアを変更しない。
- v4 と4つの shadow 候補を同じ snapshot から決定論的に計算する。
- 将来情報を混入させない prospective validation sample を明示的に収集する。
- ROC-AUC、false-positive rate、miss rate、score-band 単調性を比較する。
- source、file path、Evidence 本文、repository 絶対パスを validation artifact に保存しない。
- 昇格条件を満たすまで shadow 候補を通常 report と CI gate に使用しない。

## Non-goals

- この変更で assessment contract v5 を公開しない。
- v4 の Evidence strength、axis score、cluster score、repository score、confidence を変更しない。
- shadow score を障害発生確率として表示しない。
- validation data を外部 API へ送信しない。
- GitHub や issue tracker から outcome を自動取得しない。
- 条件達成時に candidate を自動昇格しない。
- missing-test-pair や coverage 検出を変更しない。

## Approaches Considered

### 1. Shadow v5 with prospective outcomes（採用）

v4 を正式スコアとして維持し、明示的に収集した outcome で shadow 候補を比較する。互換性と検証可能性が高く、候補間の ablation も可能である。昇格判断まで観測期間と十分な sample が必要になる。

### 2. Repository-specific threshold tuning

repository ごとに fan-in、churn、score band を調整する。導入は速いが、repository 間比較が難しくなり、利用者へ調整責任を移すため採用しない。

### 3. Immediate v4 formula replacement

既存式を直接変更する。すぐ結果は変わるが、予測根拠のない別の係数へ置き換えることになり、baseline と policy の互換性も失うため採用しない。

## Architecture

shadow validation を次の4境界へ分離する。

1. Candidate scoring: 既存 assessment input から shadow score と集計済み feature を計算する。
2. Validation storage: score snapshot と outcome を strict schema、atomic write、owned directory で保存する。
3. Outcome evaluation: 観測期間が揃った sample だけで候補を比較する。
4. CLI reporting: sample 記録、outcome 登録、状態確認、比較結果表示を担当する。

candidate scoring は `assessRisk()` の戻り値を変更しない。v4 report の生成後、同じ assessment input から独立した `ShadowScore[]` を生成する。

```ts
export type ShadowCandidateId =
  | 'v5-soft-saturation'
  | 'v5-activity-modifier'
  | 'v5-confidence-uplift'
  | 'v5-combined';

export type ShadowScore = {
  candidateId: ShadowCandidateId;
  formulaVersion: 1;
  score: number;
  axisScores: Record<RiskAxisId, number | null>;
  scoreBreakdown: {
    core: number;
    activityUplift: number;
    clusterUplift: number;
  };
};

export function computeShadowScores(input: AssessmentInput): ShadowScore[];
```

`null` axis は unevaluated を表し、0点と区別する。candidate ID と formula version は保存後の再計算を禁止するため必須とする。

## Shadow Candidate Formulas

### Shared rules

- product Evidence、deduplication key、axis の peak/breadth/diversity 比率、binary strength は v4 を維持する。
- locale、format、validation storage の有無は candidate score に影響しない。
- 中間値は丸めず、最終 score だけを0–100へ clampして四捨五入する。

### v5-soft-saturation

numeric signal の strength だけを変更する。

```text
value < onset: 0
value >= onset: min(100, 25 + 25 * log2(value / onset))
```

onsetで25、2倍で50、4倍で75、8倍で100になる。axis、cluster、repository の集約は v4 の式を使う。

### v5-activity-modifier

Evidence、axis、cluster は v4 を使い、repository 集約だけを変更する。

```text
core = mean(evaluated axes excluding change-volatility)
volatility = evaluated change-volatility score, otherwise 0
activityUplift = 0.15 * (100 - core) * (volatility / 100)
adjustedBase = core + activityUplift
maxRawCoreClusterScore = max(cluster.score where axisId != change-volatility), or 0
clusterUplift = 0.30 * max(0, maxRawCoreClusterScore - adjustedBase)
score = round(clamp(adjustedBase + clusterUplift, 0, 100))
```

core axis がなければ `core = 0` とする。churn を構造リスクと同じ重みの独立 axis ではなく、リスクへの露出量として扱う。

### v5-confidence-uplift

axis base は v4 を使い、critical cluster uplift だけに cluster confidence を適用する。

```text
effectiveClusterScore = cluster.score * cluster.confidence
clusterUplift = 0.30 * max(0, maxEffectiveClusterScore - axisBase)
score = round(clamp(axisBase + clusterUplift, 0, 100))
```

### v5-combined

soft-saturation で axis/cluster を再計算し、activity-modifier で adjusted base を作り、confidence-adjusted cluster uplift を加える。

```text
core = mean(soft-saturation evaluated axes excluding change-volatility)
activityUplift = 0.15 * (100 - core) * (softVolatility / 100)
adjustedBase = core + activityUplift
effectiveClusterScore = softCluster.score * softCluster.confidence where axisId != change-volatility
clusterUplift = 0.30 * max(0, maxEffectiveClusterScore - adjustedBase)
score = round(clamp(adjustedBase + clusterUplift, 0, 100))
```

4候補を同時記録し、飽和緩和、churn、confidence uplift の効果を分離して比較する。

## Validation Data Model

### Storage layout

```text
.r3-doctor/validation/
  repository-id
  snapshots/<sampleId>.json
  outcomes/<sampleId>.json
```

`repository-id` は初回の明示的な validation 記録時に生成する random UUID とする。repository path や remote URL から導出せず、複数 repository の偏り検出だけに使う。

```ts
export type ValidationSnapshotV1 = {
  schemaVersion: 1;
  sampleId: string;
  repositoryId: string;
  recordedAt: string;
  dueAt: string;
  horizonDays: number;
  reportInputId: string;
  headSha: string;
  assessmentContractVersion: 4;
  analysisContextFingerprint: string;
  policyThresholds: { advisory: number; gate: number };
  v4: {
    score: number;
    confidence: number;
    axisScores: Record<RiskAxisId, number | null>;
  };
  shadow: ShadowScore[];
  features: {
    productPathCount: number;
    signalCounts: Partial<Record<SignalId, number>>;
    strengthHistogram: { low: number; medium: number; high: number };
    capabilityCoverage: number;
    inputCompleteness: number;
  };
};

export type ValidationOutcomeV1 = {
  schemaVersion: 1;
  sampleId: string;
  observedAt: string;
  outcome: 'regression' | 'revert' | 'hotfix' | 'no-regression';
  occurredAt?: string;
  incidentId?: string;
};
```

`sampleId` は repository ID、input ID、HEAD SHA、analysis context fingerprint、horizon days、shadow registry version の canonical JSON を SHA-256 化する。locale、prose、現在時刻は入力に含めない。

同じsample IDを再記録する場合、最初に保存した`recordedAt`と`dueAt`を維持する。時刻以外のcanonical payloadが同じならno-opとし、時刻以外が異なる場合だけduplicate conflictとする。これにより同じcommitの再実行を別sampleとして水増ししない。

positive outcome は `regression`、`revert`、`hotfix`、negative outcome は `no-regression` とする。positive outcome は `occurredAt` 必須で、`recordedAt <= occurredAt <= dueAt` を満たす。`no-regression` は `observedAt >= dueAt` の場合だけ登録できる。

promotion cohort は `horizonDays = 30` に固定する。それ以外も保存・集計するが exploratory と表示し、昇格判定から除外する。

## CLI and Data Flow

### Recording a snapshot

```bash
r3-doctor scan . --record-validation --validation-horizon-days 30
```

1. 通常の snapshot、Evidence、v4 report を生成する。
2. 同じ assessment input から4つの shadow score を生成する。
3. Gitが利用でき、診断後もHEADとanalyzed snapshotが一致することを確認する。dirty snapshot、HEAD変更、Git非利用時は記録しない。
4. repository ID がなければ生成し、validation snapshot をtemporary fileへ書いてatomic renameする。
5. 同じsample IDと同じcanonical payloadならno-op、内容が異なれば上書きせず`ConfigError`を返す。
6. retention auditをstderrへ出力する。診断reportのstdoutは変えない。

`--record-validation`を指定しない`scan`は引き続きread-onlyである。

### Status

```bash
r3-doctor validation status . [--format console|json]
```

sampleを`pending`、`due`、`complete`へ分類する。malformed fileやschema不一致を黙って除外せず、validation directoryからの相対パスを示してexit code 2にする。

### Recording an outcome

```bash
r3-doctor validation outcome . --sample <sampleId> --outcome <regression|revert|hotfix|no-regression> [--occurred-at <ISO-8601>] [--incident <opaque-id>]
```

- 存在しないsample、positive outcomeの`occurredAt`不足、不正な期間、期限前の`no-regression`はexit code 2。
- 同一payloadの再送はno-op、既存outcomeの異なる内容への置換は上書きせずexit code 2。
- `incidentId`は最大256文字のopaque IDとし、notesや自由記述は保存しない。

### Comparing candidates

```bash
r3-doctor calibration compare . [--format console|json]
```

snapshotとoutcomeのinner joinでcomplete sampleを作る。candidate ID、formula version、horizon daysが同じcohortだけを比較する。snapshotに保存したscoreを使い、現行コードで過去sampleを再計算しない。

## Evaluation Metrics

candidateごとに次を計算する。

- sample count、positive/negative count、repository count、repository最大構成比
- score bandごとのsample count、positive count、observed positive rate
- ROC-AUC。tieはaverage rankとし、positiveまたはnegativeが0件ならunavailableとする
- 保存済みadvisory thresholdでのfalse-positive rateとmiss rate
- `0–30`、`31–60`、`61–80`、`81–100`のobserved positive rateの単調性
- v4とのscore deltaのmean、median、5/95 percentile

thresholdが異なるsampleはROC-AUCには利用できるが、false-positive/miss rateはthresholdごとに分離表示する。promotion cohortは30日、advisory threshold 70、gate threshold 85に固定し、それ以外はexploratoryとする。

## Promotion Decision

`calibration compare`は候補ごとに`insufficient-data`、`rejected`、`eligible-for-review`を返す。次の全条件を満たした場合だけ`eligible-for-review`とする。

1. 30-day、advisory threshold 70、gate threshold 85のcohortで、candidate scoreの4 bandそれぞれに30 samples以上ある。
2. 5 repository以上から収集し、1 repositoryが全sampleの40%を超えない。
3. positiveとnegativeがともに10件以上ある。
4. candidate ROC-AUCがv4以上で、deltaが`>= 0.03`である。
5. candidate miss rateがv4から`0.02`を超えて悪化しない。
6. 4 score bandのobserved positive rateが非減少である。
7. 同じcorpusを2回評価したJSONがgenerated timestampを除いてbyte-identicalである。
8. v4とcandidateがともにgolden ordering `fragile > improved >= stable`を満たす。
9. repository-wide `npm run validate`が成功する。

sample数、repository数、class数の不足は`insufficient-data`とする。数量条件を満たして品質条件を満たさない場合は`rejected`とする。`eligible-for-review`は別PRでassessment contract v5を設計する入口であり、自動採用を意味しない。

## Error Handling and Safety

- validation storageはrepository配下の専用directoryに限定し、repository root、shared control directory、symbolic linkを拒否する。
- 入力JSONにbyte limitとstrict Zod schemaを適用する。
- temporary fileとatomic renameで部分書き込みを公開しない。
- 自動削除を行わず、policyの`retentionDays`を超えたartifactを手動削除候補としてstatusで表示する。
- consoleの識別子とerror messageは制御文字をescapeする。
- candidate計算失敗はv4 reportを改変しない。`--record-validation`指定時は記録失敗をexit code 2とする。

## Compatibility

- `DiagnosisReport`、`DiffReport`、`Intervention`、calibration dataset v1、feedback v2を変更しない。
- `scan`の既存option、stdout、exit code、read-only defaultを維持する。
- shadow registry versionとvalidation schema versionはassessment contract versionと独立させる。
- 異なるformula versionのsampleを合算しない。
- localeはCLI proseだけへ影響し、sample ID、score、metrics、promotion statusへ影響しない。

## Testing

### Candidate scoring

- shadow計算の有無でv4 reportがdeep-equalであること。
- soft-saturationがonset/2倍/4倍/8倍で`25/50/75/100`となり、中間値が単調であること。
- activity-only repositoryのscoreが15以下で、coreがある場合はvolatility増加に対して非減少であること。
- confidence 0.33のclusterがraw score 100のままcritical upliftを発生させないこと。
- localeとformatでshadow scoreが変化しないこと。

### Storage and CLI

- strict schema、unknown key、壊れたJSON、byte limit、symlink、unsafe directory、partial write、duplicate conflict。
- dirty snapshot、Git不在、診断後HEAD変更時に保存しないこと。
- 同一payloadのsnapshot/outcome再記録がidempotentであること。
- 期限前の`no-regression`と不正な`occurredAt`を拒否すること。
- plain `scan`がvalidation directoryを生成しないこと。
- package後のCLIで新commandとcandidate registryが動作すること。

### Evaluation

- tieを含む既知corpusでROC-AUCが手計算値と一致すること。
- positive/negativeの一方が0件ならAUC unavailableとなること。
- threshold別、band単調性、repository偏り、horizon分離が正しいこと。
- 3種類のpromotion statusをfixtureで検証すること。
- generated timestampを除くJSONが2回の実行でbyte-identicalであること。

## Acceptance Criteria

- validationなしのv4 JSON、human-readable report、baseline、trend、policyが変更前と同一である。
- explicit flagのないcommandはvalidation storageを作成・更新しない。
- 4 shadow候補とv4を同じvalidation snapshotへ記録できる。
- validation artifactにrepository path、source path、Evidence message、source contentが含まれない。
- 期限とoutcomeの整合性がschema/command境界で強制される。
- `calibration compare`がmetricsと全昇格条件のpass/fail/reasonを出力する。
- `eligible-for-review`になってもv4 contractやCI gateは自動変更されない。
- `npm run validate`が成功する。

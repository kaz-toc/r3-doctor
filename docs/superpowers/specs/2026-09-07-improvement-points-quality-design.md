# Improvement Points Quality Design

## Purpose

`r3-doctor` の Improvement points を、根拠付きの定型文から、利用者がそのまま改善作業を開始できる決定論的な推薦へ改善する。

現状は各 intervention に rationale、first step、verification、priority を持つが、別 Evidence から選んだ path と metric が一文へ混在する場合がある。また、`diff` は比較可能な baseline がないと変更に関連する改善案を表示できず、優先順位の理由も human-readable report から確認できない。

## Goals

- intervention の primary path、metric、Evidence ID を必ず同一 Evidence に結び付ける。
- repository confidence と cluster confidence の弱い方を使って優先度を計算する。
- `diff` では new/worsened、直接変更、blast radius の順でPR関連度を判定し、関連する改善案だけを表示する。
- baseline がない場合も、changed files と blast radius から変更関連の改善案を表示する。
- improvement の即時検証を、実行可能な `r3-doctor` コマンドと Evidence ID で示す。
- summary の情報量は維持し、facts、actions、all の表示上限だけを増やす。
- LLMなしで同一入力から同一出力を生成する。

## Non-goals

- `Intervention`、`DiagnosisReport`、`DiffReport` の公開schemaを変更しない。
- assessment contract versionを更新しない。
- LLMによる推薦文生成を追加しない。
- missing-test-pair analyzerの検出方式やテスト対応関係を変更しない。
- score、Evidence strength、cluster scoreの計算式を変更しない。
- summary viewを長くしない。

## Approaches Considered

### 1. Internal deterministic refinement（採用）

既存schemaを維持し、推薦生成時に単一の basis Evidence を選択する。PR関連度と順位説明は view model で導出し、human-readable formatterだけへ追加する。

利点は後方互換性、実装範囲の小ささ、再現性である。欠点は順位内訳とPR関連度がJSON contractへ永続化されないことだが、今回の目的には不要である。

### 2. Structured intervention contract

`Intervention` に `basisEvidenceId`、`priorityBreakdown`、`changeRelevance`、`verificationCommand` を追加する。

データ契約としては最も強いが、strict schema、baseline compatibility、assessment contract version、fixtureを一括更新する必要がある。現時点では変更コストが目的に対して大きい。

### 3. LLM-enriched recommendations

決定論的な intervention をLLMへ渡し、repository固有の手順やコマンドへ書き換える。

具体性は上がる可能性があるが、provider未設定時に機能が低下し、再現性、コスト、外部送信境界が複雑になるため採用しない。

## Design

### Recommendation basis

`src/recommendation/rules.ts` に非公開の `RecommendationBasis` と選択関数を追加する。

```ts
type RecommendationBasis = {
  evidence: Evidence;
  primaryPath: string;
  strongestMetric: string;
};

function selectRecommendationBasis(
  linkedEvidence: Evidence[],
  targetPaths: string[],
): RecommendationBasis | undefined;
```

選択対象は `targetPaths` に含まれる product Evidenceだけとする。`strength` 降順、`evidenceId` 昇順で1件を選び、`primaryPath`、`strongestMetric`、basis Evidence IDをすべてその1件から導出する。これにより `src/cli.ts` と別ファイルの `fan-in=33` が混在するような説明を禁止する。

対象となる product Evidence がなければ、現行どおり intervention を生成しない。

### Priority confidence

interventionのpriority計算には次の effective confidenceを使う。

```ts
effectiveConfidence = Math.min(repositoryEvidenceConfidence, cluster.confidence)
```

priority scoreの式は維持する。

```ts
priorityScore = clusterScore * effectiveConfidence * scopeFactor / costWeight
```

これにより、repository全体の解析品質が高くても、独立signalが少ない低confidence clusterを過大評価しない。scanの並び順は引き続き `priorityScore` 降順、cluster ID昇順とする。

### Actionable verification

各mechanismの verification は、domain testを捏造せず、次の2段階を明示する。

1. repository自身のbuild/testを実行する。
2. `r3-doctor scan . --format json` を実行し、basis Evidence IDが消失またはstrength低下したことを確認する。

message templateへ `basisEvidenceId` を渡し、最低でも検証対象を一意にする。プロジェクト固有のtest scriptは設定から取得できないため、存在しないコマンドを生成しない。

verification horizonは同じscoreの低下だけを成功条件にせず、対象signalの継続的な不在を確認する。volatilityだけは観測窓が必要なため、`churnDays` 日後の再評価を維持する。

### Diff relevance

`src/reporting/view-model.ts` にformatter内部専用の関連度を追加する。公開report schemaへは追加しない。

```ts
type ActionChangeRelevance = 'new-or-worsened' | 'direct-change' | 'blast-radius';

type ActionItemView = {
  // existing fields
  changeRelevance?: ActionChangeRelevance;
  effectiveConfidence: number;
};
```

`diff` actionの関連度は次の順で決める。

1. linked Evidence が newSignals または worsenedSignals に含まれる: `new-or-worsened`
2. target path が changedFiles に含まれる: `direct-change`
3. target path が changed file の direct/transitive dependencyまたはdependentに含まれる: `blast-radius`
4. どれにも該当しない: diff actionから除外

比較可能なbaselineがなくても2と3は評価する。並び順は関連度の上記順、`priorityScore` 降順、intervention ID昇順とする。scan actionは従来どおりrepository全体のpriority順とし、change relevanceを表示しない。

### Human-readable ranking explanation

Markdownとconsoleの各actionに次を追加する。

```text
Priority score: 48.12; Confidence: 0.67; Cost: low
PR relevance: direct-change
```

`PR relevance` はdiffだけに表示する。JSONは既存のfull report contractを維持する。

### View limits

summaryの上限は変更しない。

| View data | Current | New |
|---|---:|---:|
| summary clusters | 5 | 5 |
| summary Evidence per cluster | 3 | 3 |
| facts Evidence per group | 5 | 8 |
| actions | 5 | 8 |
| action target paths | 3 | 5 |
| action linked Evidence | 3 | 5 |

共有されている `evidencePerCluster` と `pathsPerItem` を、summary用とaction用に分離する。`all` はコンパクトなsummary blockと、拡張したactions/facts blockを合成する。JSONは従来どおり上限を適用しない。

## Error Handling and Compatibility

- Evidenceにmetricsがなければ、basis Evidence自身のmessageをmetric説明として使う。
- pathを持たないrepository-wide Evidenceはbasisに選ばず、product targetを持たないclusterのinterventionは従来どおり生成しない。
- incompatible baselineはエラーにせず、changed filesとblast radiusだけでPR relevanceを評価する。
- 既存のschemaとassessment contract versionを維持するため、保存済みbaselineとの互換性は変わらない。
- localeは表示文だけへ影響し、basis選択、priority、PR relevanceへ影響しない。

## Testing

### Recommendation tests

- 異なるEvidenceのpathとmetricが混在しないこと。
- strength同値時はEvidence IDで決定論的にbasisを選ぶこと。
- repository confidenceよりcluster confidenceが低い場合、低い値でpriorityを計算すること。
- verificationにbasis Evidence IDと再scanコマンドが含まれること。
- locale変更でbasis、priority、順序が変化しないこと。

### Diff tests

- new/worsened actionが直接変更・blast radiusより先に並ぶこと。
- baselineなしでもdirect-changeとblast-radius actionを表示すること。
- PRと無関係なrepository-wide actionを表示しないこと。
- change relevanceがMarkdownとconsoleへ表示されること。

### Reporting tests

- summaryの件数上限が5 cluster、各3 Evidenceのままであること。
- factsが各group最大8 Evidenceを表示すること。
- actions/allが最大8 action、各5 paths、各5 linked Evidenceを表示すること。
- JSON出力が全interventionと既存schemaを保持すること。

### Verification commands

```bash
npm test -- tests/recommendation.test.ts tests/diff.test.ts tests/reporting.test.ts tests/integration.test.ts
npm run validate
node dist/cli.js scan . --locale en --format markdown --view actions
node dist/cli.js diff . --base origin/main --locale en --format markdown --view actions
```

## Acceptance Criteria

- action内のpath、metric、Evidence IDが同一Evidenceを参照する。
- 低confidence clusterが高confidence clusterと同等に扱われない。
- baselineなしのdiffでも変更に関連するactionを最低1件表示できる。ただし該当clusterが存在しない場合は空を許容する。
- diff actionはPRと無関係なclusterを含まない。
- action出力からpriorityの理由と即時検証対象を判断できる。
- summaryの現在の情報量と順序を維持する。
- facts/actions/allの拡張後もhuman-readable outputが既定上限内で決定論的である。
- locale変更でscore、basis Evidence、priority、PR relevanceが変化しない。
- `npm run validate` が成功する。

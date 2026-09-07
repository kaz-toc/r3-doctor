# r3-doctor レポート実用性・スコア信頼性改善 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 冗長で行動につながらず、50/75 に量子化された現在の診断を、根拠・限界・次の一手を短時間で判断できる診断へ置き換える。

**Architecture:** Evidence Extraction が測定値から連続的な `strength` と path 関係を生成し、Risk Assessment が監査可能な内訳から Axis/Repository score と Evidence confidence を算出する。Recommendation はクラスターごとに優先順位付きの具体策を作り、Reporting は同じ versioned report から独立選択可能な `facts`、`summary`、`actions` と、3章を統合した `all` を生成する。実績データが不足している間は score を `uncalibrated` と表示し、見た目の分散を「精度」と称さない。

**Tech Stack:** Node.js 22、TypeScript、Zod、Vitest、Commander

**Spec:** `docs/spec/assessment-contract.md`、`docs/spec/deterministic-signals.md`、`docs/spec/feedback-collection.md`、`ROADMAP.md`

## Global Constraints

- Regression Risk Score は障害発生確率ではなく、同一 assessment contract 内の優先順位と時系列比較にだけ使う。
- LLM の confidence を risk magnitude に変換しない。意味所見は検証済み scope と根拠参照を通してのみ score に参加させる。
- Reporting は score、priority、cluster membership を再計算しない。表示用の選択と整形だけを行う。
- human-readable 出力は `--view facts|summary|actions|all` で選択でき、既定値は後方互換の `all` とする。
- `all` は `Diagnosis summary` → `Improvement points` → `Current state` の3章で構成し、各単独 view と同じ事実を重複なく合成する。
- JSON は `--view` によって欠落させず、監査可能な versioned report 全体を常に返す。
- test、fixture、generated、tooling path は既定の product risk score に加算しない。test path は verification coverage の根拠として使う。
- score 分布を均等にすることを目標にしない。単調性、識別力、順位品質、誤検知率、説明有用性を検証する。
- assessment contract、report schema、baseline、diff、trend の version を同時に更新し、旧 contract の値を比較しない。
- 実装は test-first で進め、確認済みの user-visible failure を `REG-2026-021` で保護する。
- 完了前に `npm run validate` を実行する。

---

## 1. 現状診断

添付された自己診断と同じ checkout を current build で再診断した結果は次のとおりだった。

| 観測 | 現状 | 利用者への影響 |
|---|---:|---|
| Evidence | 74 件 | 根拠を一覧しているが優先順位を読み取れない |
| Risk Cluster | 72 件 | ほぼ 1 path = 1 cluster で、同じ説明が反復する |
| Cluster score | 25点: 1、50点: 59、75点: 12 | severity を点数へ直結しているため細かな差を表現できない |
| Axis score | 50、75、50、75、未評価 | 軸内の件数・広がり・強さの違いが最大 severity に潰される |
| Axis confidence | 評価済み 4 軸すべて 1.0 | 証拠網羅性と実績校正を区別できず、過度に確定的に見える |
| Intervention | 3 件 | 1 件が 8〜33 path を束ね、開始点と完了条件が曖昧 |
| Markdown | 1,018 行 | mechanism、trigger、evidence を cluster と全 Evidence で重複表示する |

### 確定した原因

1. `src/assessment/risk.ts` の `aggregateSignalStrength()` は `low / medium / high` を `25 / 50 / 75` に変換し、軸内の最大値だけを採用している。
2. semantic score は finding confidence の最大値を 0.5 倍しており、risk magnitude と confidence を混同している。
3. dependency cycle 以外の cluster は `paths.map(path => [path])` で必ず path-local に分割される。
4. `src/reporting/format.ts` は全 cluster を同一構造で出した後、同じ Evidence をもう一度全件表示する。
5. `src/recommendation/rules.ts` は signal ごとの固定 priority を使い、cluster score、confidence、path の関係、cost を表示順へ反映しない。
6. Markdown は Intervention の `description` を表示せず、巨大な `targetPaths` と抽象的な expected/verify だけを見せる。
7. `git-churn` の「次回診断で減ること」という verification は 90 日窓の履歴指標なので、対策直後に確認できない。
8. calibration の保存・gate 判定は存在するが、通常レポートは score が未校正であることを示さない。

## 2. 採用する設計

### 比較した案

| 案 | 内容 | 判断 |
|---|---|---|
| Formatter だけを短くする | 上位 5 件へ切り詰め、重複 section を隠す | 短くはなるが、50/75 偏重と抽象的な提案が残るため不採用 |
| LLM に要約・採点させる | 全 Evidence を LLM に渡して score と助言を生成する | 再現性、offline 動作、根拠追跡を損なうため不採用 |
| Contract-first の全面改善 | strength、score、cluster、intervention、report、calibration status を同じ version 境界で直す | 採用。原因を各 owner 境界で解消できる |

### 新しい用語

- **Signal Strength**: 1 件の観測値が、その signal の開始閾値をどれだけ超えているかを 0–100 へ正規化した強度。障害確率ではない。
- **Risk Score**: signal strength の強さ、影響 path の広がり、独立した mechanism の種類から算出する相対指標。
- **Evidence Confidence**: analyzer coverage、入力完全性、測定再現性に基づく根拠の信頼可能性。score の正しさや障害確率ではない。
- **Calibration Status**: outcome data による検証状態。`uncalibrated`、`provisional`、`validated` のいずれか。
- **Contribution Points**: Repository score のうち各 axis が実際に加えた点数。現在の「axis score の構成比」は廃止する。
- **Facts View**: 観測済み Evidence、metric、対象 path、解析範囲、未評価領域だけを示す現状表示。診断上の解釈や改善案を混ぜない。
- **Summary View**: score、上位 cluster、主要因、Evidence confidence、Calibration status、制約を示す現状の診断要約。新しい事実を生成しない。
- **Actions View**: 優先順位付き intervention、対象、理由、最初の一手、確認方法を示す改善ポイント表示。必ず cluster と Evidence を参照する。
- **All View**: Summary、Actions、Facts をこの順で3章として一つの human-readable report に合成した表示。

### v4 provisional score

数値 signal の strength は次で算出する。

```ts
export function normalizeAboveThreshold(value: number, onset: number): number {
  if (value < onset) return 0;
  return Math.round(Math.min(100, 25 + 50 * Math.log2(value / onset)));
}
```

この式は onset で 25、2 倍で 75、約 2.83 倍で 100 になり、閾値以上の実測差を保持する。binary signal は assessment contract に固定した provisional strength を使う（dependency cycle 90、unresolved import 65、missing test coverage 50、barrel re-export 30）。値は経験的な確率を意味せず、後続の calibration dataset で versioned contract としてだけ変更する。

Axis score は、重複を除いた Evidence から次を記録して算出する。

```ts
type AxisScoreBreakdown = {
  peak: number;       // strength 上位3件の 0.6 / 0.3 / 0.1 加重平均
  breadth: number;    // product path の影響率。50%で100に飽和
  diversity: number;  // 観測された mechanism / 評価可能 mechanism
};

score = round(0.65 * peak + 0.25 * breadth + 0.10 * diversity);
```

Repository score は評価済み axis の等重み平均を `axisBase` とし、最大 cluster がそれを上回る場合だけ差分の 30% を `criticalClusterUplift` として加える。

```ts
repositoryScore = round(axisBase + 0.30 * max(0, maxClusterScore - axisBase));
```

各 axis の `contributionPoints` の合計は `axisBase` と一致し、`axisBase + criticalClusterUplift` は丸め前の repository score と一致する。表示はこの式と上位寄与 signal を併記する。

### 4つの report view

各 view の責務と表示内容を次へ固定する。

| View | 目的 | 含める内容 | 含めない内容 |
|---|---|---|---|
| `facts` | 現状を監査する | metadata、capabilities、未評価領域、mechanism ごとに grouped Evidence、metric、strength、path | repository/axis score の解釈、priority、改善案 |
| `summary` | 現状を短時間で判断する | assessment summary、score 内訳、axis table、上位 5 clusters、主要な limitations | intervention 詳細、全 Evidence table |
| `actions` | 改善作業を開始する | 上位 5 interventions、rationale、first step、上位 3 target paths、即時 verification、verification horizon | 全 axis table、全 Evidence、無関係な cluster |
| `all` | 共有・保存用の一体レポートを作る | `Diagnosis summary`、`Improvement points`、`Current state` の3章 | 同じ Evidence や limitation の章間重複 |

`facts` は Evidence を mechanism ごとにまとめ、同じ mechanism/trigger の説明を一度だけ表示する。各 group は上位 5 Evidence と残件数を示し、全 Evidence ID が必要な場合は `--format json` を案内する。

`summary` は次の順で表示する。

1. `Assessment summary` — score、band、Evidence confidence、Calibration status、未評価軸数。
2. `Why this score` — axis score、contribution points、confidence、上位根拠を 1 行ずつ表示する。
3. `Top risk clusters` — 上位 5 件。trigger → mechanism → measurable impact → Evidence を 1 cluster 1 block で表示する。
4. `Limitations` — provider/language 単位に集約し、未対応 signal 名の全列挙をしない。

`actions` は priority 順に最大 5 件を表示する。対象は各 3 path までとし、残りを件数表示する。action は `clusterId` と上位 `evidenceId` を示し、改善理由を現状情報まで逆引きできるようにする。

`all` は3つの formatter を別々に呼んで文字列連結せず、一つの `ReportViewModel` から3章を描画する。これにより見出し、limitations、Evidence 抜粋の重複を防ぐ。既定値は `all` とする。

`diff` でも view の意味を変えない。`facts` は changed files、blast radius、new/worsened/improved signals、比較互換性を示し、`summary` は risk delta と主要な変化を要約し、`actions` は new/worsened cluster に結び付く intervention を優先する。`all` は scan と同じ3章順でこれらを合成する。

---

### Task 1: v4 domain contract と versioned schema を固定する

**Files:**
- Create: `docs/adr/0004-decision-report-and-provisional-score.md`
- Modify: `CONTEXT.md`
- Modify: `docs/spec/assessment-contract.md`
- Modify: `docs/spec/deterministic-signals.md`
- Modify: `docs/spec/feedback-collection.md`
- Modify: `src/schema/report.v1.ts`
- Test: `tests/schema.test.ts`
- Test: `tests/comparison.test.ts`
- Regression: `docs/incidents/LEDGER.md`
- Regression: `test-fixtures/regressions/REG-2026-021/case.json`

**Interfaces:**
- Consumes: 現行 `DiagnosisReport`、baseline/diff/trend の version compatibility 規則。
- Produces: `Evidence.strength`、`Evidence.rationale`、`Evidence.pathRole`、`Evidence.relatedPaths`、`AxisScoreBreakdown`、`ConfidenceBreakdown`、`CalibrationSummary`、actionable `Intervention` の schema。

- [ ] **Step 1: 旧レポートを拒否し、新しい意味を必須にする schema test を書く**

```ts
expect(diagnosisReportSchema.safeParse(v3Report).success).toBe(false);
expect(v4Report.repository.calibration.status).toBe('uncalibrated');
expect(v4Report.axes[0]).toMatchObject({
  contributionPoints: expect.any(Number),
  scoreBreakdown: { peak: expect.any(Number), breadth: expect.any(Number), diversity: expect.any(Number) },
});
expect(v4Report.evidence[0]).toMatchObject({
  strength: expect.any(Number),
  rationale: expect.any(String),
  pathRole: 'product',
  relatedPaths: expect.any(Array),
});
```

- [ ] **Step 2: schema test が現行 contract で失敗することを確認する**

Run: `npm test -- tests/schema.test.ts tests/comparison.test.ts`

Expected: `strength`、`contributionPoints`、`calibration` が存在せず FAIL。

- [ ] **Step 3: schema と version 定数を更新する**

```ts
export const ASSESSMENT_CONTRACT_VERSION = 4;
export const REPORT_SCHEMA_VERSION = 2;
export const BASELINE_SCHEMA_VERSION = 4;
export const DIFF_SCHEMA_VERSION = 3;

export const calibrationStatusSchema = z.enum(['uncalibrated', 'provisional', 'validated']);
export const pathRoleSchema = z.enum(['product', 'test', 'tooling', 'generated', 'fixture']);
```

`Evidence.severity` は `strength` から導出する表示 band と定義し、独立に書き換えられない refinement を追加する。`AxisAssessment.contribution` は削除し、`contributionPoints` と `scoreBreakdown` へ置換する。`RepositoryAssessment` には `scoreBreakdown`、`confidenceBreakdown`、`calibration` を必須化する。`Intervention` には `rationale`、`firstStep`、`priorityScore`、`verificationHorizon` を必須化する。

- [ ] **Step 4: 旧 baseline/diff/trend を非互換として扱う test と実装を追加する**

旧 assessment contract は parse error ではなく「比較不能」として reason を返し、risk delta と signal changes を出さない。保存済みデータを暗黙 migration しない。

- [ ] **Step 5: glossary、assessment contract、signal rubric、feedback fields を更新する**

ADR には formatter-only、LLM scoring、contract-first の比較、provisional formula、calibration 後だけ重みを変更する規則を記録する。`CONTEXT.md` には上記 7 用語だけを実装詳細なしで追加する。feedback に `actionTaken`、`verificationOutcome`、`scoreBefore`、`scoreAfter`、`assessmentContractVersion` を追加する。

- [ ] **Step 6: incident と回帰契約を登録する**

`REG-2026-021` の invariant は「`facts`、`summary`、`actions` を個別選択でき、`all` がその3種類を重複なしの3章として出力し、score の calibration status を表示する」とする。

- [ ] **Step 7: schema と compatibility test を通す**

Run: `npm test -- tests/schema.test.ts tests/comparison.test.ts`

Expected: PASS。v3 baseline は明示的な incompatibility reason を返す。

- [ ] **Step 8: Task 1 を commit する**

```bash
git add CONTEXT.md docs/adr/0004-decision-report-and-provisional-score.md docs/spec/assessment-contract.md docs/spec/deterministic-signals.md docs/spec/feedback-collection.md docs/incidents/LEDGER.md test-fixtures/regressions/REG-2026-021/case.json src/schema/report.v1.ts tests/schema.test.ts tests/comparison.test.ts
git commit -m "docs: define actionable report and score contract v4"
```

### Task 2: 連続 strength、path role、関係根拠を Evidence に持たせる

**Files:**
- Create: `src/evidence/strength.ts`
- Create: `src/evidence/path-role.ts`
- Modify: `src/evidence/deterministic.ts`
- Modify: `src/plugins/analyzer.ts`
- Modify: `src/semantic/semantic-response.ts`
- Modify: `src/semantic/semantic-prompt.ts`
- Test: `tests/evidence.test.ts`
- Test: `tests/semantic/semantic-response.test.ts`
- Test: `tests/semantic/semantic-prompt.test.ts`

**Interfaces:**
- Consumes: Task 1 の `Evidence` schema と `RepositorySnapshot`。
- Produces: `normalizeAboveThreshold(value, onset): number`、`severityForStrength(strength)`、全 Evidence の `strength/rationale/pathRole/relatedPaths`。

- [ ] **Step 1: 数値の単調性と path role 除外を表す failing tests を書く**

```ts
expect([5, 6, 8, 10, 15].map((value) => normalizeAboveThreshold(value, 5)))
  .toEqual([25, 38, 59, 75, 100]);
expect(classifyPathRole('src/cart.ts')).toBe('product');
expect(classifyPathRole('tests/cart.test.ts')).toBe('test');
expect(classifyPathRole('dist/cli.js')).toBe('generated');
```

fan-in/fan-out/churn の値が増えたとき strength が減らない property test と、閾値以上の 5 段階で少なくとも 4 種類の値が得られる test も追加する。

- [ ] **Step 2: Evidence test が helper 不在で失敗することを確認する**

Run: `npm test -- tests/evidence.test.ts`

Expected: module/function not found で FAIL。

- [ ] **Step 3: strength と severity の唯一の変換関数を実装する**

```ts
export function severityForStrength(strength: number): Evidence['severity'] {
  if (strength >= 70) return 'high';
  if (strength >= 40) return 'medium';
  return 'low';
}
```

binary strength は `BINARY_SIGNAL_STRENGTH` に集約し、extractor 内へ数値 literal を散らさない。rationale は `value=10, onset=5, formula=v4-log2` のように再計算できる文字列にする。

- [ ] **Step 4: import graph から Evidence の related paths を生成する**

各 product path について direct imports と direct dependents を `relatedPaths` に重複なく昇順で保存する。test path 自身の churn/fan-out は audit Evidence には残せるが、`pathRole: test` とし score 対象から外す。

- [ ] **Step 5: test coverage を direct / transitive / missing の 3 状態へ変更する**

test file から product file への到達可能性を import graph で探索し、`coverageKind` metric を保存する。`missing-test-pair` は direct/transitive のどちらも存在しない product path にだけ生成する。transitive coverage は見つかった test path を `relatedPaths` に残し、境界テストか単なる到達かを監査できるようにする。

- [ ] **Step 6: semantic confidence と risk magnitude を分離する**

semantic response に `impactScope: 'local' | 'module' | 'repository'` を追加する。score 参加には snapshot 上の path と最低 1 件の related deterministic Evidence を要求し、scope を contract rubric の 35/60/85 へ写像する。`confidence` は Evidence confidence にだけ使う。根拠のない finding はレポートへ残すが score には加えない。

- [ ] **Step 7: Evidence と semantic tests を通す**

Run: `npm test -- tests/evidence.test.ts tests/semantic/semantic-response.test.ts tests/semantic/semantic-prompt.test.ts`

Expected: PASS。churn 5/6/8/10/15 が同じ 50/75 の二値へ潰れない。

- [ ] **Step 8: Task 2 を commit する**

```bash
git add src/evidence/strength.ts src/evidence/path-role.ts src/evidence/deterministic.ts src/plugins/analyzer.ts src/semantic/semantic-response.ts src/semantic/semantic-prompt.ts tests/evidence.test.ts tests/semantic/semantic-response.test.ts tests/semantic/semantic-prompt.test.ts
git commit -m "feat: preserve evidence strength and path relationships"
```

### Task 3: score、confidence、cluster を独立した純粋関数へ分割する

**Files:**
- Create: `src/assessment/score.ts`
- Create: `src/assessment/confidence.ts`
- Create: `src/assessment/clusters.ts`
- Modify: `src/assessment/risk.ts`
- Modify: `src/assessment/capability.ts`
- Modify: `src/calibration/golden-regression.ts`
- Modify: `tests/fixtures/golden/assessments.json`
- Test: `tests/assessment.test.ts`
- Test: `tests/golden.test.ts`

**Interfaces:**
- Consumes: Task 2 の capability-approved product Evidence と semantic findings。
- Produces: `scoreAxis(input): AxisScoreResult`、`scoreRepository(axes, clusters): RepositoryScoreResult`、`computeEvidenceConfidence(input): ConfidenceResult`、`buildMechanismClusters(evidence): RiskCluster[]`。

- [ ] **Step 1: score の識別力、単調性、内訳整合性を failing tests で固定する**

```ts
expect(scoreAxis(caseWithChurn(6)).score).toBeLessThan(scoreAxis(caseWithChurn(10)).score);
expect(scoreAxis(caseWithChurn(10)).score).toBeLessThan(scoreAxis(caseWithChurn(15)).score);
expect(repository.scoreBreakdown.axisBase + repository.scoreBreakdown.criticalClusterUplift)
  .toBeCloseTo(repository.regressionRiskScore, 0);
expect(sum(report.axes.map((axis) => axis.contributionPoints)))
  .toBeCloseTo(report.repository.scoreBreakdown.axisBase, 1);
```

弱い duplicate Evidence を追加しても score が変わらない現行 invariant は維持する。test/tooling Evidence を追加しても product score が変わらない test を追加する。

- [ ] **Step 2: relation-aware cluster の failing tests を書く**

相互に related な同一 mechanism の 3 path は 1 cluster、無関係な同一 mechanism の 2 path は 2 clusters、異なる mechanism は同じ path でも別 clusters になることを固定する。`REG-2026-006` の「無関係な signal を混ぜない」は維持する。

- [ ] **Step 3: score test が現行 max-severity 集約で失敗することを確認する**

Run: `npm test -- tests/assessment.test.ts`

Expected: churn 6 と 10 の axis score が十分に区別されず FAIL。

- [ ] **Step 4: score と repository contribution を実装する**

`score.ts` に設計節の peak/breadth/diversity と repository uplift の式をそのまま実装する。丸めは公開 object を組み立てる最後の一回だけにし、中間値を丸めない。

- [ ] **Step 5: Evidence confidence を availability の内訳として実装する**

```ts
confidence = 0.50 * capabilityCoverage
  + 0.30 * inputCompleteness
  + 0.20 * measurementReliability;
```

`capabilityCoverage` は axis ごとの supported/expected signals、`inputCompleteness` は truncation・intake issue・Git 必須性、`measurementReliability` は analyzer success と semantic provider resolution から求める。Evidence が 0 件でも analyzer が完全走査した軸は「低 confidence」にはしない。表示名は常に Evidence confidence とし、Calibration status と並記する。

- [ ] **Step 6: relatedPaths の connected component で cluster を作る**

同一 `axisId + mechanismId` 内だけで無向 component を構成する。cluster title は同一英語 label ではなく、`src/schema/report.v1.ts を中心とする高接続領域（8 paths）` のように primary path、mechanism、path count を含める。cluster score は上位 3 strength の 0.7/0.2/0.1 加重平均とし、Evidence confidence は別 field に保持する。

- [ ] **Step 7: golden fixture を絶対 band と相対順位の両方で強化する**

`fragile-cart > fragile-cart-improved >= stable-cart` を必須にし、数値 metric の段階差を持つ fixture を追加する。期待値は 50/75 の出現数や均等分布ではなく、危険構造の順位、単調性、必要 signal、禁止 signal で固定する。

- [ ] **Step 8: assessment と golden tests を通す**

Run: `npm test -- tests/assessment.test.ts tests/golden.test.ts`

Expected: PASS。連続 metric case は少なくとも 4 種類の score を持ち、無関係な path は別 cluster のままになる。

- [ ] **Step 9: Task 3 を commit する**

```bash
git add src/assessment/score.ts src/assessment/confidence.ts src/assessment/clusters.ts src/assessment/risk.ts src/assessment/capability.ts src/calibration/golden-regression.ts tests/fixtures/golden/assessments.json tests/assessment.test.ts tests/golden.test.ts
git commit -m "feat: score continuous evidence and related clusters"
```

### Task 4: cluster ごとの actionable intervention を生成する

**Files:**
- Modify: `src/recommendation/rules.ts`
- Modify: `src/operations/trend.ts`
- Modify: `src/pipeline/diagnose.ts`
- Test: `tests/recommendation.test.ts`
- Test: `tests/intervention.test.ts`
- Test: `tests/operations.test.ts`

**Interfaces:**
- Consumes: Task 3 の ranked `RiskCluster[]` と linked Evidence。
- Produces: cluster ごとの `Intervention`。priority は 1 から連番で、`priorityScore = clusterScore * evidenceConfidence * scopeFactor / costWeight`。

- [ ] **Step 1: 具体性と priority の failing tests を書く**

```ts
expect(actions.map((action) => action.priority)).toEqual([1, 2, 3]);
expect(actions[0]).toMatchObject({
  linkedClusterIds: [topCluster.clusterId],
  targetPaths: expect.arrayContaining([topCluster.paths[0]]),
  rationale: expect.stringContaining(topCluster.mechanismId),
  firstStep: expect.stringContaining(topCluster.paths[0]),
});
```

全 action の `verification` が今すぐ実行できる command または観測と、後日再評価する horizon を分けることも検証する。

- [ ] **Step 2: 現行固定 priority が test を失敗させることを確認する**

Run: `npm test -- tests/recommendation.test.ts tests/intervention.test.ts tests/operations.test.ts`

Expected: priority が 2/3/5 のままで、cluster ごとの first step がないため FAIL。

- [ ] **Step 3: signal-global rule を cluster-scoped template へ変更する**

1 cluster につき 1 intervention を生成する。同じ修正で同一 component の複数 signals を弱められる場合だけ linked signal をまとめる。`targetPaths` はデータ上は全件保持し、`firstStep` は primary path と最も強い Evidence metric を必ず含める。

- [ ] **Step 4: priority を risk、confidence、scope、cost から算出する**

`scopeFactor = 1 + min(0.5, log2(pathCount + 1) / 10)`、`costWeight = low:1, medium:2, high:3` とする。同点は cluster ID で安定 sort し、最終配列 index から 1 始まり priority を付ける。magic number は assessment contract に記載する。

- [ ] **Step 5: verification を signal ごとに現実的にする**

- dependency/test/structure: 対象 test command と再 scan で linked signal/cluster の減少を確認する。
- churn: immediate verification は hotspot の regression test・ownership/checklist の存在、lagging verification は `churnDays` 経過後の trend とする。
- semantic ambiguity: contract test または decision record と再 semantic scan を指定する。

- [ ] **Step 6: recommendation tests を通す**

Run: `npm test -- tests/recommendation.test.ts tests/intervention.test.ts tests/operations.test.ts`

Expected: PASS。上位 action は cluster score と confidence に対応し、固定 rule number を表示しない。

- [ ] **Step 7: Task 4 を commit する**

```bash
git add src/recommendation/rules.ts src/operations/trend.ts src/pipeline/diagnose.ts tests/recommendation.test.ts tests/intervention.test.ts tests/operations.test.ts
git commit -m "feat: generate ranked cluster-specific interventions"
```

### Task 5: facts / summary / actions / all の report views を実装する

**Files:**
- Create: `src/reporting/view-model.ts`
- Modify: `src/reporting/format.ts`
- Modify: `src/reporting/github.ts`
- Modify: `src/adapters/reporter.ts`
- Modify: `src/cli.ts`
- Create: `tests/reporting.test.ts`
- Create: `tests/fixtures/reporting/decision-report.md`
- Modify: `tests/integration.test.ts`
- Modify: `tests/scan.test.ts`

**Interfaces:**
- Consumes: v4 `DiagnosisReport`。`buildReportViewModel(report, limits)` は選択・grouping だけを行う。
- Produces: `ReportView = 'facts' | 'summary' | 'actions' | 'all'`、`formatReport(report, format, { view })`。JSON は view にかかわらず常に full schema を返す。

- [ ] **Step 1: 添付レポートの failure を縮約した reporting fixture を作る**

fixture は 70 Evidence、同じ mechanism の反復 cluster、6 interventions、未評価 semantic/Python/Go capability を含める。期待 Markdown を view ごとに固定し、`all` は `Diagnosis summary`、`Improvement points`、`Current state` の順で3章を持つ。

- [ ] **Step 2: 4 views の選択と責務分離を failing tests で固定する**

```ts
const facts = formatMarkdownReport(report, { view: 'facts' });
const summary = formatMarkdownReport(report, { view: 'summary' });
const actions = formatMarkdownReport(report, { view: 'actions' });
const all = formatMarkdownReport(report, { view: 'all' });

expect(facts).toContain('## Current state');
expect(facts).not.toContain('## Improvement points');
expect(summary).toContain('## Assessment summary');
expect(summary).not.toContain('## Improvement points');
expect(actions).toContain('## Improvement points');
expect(actions).not.toContain('## Current state');
expect(all.match(/^## (Diagnosis summary|Improvement points|Current state)$/gm))
  .toEqual(['## Diagnosis summary', '## Improvement points', '## Current state']);
expect(countOccurrences(all, report.evidence[0]!.evidenceId)).toBeLessThanOrEqual(1);
```

`facts` は score/priority を含まず、`summary` は action detail/raw Evidence table を含まず、`actions` の各項目は linked cluster/evidence を含むことも assertion する。

- [ ] **Step 3: current formatter が view を選択できず test に失敗することを確認する**

Run: `npm test -- tests/reporting.test.ts tests/scan.test.ts`

Expected: `ReportView` と view 別 section が存在せず FAIL。

- [ ] **Step 4: pure view model で3種類の projection を一度だけ作る**

```ts
export type ReportView = 'facts' | 'summary' | 'actions' | 'all';

export type ReportViewModel = {
  facts: FactsView;
  summary: SummaryView;
  actions: ActionsView;
};

const DEFAULT_LIMITS = {
  actionCount: 5,
  clusterCount: 5,
  pathsPerItem: 3,
  evidencePerCluster: 3,
  evidencePerFactGroup: 5,
} as const;
```

`buildReportViewModel()` は report を変更せず、Facts/summary/actions の projection を同時に作る。残りは `他 11 paths`、`他 65 evidence` と件数で示す。JSON は view model を使わず `DiagnosisReport` 全体を返す。

- [ ] **Step 5: Markdown と console を同じ view model から生成する**

`facts` は grouped Evidence と analysis coverage、`summary` は axis table と上位 clusters、`actions` は優先 intervention を描画する。`all` は同じ `ReportViewModel` を `Diagnosis summary` → `Improvement points` → `Current state` の3章へ描画する。Axis は heading の反復ではなく table にし、同じ limitation や Evidence excerpt を複数章へ出さない。

- [ ] **Step 6: CLI に view option を追加する**

`scan` と `diff` に `--view <facts|summary|actions|all>` を追加し、既定を `all` にする。不明値は parse 時に `facts, summary, actions, all のいずれかを指定してください` として exit 1 にする。`--format json --view facts` でも JSON の完全性を損なわないよう full JSON を返し、help text に `--view` は console/Markdown の projection を選び、JSON は常に full と明記する。

- [ ] **Step 7: GitHub summary を changed risk と action 中心へ揃える**

PR summary は score delta、new/worsened cluster、上位 3 actions、changed-file blast radius の順にする。annotation は新規・悪化 Evidence だけという現行境界を維持する。

- [ ] **Step 8: reporting と integration tests を通す**

Run: `npm test -- tests/reporting.test.ts tests/integration.test.ts tests/scan.test.ts tests/github.test.ts`

Expected: PASS。4 views を個別選択でき、`all` は3章を正しい順で各1回だけ含み、JSON は全 Evidence ID を含む。

- [ ] **Step 9: Task 5 を commit する**

```bash
git add src/reporting/view-model.ts src/reporting/format.ts src/reporting/github.ts src/adapters/reporter.ts src/cli.ts tests/reporting.test.ts tests/fixtures/reporting/decision-report.md tests/integration.test.ts tests/scan.test.ts tests/github.test.ts
git commit -m "feat: make diagnosis reports decision oriented"
```

### Task 6: calibration status と品質評価を通常診断へ接続する

**Files:**
- Create: `src/calibration/quality.ts`
- Modify: `src/calibration/dataset.ts`
- Modify: `src/pipeline/diagnose.ts`
- Modify: `src/cli.ts`
- Modify: `tests/calibration.test.ts`
- Modify: `tests/integration.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `.r3-doctor/calibration.json` と v4 feedback records。
- Produces: `summarizeCalibrationQuality(dataset): CalibrationSummary` と通常 report の `repository.calibration`。

- [ ] **Step 1: 3 状態と欠損理由の failing tests を書く**

```ts
expect(summarizeCalibrationQuality(noRecords).status).toBe('uncalibrated');
expect(summarizeCalibrationQuality(partialRecords).status).toBe('provisional');
expect(summarizeCalibrationQuality(validatedRecords)).toMatchObject({
  status: 'validated',
  sampleCount: 120,
  measured: ['falsePositiveRate', 'missRate', 'rankingQuality', 'explanationUsefulness'],
});
```

- [ ] **Step 2: calibration status が通常 report にないため test が失敗することを確認する**

Run: `npm test -- tests/calibration.test.ts tests/integration.test.ts`

Expected: `repository.calibration` 不在で FAIL。

- [ ] **Step 3: calibration quality summary を実装する**

`validated` の条件は各 score band 30 samples 以上、false positive/miss rate、ranking quality、explanation usefulness、golden regression pass、要求された team conditions の全充足とする。どれか一つ欠けた場合は `provisional` とし、`missingConditions` を report に保存する。

- [ ] **Step 4: pipeline へ optional calibration read を接続する**

calibration file 不在は `uncalibrated` として scan を継続する。schema 不正は既存 `ConfigError` で失敗させ、壊れた calibration を無視しない。calibration は score 値を実行時に書き換えず、interpretation status だけを与える。

- [ ] **Step 5: README に score の読み方と release rule を記載する**

`uncalibrated` は同一 contract 内の相対順位専用、`provisional` は outcome sample 不足、`validated` は記録された dataset 条件内だけで利用可能と説明する。CI gate は既存どおり calibration eligibility を満たすまで抑止する。

- [ ] **Step 6: calibration と integration tests を通す**

Run: `npm test -- tests/calibration.test.ts tests/integration.test.ts`

Expected: PASS。calibration file がない標準 fixture は `uncalibrated` と表示される。

- [ ] **Step 7: Task 6 を commit する**

```bash
git add src/calibration/quality.ts src/calibration/dataset.ts src/pipeline/diagnose.ts src/cli.ts tests/calibration.test.ts tests/integration.test.ts README.md
git commit -m "feat: expose score calibration quality"
```

### Task 7: 回帰契約、dogfood、完全検証で release 可否を判定する

**Files:**
- Modify: `tests/fixtures/reporting/decision-report.md`
- Create: `test-fixtures/regressions/REG-2026-021/report-quality.test.ts`
- Modify: `docs/incidents/LEDGER.md`
- Modify: `docs/verification/BOUNDARY-MATRIX.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Tasks 1–6 の v4 report pipeline。
- Produces: 冗長性、actionability、score honesty を保護する executable regression contract と release evidence。

- [ ] **Step 1: old-format mutant が REG-2026-021 で失敗することを確認する**

mutant は `--view` を無視し、全 clusters と全 Evidence を一つの未分割レポートとして表示する旧 formatter とする。

Run: `npm test -- test-fixtures/regressions/REG-2026-021/report-quality.test.ts`

Expected: 180 行上限、上位 action、calibration status のいずれかで FAIL。

- [ ] **Step 2: current implementation で回帰契約を通す**

Run: `npm test -- test-fixtures/regressions/REG-2026-021/report-quality.test.ts`

Expected: PASS。

- [ ] **Step 3: fixture 全体の score 順位と report snapshot を検証する**

Run: `npm test -- tests/golden.test.ts tests/reporting.test.ts`

Expected: `fragile-cart > fragile-cart-improved >= stable-cart`、連続 metric の単調性、decision report 180 行以内が PASS。

- [ ] **Step 4: r3-doctor を自身へ適用して人間向け出力を確認する**

```bash
npm run build
node dist/cli.js scan . --format markdown --view facts
node dist/cli.js scan . --format markdown --view summary
node dist/cli.js scan . --format markdown --view actions
node dist/cli.js scan . --format markdown --view all
node dist/cli.js scan . --format json
```

確認項目:

- `facts` は観測事実と解析範囲を表示し、score の解釈や改善案を含まない。
- `summary` は score、上位 cluster、calibration status を表示し、全 Evidence table を含まない。
- `actions` は上位 5 actions を表示し、各 action は 1 path から開始でき、即時 verification を持つ。
- `all` は `Diagnosis summary`、`Improvement points`、`Current state` の3章をこの順で各1回だけ表示する。
- 同じ mechanism 文と Evidence excerpt が章をまたいで反復されない。
- score の各 contribution points と cluster uplift を手計算で再現できる。
- JSON では各 human-readable view で省略した Evidence を ID から追跡できる。
- Semantic/Python/Go の制約が provider/language ごとに集約される。

- [ ] **Step 5: 完全検証を実行する**

Run: `npm run validate`

Expected: harness tests、policy validation、typecheck、全 Vitest、build がすべて exit 0。

- [ ] **Step 6: ledger、boundary evidence、changelog を確定する**

`REG-2026-021` を `protected` にし、Risk Assessment / Recommendation / Reporting / schema compatibility の検証 command を記録する。変更前後の dogfood 数値として各 view の Markdown 行数、`all` の章数、表示 cluster 数、表示 action 数、score distinctness test の結果を残す。

- [ ] **Step 7: Task 7 を commit する**

```bash
git add tests/fixtures/reporting/decision-report.md test-fixtures/regressions/REG-2026-021/report-quality.test.ts docs/incidents/LEDGER.md docs/verification/BOUNDARY-MATRIX.md CHANGELOG.md
git commit -m "test: protect actionable diagnosis report quality"
```

---

## 3. Release acceptance criteria

- `scan` と `diff` は `--view facts|summary|actions|all` を受け付け、未指定時は `all` を選ぶ。
- `facts` は現状情報だけ、`summary` はその診断要約だけ、`actions` は改善ポイントだけを表示する。
- `all` は `Diagnosis summary` → `Improvement points` → `Current state` の3章を各1回だけ表示する。
- `summary` は deterministic reporting fixture で 100 行以内、`actions` は 120 行以内、`facts` は 180 行以内、`all` は 300 行以内である。
- `actions` は最大 5件で、各 action に rationale、first step、対象 path、linked cluster/evidence、即時 verification、verification horizon がある。
- `summary` は最大 5 clusters、各 cluster 最大 3 paths / 3 Evidence で、残件数を明示する。
- JSON は `--view` の値にかかわらず全 Evidence と参照 ID を保持し、各 human-readable view から追跡できる。
- 同一 mechanism の related paths はまとまり、無関係な paths は `REG-2026-006` により混ざらない。
- 数値 signal は閾値以上の 5 段階で少なくとも 4 種類の strength を生成し、入力増加に対して単調非減少である。
- test/tooling/generated/fixture Evidence を増減しても product score は変わらない。
- `fragile-cart > fragile-cart-improved >= stable-cart` の相対順位を守る。
- confidence は Evidence confidence と表示され、Calibration status と混同されない。
- calibration dataset が条件未達なら `uncalibrated` または `provisional` と表示し、`validated` と表示しない。
- v3 baseline/diff/trend から v4 score delta を生成しない。
- `npm run validate` が exit 0 で完了する。

## 4. Non-goals

- score をリポジトリ間の絶対品質比較や障害発生確率として提供しない。
- score のヒストグラムを人工的に均等化しない。
- outcome data がない状態で「校正済み」「高精度」と表現しない。
- LLM に最終 score、priority、自由記述だけの intervention を決定させない。
- この変更で Python/Go analyzer の signal coverage 自体を拡張しない。
- 自動リファクタリング、自動 test 生成、CI gate の既定有効化は行わない。

## 5. Rollout

1. v4 を minor release の advisory output として導入し、旧 baseline を比較不能と明示する。
2. 最初の 30–50 reports で `helpful / not-actionable / false-positive / missed-risk` と action outcome を収集する。
3. score band ごとに最低 30 samples、ranking quality と explanation usefulness を含む dataset が揃うまで `validated` にしない。
4. dataset を基に strength rubric または axis weights を変更する場合は assessment contract v5 として golden/regression を再実行する。
5. CI gate は既存の calibration eligibility と team opt-in の両方を満たすまで advisory のままにする。

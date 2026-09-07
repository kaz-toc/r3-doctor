# Improvement Points Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make deterministic Improvement points internally consistent, confidence-aware, PR-relevant, verifiable, and more complete outside summary view.

**Architecture:** Keep the public v4 report schema unchanged. Select one product Evidence as the basis for each intervention, derive its path and metric together, compute priority with the lower of repository and cluster confidence, and derive PR relevance only in the human-readable diff view model. Split summary and action display limits so summary stays compact while facts/actions/all expose more useful detail.

**Tech Stack:** TypeScript 5, Node.js 22, Zod, Vitest, Commander

**Spec:** `docs/superpowers/specs/2026-09-07-improvement-points-quality-design.md`

## Global Constraints

- Do not change `Intervention`, `DiagnosisReport`, or `DiffReport` public schemas.
- Do not change the assessment contract version or score/strength formulas.
- Do not add an LLM dependency or send repository data externally.
- Locale may change prose only; it must not change basis selection, priority, ordering, or PR relevance.
- Keep summary at 5 clusters and 3 Evidence items per cluster.
- Expand facts to 8 Evidence items per group and actions to 8 items, 5 target paths, and 5 linked Evidence items.
- Preserve Evidence de-duplication in `all`; linked Evidence remains in the facts block rather than repeating under actions.
- Use TDD for every behavior change and run `npm run validate` before completion.

---

### Task 1: Bind each recommendation to one Evidence and use effective confidence

**Files:**
- Modify: `src/recommendation/rules.ts`
- Test: `tests/recommendation.test.ts`

**Interfaces:**
- Consumes: existing `Evidence`, `RiskCluster`, `computePriorityScore()` and product-path filtering.
- Produces: private `RecommendationBasis`, private `selectRecommendationBasis()`, and interventions whose path/metric text comes from the same Evidence.

- [ ] **Step 1: Write failing basis-consistency and confidence tests**

Add tests that deliberately make lexical path order disagree with lexical Evidence ID order:

```ts
it('uses one Evidence for both primary path and strongest metric', () => {
  const evidence = [
    makeEvidence({
      evidenceId: 'evidence:high-fan-out:src/a.ts',
      signalId: 'high-fan-out',
      axisId: 'change-blast-radius',
      path: 'src/a.ts',
      severity: 'high',
      strength: 100,
      message: 'fan-out',
      metrics: { fanOut: 25 },
    }),
    makeEvidence({
      evidenceId: 'evidence:high-fan-in:src/b.ts',
      signalId: 'high-fan-in',
      axisId: 'change-blast-radius',
      path: 'src/b.ts',
      severity: 'high',
      strength: 100,
      message: 'fan-in',
      metrics: { fanIn: 33 },
    }),
  ];
  const cluster = makeCluster({
    clusterId: 'cluster:change-blast-radius:high-connectivity:1',
    mechanismId: 'high-connectivity',
    axisId: 'change-blast-radius',
    score: 90,
    paths: ['src/a.ts', 'src/b.ts'],
    evidenceIds: evidence.map((item) => item.evidenceId),
  });

  const [action] = buildInterventions(evidence, [cluster], [], 1);

  expect(action?.rationale).toContain('src/b.ts');
  expect(action?.rationale).toContain('fan-in=33');
  expect(action?.rationale).not.toContain('src/a.ts');
});

it('uses the lower repository and cluster confidence for priority', () => {
  const evidence = [makeEvidence({
    evidenceId: 'evidence:large-file:src/a.ts',
    signalId: 'large-file',
    axisId: 'structural-fragility',
    path: 'src/a.ts',
    severity: 'high',
    message: 'large',
    metrics: { lines: 900 },
  })];
  const cluster = makeCluster({
    clusterId: 'cluster:structural-fragility:large-file:1',
    mechanismId: 'large-file',
    score: 80,
    confidence: 0.4,
    paths: ['src/a.ts'],
    evidenceIds: [evidence[0]!.evidenceId],
  });

  const [action] = buildInterventions(evidence, [cluster], [], 0.9);

  expect(action?.priorityScore).toBe(computePriorityScore(80, 0.4, 1, 'medium'));
});
```

- [ ] **Step 2: Run the tests and verify both fail**

Run: `npm test -- tests/recommendation.test.ts`

Expected: the first test reports a path/metric mismatch and the second reports priority calculated with `0.9` instead of `0.4`.

- [ ] **Step 3: Implement a single basis selector**

Replace independent `primaryPath()` and `strongestMetric()` selection with:

```ts
type RecommendationBasis = {
  evidence: Evidence;
  primaryPath: string;
  strongestMetric: string;
};

function metricForEvidence(evidence: Evidence): string {
  const [key, value] = Object.entries(evidence.metrics ?? {})[0] ?? [];
  return key === undefined ? evidence.message : formatMetric(key, value);
}

function selectRecommendationBasis(
  linkedEvidence: Evidence[],
  targetPaths: string[],
): RecommendationBasis | undefined {
  const productPaths = new Set(targetPaths);
  const evidence = [...linkedEvidence]
    .filter((item): item is Evidence & { path: string } =>
      typeof item.path === 'string' && productPaths.has(item.path))
    .sort((left, right) =>
      right.strength - left.strength || left.evidenceId.localeCompare(right.evidenceId))[0];
  if (!evidence) return undefined;
  return {
    evidence,
    primaryPath: evidence.path,
    strongestMetric: metricForEvidence(evidence),
  };
}
```

In `buildInterventions()`, skip the cluster when no basis exists, build `TemplateContext` from that basis, and calculate:

```ts
const effectiveConfidence = Math.min(evidenceConfidence, cluster.confidence);
const priorityScore = computePriorityScore(
  cluster.score,
  effectiveConfidence,
  targetPaths.length,
  templateDef.cost,
);
```

- [ ] **Step 4: Run focused tests**

Run: `npm test -- tests/recommendation.test.ts tests/intervention.test.ts tests/scan.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/recommendation/rules.ts tests/recommendation.test.ts
git commit -m "fix: bind recommendations to one evidence"
```

---

### Task 2: Make verification identify the exact Evidence and rescan command

**Files:**
- Modify: `src/recommendation/rules.ts`
- Modify: `src/i18n/catalog.ts`
- Test: `tests/recommendation.test.ts`
- Test: `tests/i18n.test.ts`

**Interfaces:**
- Consumes: Task 1 `RecommendationBasis.evidence.evidenceId`.
- Produces: locale-aware `intervention.verification.rescan` message appended to every mechanism-specific immediate verification.

- [ ] **Step 1: Write failing verification tests**

Extend the single-Evidence fixture test:

```ts
expect(action?.verification).toContain('r3-doctor scan . --format json');
expect(action?.verification).toContain(evidence[0]!.evidenceId);
```

Add the catalog key to the representative locale-key test:

```ts
import { getScoreDisclaimer, t } from '../src/i18n/messages.js';

expect(t('en', 'intervention.verification.rescan', {
  basisEvidenceId: 'evidence:large-file:src/a.ts',
})).toContain('evidence:large-file:src/a.ts');
expect(t('ja', 'intervention.verification.rescan', {
  basisEvidenceId: 'evidence:large-file:src/a.ts',
})).toContain('r3-doctor scan . --format json');
```

- [ ] **Step 2: Run tests and verify the missing key/command failure**

Run: `npm test -- tests/recommendation.test.ts tests/i18n.test.ts`

Expected: FAIL because `intervention.verification.rescan` is not in `MESSAGE_KEYS` and generated verification lacks the command and Evidence ID.

- [ ] **Step 3: Add locale-aware rescan copy**

Add this key to `MESSAGE_KEYS`, `en`, and `ja`:

```ts
'intervention.verification.rescan'

// en
'intervention.verification.rescan':
  'Then run `r3-doctor scan . --format json` and confirm {basisEvidenceId} is absent or weaker.',

// ja
'intervention.verification.rescan':
  '続けて `r3-doctor scan . --format json` を実行し、{basisEvidenceId} が消失または低下したことを確認する。',
```

Add `basisEvidenceId` to `TemplateContext` and append the common rescan sentence in `buildTemplateFields()`:

```ts
verification: [
  t(locale, interventionKey(prefix, 'verification'), params),
  t(locale, 'intervention.verification.rescan', params),
].join(' '),
```

Update non-volatility horizon templates to require the linked signal to remain absent on a later scan rather than only saying that the cluster score decreases. Keep the configured `churnDays` observation window for volatility.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- tests/recommendation.test.ts tests/i18n.test.ts tests/reporting.test.ts`

Expected: PASS with identical locale key sets.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/recommendation/rules.ts src/i18n/catalog.ts tests/recommendation.test.ts tests/i18n.test.ts
git commit -m "feat: make improvement verification reproducible"
```

---

### Task 3: Expand non-summary views and explain ranking

**Files:**
- Modify: `src/reporting/view-model.ts`
- Modify: `src/reporting/format.ts`
- Modify: `tests/reporting.test.ts`
- Modify: `tests/fixtures/reporting/decision-report.md`

**Interfaces:**
- Consumes: existing `DiagnosisReport.repository.confidence`, linked cluster confidence, intervention priority score and cost.
- Produces: separate action limits, `ActionChangeRelevance`, and `ActionItemView.effectiveConfidence` for formatter-only ranking explanation.

- [ ] **Step 1: Write failing limit and ranking-display tests**

Update the view-model assertions:

```ts
expect(model.facts.factGroups[0]?.evidence).toHaveLength(8);
expect(model.facts.factGroups[0]?.remainingEvidenceCount).toBe(62);
expect(model.summary.clusters).toHaveLength(5);
expect(model.summary.clusters[0]?.evidence).toHaveLength(3);
expect(model.actions.items).toHaveLength(6);
expect(model.actions.remainingActionCount).toBe(0);
expect(model.actions.items[1]?.displayPaths).toHaveLength(5);
expect(model.actions.items[1]?.linkedEvidence).toHaveLength(5);
```

Add formatter assertions:

```ts
expect(actions).toContain('Priority score:');
expect(actions).toContain('Confidence:');
expect(actions).toContain('Cost:');
expect(summary).not.toContain('Priority score:');
```

- [ ] **Step 2: Run reporting tests and verify old limits fail**

Run: `npm test -- tests/reporting.test.ts`

Expected: FAIL because facts/actions still use 5/3 limits and ranking details are not rendered.

- [ ] **Step 3: Split summary and action limits**

Change the internal limits type and defaults:

```ts
export type ReportViewLimits = {
  actionCount: number;
  clusterCount: number;
  actionPathsPerItem: number;
  evidencePerCluster: number;
  actionEvidencePerItem: number;
  evidencePerFactGroup: number;
};

export const DEFAULT_REPORT_VIEW_LIMITS = {
  actionCount: 8,
  clusterCount: 5,
  actionPathsPerItem: 5,
  evidencePerCluster: 3,
  actionEvidencePerItem: 5,
  evidencePerFactGroup: 8,
} as const satisfies ReportViewLimits;
```

Use `actionEvidencePerItem` and `actionPathsPerItem` only inside `buildActionItems()`. Add:

```ts
export type ActionItemView = {
  // existing properties
  effectiveConfidence: number;
  changeRelevance?: ActionChangeRelevance;
};

export type ActionChangeRelevance = 'new-or-worsened' | 'direct-change' | 'blast-radius';
```

For scan view-model items, derive:

```ts
const clusterConfidence = Math.min(...linkedClusters.map((cluster) => cluster.confidence));
const effectiveConfidence = Math.min(report.repository.confidence, clusterConfidence);
```

- [ ] **Step 4: Render ranking explanation without changing JSON**

Add to Markdown and console action blocks:

```ts
`- Priority score: ${intervention.priorityScore}; Confidence: ${effectiveConfidence}; Cost: ${intervention.cost}`
```

Keep `renderAllMarkdown()` and `renderAllConsole()` with `includeLinkedEvidence: false` so facts remain the single Evidence detail owner in `all`.

- [ ] **Step 5: Update fixture documentation and run tests**

Update documented facts/action counts in `tests/fixtures/reporting/decision-report.md` to 8 Evidence per group, all 6 fixture interventions, and zero remaining fixture interventions.

Run: `npm test -- tests/reporting.test.ts tests/github.test.ts tests/diff.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/reporting/view-model.ts src/reporting/format.ts tests/reporting.test.ts tests/fixtures/reporting/decision-report.md
git commit -m "feat: expand actionable report views"
```

---

### Task 4: Rank diff actions by deterministic PR relevance

**Files:**
- Modify: `src/reporting/view-model.ts`
- Modify: `src/reporting/format.ts`
- Test: `tests/diff.test.ts`
- Test: `tests/integration.test.ts`

**Interfaces:**
- Consumes: Task 3 `ActionItemView`, `DiffReport.comparison.changedFiles`, blast-radius paths, and new/worsened Evidence IDs.
- Produces: relevant diff action selection and relevance labels in Markdown/console using Task 3's `ActionChangeRelevance`.

- [ ] **Step 1: Write failing diff relevance tests**

Add three cases using `buildDecisionReportFixture()`:

```ts
it('shows direct-change actions without a compatible baseline', () => {
  const current = buildDecisionReportFixture();
  const directPath = current.interventions[0]!.targetPaths[0]!;
  const diff = diffReportSchema.parse({
    schemaVersion: DIFF_SCHEMA_VERSION,
    current,
    comparison: {
      compatible: false,
      reason: 'no stored baseline manifest',
      changedFiles: [directPath],
      blastRadius: [],
      newSignals: [],
      worsenedSignals: [],
      improvedSignals: [],
    },
  });

  const output = formatDiffMarkdownReport(diff, { view: 'actions' });
  expect(output).toContain('PR relevance: direct-change');
  expect(output).not.toContain('(none linked to changed risk)');
});
```

Add a blast-radius-only case where the action target is a transitive dependent, and a compatible comparison case containing one new/worsened action plus one direct-change action. Assert ordering with `indexOf()`:

```ts
expect(output.indexOf('PR relevance: new-or-worsened'))
  .toBeLessThan(output.indexOf('PR relevance: direct-change'));
```

- [ ] **Step 2: Run diff tests and verify baseline-free actions are empty**

Run: `npm test -- tests/diff.test.ts tests/integration.test.ts`

Expected: FAIL because current filtering accepts only new/worsened Evidence.

- [ ] **Step 3: Add internal relevance types and classifier**

Import the types exported by Task 3:

```ts
import type { ActionChangeRelevance, ActionItemView } from './view-model.js';
```

In `format.ts`, replace `resolveChangedActionViewModel()` filtering with a classifier:

```ts
const RELEVANCE_RANK: Record<ActionChangeRelevance, number> = {
  'new-or-worsened': 3,
  'direct-change': 2,
  'blast-radius': 1,
};

function classifyActionRelevance(
  item: ActionItemView,
  diff: DiffReport,
  changedEvidenceIds: Set<string>,
): ActionChangeRelevance | undefined {
  if (item.linkedClusters.some((cluster) =>
    cluster.evidenceIds.some((id) => changedEvidenceIds.has(id)))) {
    return 'new-or-worsened';
  }
  const changedFiles = new Set(diff.comparison.changedFiles);
  if (item.intervention.targetPaths.some((path) => changedFiles.has(path))) {
    return 'direct-change';
  }
  const blastPaths = new Set(diff.comparison.blastRadius.flatMap((entry) => [
    ...entry.directDependents,
    ...entry.directDependencies,
    ...entry.transitiveDependents,
    ...entry.transitiveDependencies,
  ]));
  return item.intervention.targetPaths.some((path) => blastPaths.has(path))
    ? 'blast-radius'
    : undefined;
}
```

Attach `changeRelevance`, exclude undefined results, sort by relevance rank, then `priorityScore` descending and intervention ID ascending before taking 8 items.

- [ ] **Step 4: Render relevance only for diff actions**

In both action renderers add the line only when present:

```ts
if (item.changeRelevance) {
  lines.push(`- PR relevance: ${item.changeRelevance}`);
}
```

Use console indentation for the console variant. Scan output must not contain `PR relevance:`.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- tests/diff.test.ts tests/reporting.test.ts tests/integration.test.ts`

Expected: PASS with baseline-free direct/blast actions and no unrelated actions.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/reporting/view-model.ts src/reporting/format.ts tests/diff.test.ts tests/integration.test.ts
git commit -m "feat: prioritize PR-relevant improvements"
```

---

### Task 5: Document, dogfood, and validate the completed feature

**Files:**
- Modify: `docs/spec/assessment-contract.md`
- Modify: `docs/verification/BOUNDARY-MATRIX.md`
- Modify: `docs/superpowers/specs/2026-09-07-improvement-points-quality-design.md`
- Test: repository-wide validation

**Interfaces:**
- Consumes: Tasks 1–4 completed behavior.
- Produces: documented recommendation invariants, updated bounded-view counts, and fresh dogfood evidence.

- [ ] **Step 1: Update the assessment contract**

Document these exact invariants under Intervention:

```markdown
- primary path、metric、verification Evidence IDは同一のbasis Evidenceから導出する。
- priority confidenceはrepository confidenceとcluster confidenceの小さい方とする。
- diff actionはnew/worsened、direct change、blast radiusの順でPR関連度を持ち、無関連actionを表示しない。
- summaryは5 clusters・各3 Evidenceを維持し、facts/actions/allだけ表示上限を拡張する。
```

- [ ] **Step 2: Run focused verification**

Run:

```bash
npm test -- tests/recommendation.test.ts tests/diff.test.ts tests/reporting.test.ts tests/integration.test.ts
```

Expected: all selected test files pass.

- [ ] **Step 3: Run full repository validation**

Run: `npm run validate`

Expected: harness tests, governance validation, typecheck, Vitest, and build all pass.

- [ ] **Step 4: Dogfood scan actions**

Run: `node dist/cli.js scan . --locale en --format markdown --view actions`

Confirm:

- No action combines `src/cli.ts` with another file's `fan-in` metric.
- Each action includes Priority score, Confidence, Cost, an exact Evidence ID, and the rescan command.
- Up to 8 actions and 5 target paths are shown.

- [ ] **Step 5: Dogfood diff actions**

Run: `node dist/cli.js diff . --base origin/main --locale en --format markdown --view actions`

Confirm:

- Each visible action has `PR relevance`.
- No action unrelated to changed or blast-radius paths is shown.
- An incompatible or missing baseline can still produce direct/blast actions.

- [ ] **Step 6: Record fresh bounded-output evidence**

Update `docs/verification/BOUNDARY-MATRIX.md` with the observed line counts and visible/remaining item counts from the two dogfood commands. Record observed values rather than copying previous fixture counts.

- [ ] **Step 7: Commit Task 5**

```bash
git add docs/spec/assessment-contract.md docs/verification/BOUNDARY-MATRIX.md docs/superpowers/specs/2026-09-07-improvement-points-quality-design.md
git commit -m "docs: record improvement point guarantees"
```

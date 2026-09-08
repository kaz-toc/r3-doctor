# Shadow Score Validation Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute this plan task by task. Use superpowers:test-driven-development for every behavior change and superpowers:verification-before-completion before claiming success.

**Goal:** Keep public assessment contract v4 unchanged while recording privacy-safe prospective outcomes and comparing four deterministic shadow v5 score candidates against v4.

**Architecture:** Add a validation domain under src/validation. Candidate scoring consumes the already-created RepositorySnapshot and DiagnosisReport but never mutates them. Persistence owns .r3-doctor/validation, validates every artifact strictly, and only writes after the existing Git snapshot-integrity guard passes. Evaluation reads stored scores rather than recomputing history and returns deterministic metrics plus a non-automatic promotion recommendation. src/cli.ts remains orchestration only.

**Tech Stack:** TypeScript, Node.js crypto/fs/path, Zod, Commander, Vitest, and existing persistence safety helpers.

**Working tree:** /Users/kaz/product/zoe/.worktrees/r3-doctor-shadow-score-validation

**Compatibility invariants:**

- Do not change DiagnosisReport, DiffReport, Intervention, assessment contract v4, baseline, trend, policy, calibration dataset v1, or feedback v2 schemas.
- Plain scan, existing calibration path syntax, JSON report output, CI gate score, and exit codes remain unchanged.
- Validation is opt-in. Read-only commands must not create its directory.
- Artifacts must not contain repository paths, file paths, source, evidence messages, cluster prose, or arbitrary notes.
- eligible-for-review never activates a candidate or changes the public gate.

---

## Task 1: Implement deterministic shadow candidate scoring

**Files:**

- Create: src/validation/shadow-score.ts
- Create: tests/shadow-score.test.ts
- Reuse: src/assessment/score.ts
- Reuse: src/assessment/clusters.ts
- Reuse: src/assessment/capability.ts

### Step 1: Write failing formula and immutability tests

Test these observable behaviors:

1. normalizeNumericStrength at onset/2, onset, 2x, 4x, and 8x returns 0, 25, 50, 75, and 100.
2. Intermediate values are monotonic and are not rounded before aggregation.
3. computeShadowScores returns exactly v5-activity-modifier, v5-combined, v5-confidence-uplift, and v5-soft-saturation in lexical registry order.
4. Every candidate has formulaVersion 1, an integer 0–100 score, and all five axis keys; unevaluated axes are null.
5. Calling the function does not mutate a deep clone of snapshot or report.
6. Reports created with en and ja locale produce equal candidate JSON.
7. An activity-only report cannot exceed 15.
8. A raw cluster at 100 with confidence 0.33 does not receive the full v4 cluster uplift.

The intended imports are:

~~~ts
import {
  SHADOW_CANDIDATE_IDS,
  computeShadowScores,
  normalizeNumericStrength,
} from '../src/validation/shadow-score.js';
~~~

Run:

~~~bash
npx vitest run tests/shadow-score.test.ts
~~~

Expected: FAIL because the module does not exist.

### Step 2: Add the stable registry and output types

Define:

~~~ts
export const SHADOW_REGISTRY_VERSION = 1;
export const SHADOW_CANDIDATE_IDS = [
  'v5-activity-modifier',
  'v5-combined',
  'v5-confidence-uplift',
  'v5-soft-saturation',
] as const;

export type ShadowCandidateId = typeof SHADOW_CANDIDATE_IDS[number];

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
~~~

Keep registry order stable because it is part of canonical stored JSON.

### Step 3: Implement the numeric transform

Export this pure helper:

~~~ts
export function normalizeNumericStrength(value: number, onset: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(onset) || onset <= 0 || value < onset) {
    return 0;
  }
  return Math.min(100, 25 + 25 * Math.log2(value / onset));
}
~~~

Map only evidence with a numeric metric and known onset:

- high-fan-out: snapshot.config.fanOutThreshold
- high-fan-in: snapshot.config.fanInThreshold
- large-file: snapshot.config.maxFileLines
- deep-nesting: 6
- git-churn: 5

Read metric keys fanOut, fanIn, lines, depth, and churn respectively. If a metric is absent or non-finite, retain the v4 strength. Binary strengths and semantic findings remain unchanged.

### Step 4: Rebuild soft axes and clusters

Clone evidence before changing strengths. Reuse capabilityApprovedEvidence, countProductPaths, evaluableMechanismIdsForAxis, scoreAxis, and buildMechanismClusters. Mirror evaluated status from report.axes and reuse report.capabilities and report.semanticFindings. Do not put localized cluster labels in ShadowScore.

### Step 5: Implement candidate aggregation

Implement the approved equations as pure internal helpers:

- v5-confidence-uplift: v4 axes plus confidence-weighted cluster uplift.
- v5-activity-modifier: core mean excluding change-volatility, 15% activity modifier, and non-volatility raw cluster uplift.
- v5-soft-saturation: soft axes/clusters with the v4 repository aggregator.
- v5-combined: soft axes, activity modifier, and confidence-weighted non-volatility clusters.

Store unrounded core/activity/cluster values; round and clamp only the final score.

### Step 6: Verify and commit

~~~bash
npx vitest run tests/shadow-score.test.ts tests/assessment.test.ts tests/golden.test.ts
git add src/validation/shadow-score.ts tests/shadow-score.test.ts
git commit -m "feat: add deterministic shadow score candidates"
~~~

Expected: all pass and existing v4 golden scores are unchanged.

---

## Task 2: Define strict privacy-safe validation schemas

**Files:**

- Create: src/validation/schema.ts
- Create: src/validation/snapshot.ts
- Create: tests/validation-schema.test.ts

### Step 1: Write failing schema and privacy tests

Cover:

- valid snapshot/outcome parsing;
- unknown keys at every object level;
- malformed UUID, SHA, sample ID, date, score, confidence, duplicate candidate, missing candidate, and wrong formula version;
- positive outcome requiring occurredAt and no-regression rejecting it;
- incident ID greater than 256 characters or containing control characters;
- buildValidationSnapshot never serializing known repository path, source path, evidence message, cluster prose, or source content;
- sample ID stability across locale and clock changes;
- sample ID change when horizon or shadow registry changes.

~~~bash
npx vitest run tests/validation-schema.test.ts
~~~

Expected: FAIL.

### Step 2: Add strict Zod schemas

Export validationSnapshotV1Schema, validationOutcomeV1Schema, repositoryIdSchema, sampleIdSchema, ValidationSnapshotV1, ValidationOutcomeV1, and ValidationOutcomeKind.

Use strict objects at every level. Require all five RiskAxisId keys. Validate UUID repository ID, lowercase 64-hex sample ID, 7–64 hex Git SHA, real ISO timestamps, positive integer horizon, integer scores 0–100, ratios 0–1, advisory less than or equal to gate, and exact candidate registry membership.

Cross-file timing rules belong in the outcome service, not the standalone schema.

### Step 3: Build aggregate-only snapshots

Expose:

~~~ts
export type BuildValidationSnapshotInput = {
  snapshot: RepositorySnapshot;
  report: DiagnosisReport;
  shadow: ShadowScore[];
  repositoryId: string;
  policyThresholds: { advisory: number; gate: number };
  horizonDays: number;
  recordedAt: Date;
};

export function buildValidationSnapshot(
  input: BuildValidationSnapshotInput,
): ValidationSnapshotV1;
~~~

Hash canonical JSON of repository ID, report input ID, head SHA, analysis-context fingerprint, horizon, and shadow registry version. Exclude clock, locale, prose, score values, and paths.

Store only productPathCount, sorted nonzero signalCounts, low/medium/high strength counts, capability coverage, and input completeness. Populate capabilityCoverage from the existing report.repository.confidenceBreakdown.signalCoverage field; do not change the public report schema. Compute dueAt as recordedAt plus horizonDays in UTC.

### Step 4: Verify and commit

~~~bash
npx vitest run tests/validation-schema.test.ts tests/schema.test.ts tests/redaction.test.ts
git add src/validation/schema.ts src/validation/snapshot.ts tests/validation-schema.test.ts
git commit -m "feat: define privacy-safe validation artifacts"
~~~

---

## Task 3: Persist snapshots safely and idempotently

**Files:**

- Create: src/validation/storage.ts
- Create: tests/validation-storage.test.ts
- Reuse: src/persistence/snapshot-integrity.ts
- Reuse: src/persistence/storage-boundary.ts
- Reuse: src/shared/atomic-write.ts
- Reuse: src/shared/bounded-file.ts
- Reuse: tests/helpers/git-repository.ts

### Step 1: Write failing storage tests

Cover:

- first record creates a random repository-id and one snapshot;
- identity is stable and not derived from path or remote;
- equivalent duplicate is unchanged and preserves original timestamps;
- same-ID/different-content raises ConfigError without overwrite;
- dirty Git, missing Git, changed HEAD, or changed status writes nothing;
- symlinked base, ID, child directory, or artifact is rejected;
- malformed, oversized, unknown-key, and filename/sample mismatch fail loudly;
- guard failure leaves no partial JSON;
- loading a missing directory returns empty without creating it.

~~~bash
npx vitest run tests/validation-storage.test.ts
~~~

Expected: FAIL.

### Step 2: Implement safe boundaries and repository identity

Use:

~~~ts
export const VALIDATION_DIRECTORY = '.r3-doctor/validation';
export const VALIDATION_FILE_MAX_BYTES = 256 * 1024;
~~~

Resolve base, snapshots, and outcomes independently with resolveSafeStorageDir. Mutation uses create true; reads use create false and treat only ENOENT as empty. Assert the boundary before and after I/O. Reject symlinks via lstat and read through readFileWithinByteLimit plus strict schemas.

On the first explicit record, randomUUID creates repository-id atomically. Never create it in status, compare, or plain scan. Its content is UUID plus newline.

### Step 3: Implement save/load APIs

~~~ts
export type SaveValidationSnapshotResult = {
  status: 'created' | 'unchanged';
  sample: ValidationSnapshotV1;
};

export async function saveValidationSnapshot(input: {
  snapshot: RepositorySnapshot;
  report: DiagnosisReport;
  shadow: ShadowScore[];
  policyThresholds: { advisory: number; gate: number };
  horizonDays: number;
  recordedAt?: Date;
}): Promise<SaveValidationSnapshotResult>;

export async function loadValidationSnapshots(
  repositoryPath: string,
): Promise<ValidationSnapshotV1[]>;
~~~

Call assertSnapshotPersistenceIntegrity with requireClean true before mutation and require its returned SHA. Canonical JSON has a trailing newline. Loaded arrays sort by recordedAt then sampleId.

For duplicates, compare parsed payloads after removing only recordedAt and dueAt. Equality is unchanged; any other difference is a conflict. Never replace an artifact.

### Step 4: Verify and commit

~~~bash
npx vitest run tests/validation-storage.test.ts tests/persistence.test.ts tests/review-fixes.test.ts
git add src/validation/storage.ts tests/validation-storage.test.ts
git commit -m "feat: persist validation snapshots safely"
~~~

---

## Task 4: Record outcomes and project lifecycle status

**Files:**

- Create: src/validation/outcome.ts
- Create: src/validation/status.ts
- Create: tests/validation-outcome.test.ts
- Create: tests/validation-status.test.ts

### Step 1: Write failing outcome tests

Test unknown samples, inclusive occurredAt bounds, required positive timestamps, no-regression only at/after dueAt, forbidden no-regression occurredAt, idempotency, conflicting overwrite rejection, control characters, malformed files, and symlinks. Inject observedAt in tests.

### Step 2: Implement outcome persistence

~~~ts
export async function saveValidationOutcome(
  repositoryPath: string,
  input: {
    sampleId: string;
    outcome: ValidationOutcomeKind;
    occurredAt?: string;
    incidentId?: string;
    observedAt?: Date;
  },
): Promise<{ status: 'created' | 'unchanged'; outcome: ValidationOutcomeV1 }>;

export async function loadValidationOutcomes(
  repositoryPath: string,
): Promise<ValidationOutcomeV1[]>;
~~~

Strictly load the referenced snapshot before checking time bounds. Reuse the storage boundary, byte limit, symlink, canonical ordering, atomic write, and no-overwrite rules from Task 3.

### Step 3: Write status tests and implement projection

For a fixed clock:

- no outcome before due → pending;
- no outcome on/after due → due;
- valid outcome → complete;
- retention expiry is advisory only;
- counts and samples sort deterministically;
- orphan outcome is an error.

Expose:

~~~ts
export type ValidationSampleState = 'pending' | 'due' | 'complete';

export function buildValidationStatus(
  snapshots: ValidationSnapshotV1[],
  outcomes: ValidationOutcomeV1[],
  now: Date,
  retentionDays: number,
): ValidationStatus;
~~~

Return sample ID, recorded/due dates, horizon, state, optional outcome kind, and retentionExpired. Include no paths.

### Step 4: Verify and commit

~~~bash
npx vitest run tests/validation-outcome.test.ts tests/validation-status.test.ts
git add src/validation/outcome.ts src/validation/status.ts tests/validation-outcome.test.ts tests/validation-status.test.ts
git commit -m "feat: record validation outcomes and status"
~~~

---

## Task 5: Compare models and apply evidence gates

**Files:**

- Create: src/validation/evaluate.ts
- Create: tests/validation-evaluate.test.ts
- Modify: src/calibration/golden-regression.ts
- Modify: tests/golden.test.ts

### Step 1: Write failing metric tests

Use hand-calculated corpora for:

- AUC 1 for perfect order, 0.5 for ties, and unavailable for a single class;
- average ranks for mixed ties;
- FPR/miss with score greater than or equal to threshold;
- bands exactly 0–30, 31–60, 61–80, and 81–100;
- nondecreasing monotonicity and unavailable empty bands;
- mean, median, nearest-rank p5/p95 score deltas;
- isolation by candidate, formula, horizon, and stored threshold;
- stable ordering of output and reasons.

~~~bash
npx vitest run tests/validation-evaluate.test.ts
~~~

Expected: FAIL.

### Step 2: Implement deterministic comparison

~~~ts
export type ModelId = 'v4' | ShadowCandidateId;
export type PromotionStatus =
  | 'insufficient-data'
  | 'rejected'
  | 'eligible-for-review';

export function computeRocAuc(
  rows: Array<{ score: number; positive: boolean }>,
): number | null;

export function compareValidationModels(input: {
  snapshots: ValidationSnapshotV1[];
  outcomes: ValidationOutcomeV1[];
  goldenOrdering: Record<ModelId, boolean>;
  repositoryValidationPassed: boolean;
}): ValidationComparison;
~~~

Inner-join complete pairs. regression, revert, and hotfix are positive. Use only stored scores.

Report corpus/class/repository counts, repository concentration, AUC, threshold FPR/miss, band rates, shadow-minus-v4 deltas, primary 30-day/70/85 assessments, and separately labelled exploratory cohorts. Include no generated timestamp.

### Step 3: Encode named promotion checks

For every candidate emit passed, actual, required, and a stable reason code for:

1. 30 samples in each candidate band;
2. 5 repositories;
3. maximum repository share no more than 0.40;
4. 10 positive and 10 negative;
5. AUC not below v4 and delta at least 0.03;
6. miss-rate worsening no more than 0.02;
7. nondecreasing candidate band rates;
8. deterministic serialization;
9. v4 and candidate golden ordering;
10. repository-wide validation attestation.

Volume failure means insufficient-data. After volume passes, any quality failure means rejected. All checks passing means eligible-for-review. Never mutate config or policy.

### Step 4: Extend golden ordering without changing the old API

Keep runGoldenAssessmentRegression unchanged. Add:

~~~ts
export async function runShadowGoldenAssessmentRegression():
  Promise<Record<ModelId, boolean>>;
~~~

Build each golden fixture once and require fragile greater than improved, and improved greater than or equal to stable, independently for v4 and each candidate. Prove the old fixture/API output is unchanged.

### Step 5: Verify and commit

~~~bash
npx vitest run tests/validation-evaluate.test.ts tests/golden.test.ts tests/calibration.test.ts
git add src/validation/evaluate.ts src/calibration/golden-regression.ts tests/validation-evaluate.test.ts tests/golden.test.ts
git commit -m "feat: compare validation cohorts and promotion gates"
~~~

---

## Task 6: Add opt-in CLI workflows compatibly

**Files:**

- Create: src/validation/format.ts
- Create: tests/validation-cli.test.ts
- Modify: src/cli.ts
- Modify: tests/package.test.ts
- Modify: README.md
- Create: docs/spec/shadow-score-validation.md

### Step 1: Write failing CLI tests

Run the built CLI on temporary clean Git repositories and test:

1. Plain scan JSON does not create validation storage.
2. scan with record-validation preserves stdout as the unchanged v4 report and audits only stderr.
3. validation-horizon-days without record-validation is rejected.
4. Horizon is a positive integer and defaults to 30.
5. Duplicate recording reports unchanged.
6. validation status JSON is deterministic and read-only.
7. validation outcome enforces flags/timing.
8. calibration compare returns metrics without mutating files.
9. Existing calibration path and calibration path --golden still work.
10. Console identifiers escape control characters.

~~~bash
npm run build
npx vitest run tests/validation-cli.test.ts
~~~

Expected: FAIL.

### Step 2: Add explicit scan recording

Add:

~~~text
--record-validation
--validation-horizon-days <days>
~~~

After diagnosis and policy load but before stdout, compute candidates and save. Emit exactly:

~~~text
validation sample=<escaped-id> status=<created|unchanged>
~~~

on stderr. Leave report formatting and stdout untouched. Confirm actual policy threshold field names before wiring them. Persistence failure exits 2 and emits no partial report.

### Step 3: Add validation commands

~~~text
validation status <path> [--format console|json]
validation outcome <path> --sample <id> --outcome <kind>
  [--occurred-at <ISO-8601>] [--incident <opaque-id>]
~~~

Status reads retention days but creates nothing. Outcome is the only mutation here. Stable console/JSON formatting lives in src/validation/format.ts.

### Step 4: Preserve calibration syntax while adding compare

Commander cannot register duplicate calibration commands. Keep one command with path-or-command and optional path:

~~~ts
program
  .command('calibration')
  .argument('<path-or-command>')
  .argument('[path]')
  .option('--golden')
  .option('--format <format>', 'console|json', 'console');
~~~

When the first value is compare, require the second as repository path and reject --golden. Otherwise reject a second positional and execute the exact existing calibration behavior. Thus both calibration . and calibration compare . remain valid.

Add --repository-validation-passed to compare. It is an explicit attestation for a just-completed npm run validate and defaults false; do not recursively execute arbitrary repository scripts.

### Step 5: Document and package-test

docs/spec/shadow-score-validation.md documents formulas, non-probability disclaimer, schema/versioning, timing, commands, promotion gates, privacy, manual retention, and no automatic activation.

README.md adds:

~~~bash
r3-doctor scan . --record-validation
r3-doctor validation status .
r3-doctor validation outcome . --sample <id> --outcome no-regression
npm run validate
r3-doctor calibration compare . --repository-validation-passed
~~~

Explain that no-regression is valid only after dueAt.

Extend package tests for scan help, validation help, calibration compatibility, and one installed-package record/status flow.

### Step 6: Verify and commit

~~~bash
npm run build
npx vitest run tests/validation-cli.test.ts tests/package.test.ts tests/scan.test.ts tests/calibration.test.ts
git add src/cli.ts src/validation/format.ts tests/validation-cli.test.ts tests/package.test.ts README.md docs/spec/shadow-score-validation.md
git commit -m "feat: expose shadow validation workflow"
~~~

---

## Task 7: Whole-branch verification and handoff

### Step 1: Confirm v4 compatibility

Run the same fixtures on origin/main and the feature branch:

~~~bash
npm run build
node dist/cli.js scan tests/fixtures/stable-cart --format json
node dist/cli.js scan tests/fixtures/fragile-cart --format json
node dist/cli.js calibration tests/fixtures/stable-cart
~~~

Normalize only metadata.generatedAt. Scores, axes, clusters, confidence, interventions, schema/contract versions, and existing calibration output must match.

### Step 2: Inspect privacy and mutation behavior

Record in a disposable clean Git fixture, then run:

~~~bash
rg -n "repositoryPath|relativePath|evidenceId|message|source|failureMechanism|triggerChanges" .r3-doctor/validation
~~~

Expected: no matches. Confirm plain scan creates nothing and status/compare leave mtimes unchanged.

### Step 3: Run full validation

~~~bash
npm run validate
~~~

Expected: all formatting, lint, typecheck, test, and package checks pass.

### Step 4: Perform the single scoped branch review

~~~bash
git diff --check origin/main...HEAD
git status --short
git log --oneline --decorate origin/main..HEAD
~~~

Follow AGENTS.md: one fixed BASE..HEAD review; at most one consolidated blocking-fix wave; then one limited re-review of only that fix. Record non-blocking findings without extending the loop.

### Step 5: Commit only blocking verification fixes

If a blocking issue exists:

~~~bash
git add <directly affected files>
git commit -m "fix: address shadow validation verification findings"
npm run validate
~~~

### Step 6: Hand off

Report the worktree, branch, commits, exact validation result, v4 compatibility result, promotion status semantics, and non-blocking limitations. Recommended PR title: feat: add prospective shadow score validation.

Do not merge, push, or open a PR until the user requests that external action in the execution session.

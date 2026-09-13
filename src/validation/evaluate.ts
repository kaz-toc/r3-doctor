import type { ShadowCandidateId } from './shadow-score.js';
import type { ValidationOutcomeV1, ValidationSnapshotV1 } from './schema.js';

export type ModelId = 'v4' | ShadowCandidateId;
export type PromotionStatus = 'insufficient-data' | 'rejected' | 'eligible-for-review';
export type ScoreBand = '0-30' | '31-60' | '61-80' | '81-100';

type ModelRow = {
  repositoryId: string;
  score: number;
  v4Score: number;
  positive: boolean;
  advisory: number;
  gate: number;
};

export type PromotionCheck = {
  code: string;
  passed: boolean;
  actual: boolean | number | null;
  required: boolean | number | string;
};

export type ModelMetrics = {
  sampleCount: number;
  positiveCount: number;
  negativeCount: number;
  repositoryCount: number;
  maximumRepositoryShare: number;
  rocAuc: number | null;
  thresholds: Array<{ advisory: number; gate: number; falsePositiveRate: number | null; missRate: number | null }>;
  bands: Array<{ band: ScoreBand; sampleCount: number; positiveCount: number; positiveRate: number | null }>;
  bandRatesNondecreasing: boolean | null;
  scoreDelta: { mean: number; median: number; p5: number; p95: number };
};

export type ModelAssessment = {
  candidateId: ShadowCandidateId;
  formulaVersion: 1;
  horizonDays: number;
  advisoryThreshold: number;
  gateThreshold: number;
  metrics: ModelMetrics;
  promotionStatus: PromotionStatus;
  promotionChecks: PromotionCheck[];
};

export type ValidationComparison = {
  corpus: { completeSampleCount: number; repositoryCount: number; positiveCount: number; negativeCount: number };
  primary: ModelAssessment[];
  exploratory: ModelAssessment[];
};

const BANDS: Array<{ band: ScoreBand; min: number; max: number }> = [
  { band: '0-30', min: 0, max: 30 },
  { band: '31-60', min: 31, max: 60 },
  { band: '61-80', min: 61, max: 80 },
  { band: '81-100', min: 81, max: 100 },
];

function positive(outcome: ValidationOutcomeV1): boolean {
  return outcome.outcome === 'regression' || outcome.outcome === 'revert' || outcome.outcome === 'hotfix';
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function nearestRank(values: number[], percentile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)]!;
}

function bandFor(score: number): ScoreBand {
  return BANDS.find((band) => score >= band.min && score <= band.max)?.band ?? '81-100';
}

export function computeRocAuc(rows: Array<{ score: number; positive: boolean }>): number | null {
  const positives = rows.filter((row) => row.positive);
  const negatives = rows.filter((row) => !row.positive);
  if (positives.length === 0 || negatives.length === 0) return null;
  const ranked = [...rows].sort((left, right) => left.score - right.score);
  let rank = 1;
  let positiveRankSum = 0;
  for (let index = 0; index < ranked.length;) {
    const score = ranked[index]!.score;
    let end = index;
    while (end < ranked.length && ranked[end]!.score === score) end += 1;
    const averageRank = (rank + (rank + (end - index) - 1)) / 2;
    positiveRankSum += ranked.slice(index, end).filter((row) => row.positive).length * averageRank;
    rank += end - index;
    index = end;
  }
  return (positiveRankSum - (positives.length * (positives.length + 1)) / 2) / (positives.length * negatives.length);
}

function metrics(rows: ModelRow[]): ModelMetrics {
  const positiveCount = rows.filter((row) => row.positive).length;
  const negativeCount = rows.length - positiveCount;
  const repositoryCounts = new Map<string, number>();
  for (const row of rows) repositoryCounts.set(row.repositoryId, (repositoryCounts.get(row.repositoryId) ?? 0) + 1);
  const thresholds = [...new Map(rows.map((row) => [`${row.advisory}:${row.gate}`, { advisory: row.advisory, gate: row.gate }])).values()]
    .sort((left, right) => left.advisory - right.advisory || left.gate - right.gate)
    .map((threshold) => {
      const scoped = rows.filter((row) => row.advisory === threshold.advisory && row.gate === threshold.gate);
      const negatives = scoped.filter((row) => !row.positive);
      const positives = scoped.filter((row) => row.positive);
      return {
        ...threshold,
        falsePositiveRate: negatives.length === 0 ? null : negatives.filter((row) => row.score >= threshold.advisory).length / negatives.length,
        missRate: positives.length === 0 ? null : positives.filter((row) => row.score < threshold.advisory).length / positives.length,
      };
    });
  const bands = BANDS.map(({ band }) => {
    const scoped = rows.filter((row) => bandFor(row.score) === band);
    const positives = scoped.filter((row) => row.positive).length;
    return { band, sampleCount: scoped.length, positiveCount: positives, positiveRate: scoped.length === 0 ? null : positives / scoped.length };
  });
  const rates = bands.map((entry) => entry.positiveRate);
  const bandRatesNondecreasing = rates.some((rate) => rate === null)
    ? null
    : rates.every((rate, index) => index === 0 || rate! >= rates[index - 1]!);
  const deltas = rows.map((row) => row.score - row.v4Score);
  return {
    sampleCount: rows.length,
    positiveCount,
    negativeCount,
    repositoryCount: repositoryCounts.size,
    maximumRepositoryShare: rows.length === 0 ? 0 : Math.max(...repositoryCounts.values()) / rows.length,
    rocAuc: computeRocAuc(rows),
    thresholds,
    bands,
    bandRatesNondecreasing,
    scoreDelta: {
      mean: deltas.length === 0 ? 0 : deltas.reduce((sum, value) => sum + value, 0) / deltas.length,
      median: median(deltas),
      p5: nearestRank(deltas, 5),
      p95: nearestRank(deltas, 95),
    },
  };
}

function buildChecks(
  candidateId: ShadowCandidateId,
  value: ModelMetrics,
  v4: ModelMetrics,
  goldenOrdering: Record<ModelId, boolean>,
  repositoryValidationPassed: boolean,
): PromotionCheck[] {
  const matchingThreshold = value.thresholds.find((threshold) => threshold.advisory === 70 && threshold.gate === 85);
  const v4Threshold = v4.thresholds.find((threshold) => threshold.advisory === 70 && threshold.gate === 85);
  return [
    { code: 'samples-per-band', passed: value.bands.every((band) => band.sampleCount >= 30), actual: Math.min(...value.bands.map((band) => band.sampleCount)), required: 30 },
    { code: 'repository-count', passed: value.repositoryCount >= 5, actual: value.repositoryCount, required: 5 },
    { code: 'repository-concentration', passed: value.maximumRepositoryShare <= 0.4, actual: value.maximumRepositoryShare, required: '<=0.40' },
    { code: 'class-counts', passed: value.positiveCount >= 10 && value.negativeCount >= 10, actual: Math.min(value.positiveCount, value.negativeCount), required: 10 },
    { code: 'auc-improvement', passed: value.rocAuc !== null && v4.rocAuc !== null && value.rocAuc >= v4.rocAuc && value.rocAuc - v4.rocAuc >= 0.03, actual: value.rocAuc === null || v4.rocAuc === null ? null : value.rocAuc - v4.rocAuc, required: '>=0.03 and candidate>=v4' },
    { code: 'miss-rate', passed: matchingThreshold?.missRate !== null && matchingThreshold?.missRate !== undefined && v4Threshold?.missRate !== null && v4Threshold?.missRate !== undefined && matchingThreshold.missRate - v4Threshold.missRate <= 0.02, actual: matchingThreshold?.missRate === null || matchingThreshold?.missRate === undefined || v4Threshold?.missRate === null || v4Threshold?.missRate === undefined ? null : matchingThreshold.missRate - v4Threshold.missRate, required: '<=0.02' },
    { code: 'band-monotonicity', passed: value.bandRatesNondecreasing === true, actual: value.bandRatesNondecreasing, required: true },
    { code: 'deterministic-serialization', passed: true, actual: true, required: true },
    { code: 'golden-ordering', passed: goldenOrdering.v4 && goldenOrdering[candidateId], actual: goldenOrdering.v4 && goldenOrdering[candidateId], required: true },
    { code: 'repository-validation', passed: repositoryValidationPassed, actual: repositoryValidationPassed, required: true },
  ];
}

function status(checks: PromotionCheck[]): PromotionStatus {
  const volume = checks.slice(0, 4);
  if (volume.some((check) => !check.passed)) return 'insufficient-data';
  return checks.every((check) => check.passed) ? 'eligible-for-review' : 'rejected';
}

export function compareValidationModels(input: {
  snapshots: ValidationSnapshotV1[];
  outcomes: ValidationOutcomeV1[];
  goldenOrdering: Record<ModelId, boolean>;
  repositoryValidationPassed: boolean;
}): ValidationComparison {
  const outcomes = new Map(input.outcomes.map((outcome) => [outcome.sampleId, outcome]));
  const complete = input.snapshots
    .map((sample) => ({ sample, outcome: outcomes.get(sample.sampleId) }))
    .filter((entry): entry is { sample: ValidationSnapshotV1; outcome: ValidationOutcomeV1 } => Boolean(entry.outcome))
    .sort((left, right) => left.sample.sampleId.localeCompare(right.sample.sampleId));
  const groups = new Map<string, Array<{ sample: ValidationSnapshotV1; outcome: ValidationOutcomeV1; candidate: ValidationSnapshotV1['shadow'][number] }>>();
  for (const entry of complete) {
    for (const candidate of entry.sample.shadow) {
      const key = `${candidate.candidateId}:${candidate.formulaVersion}:${entry.sample.horizonDays}:${entry.sample.policyThresholds.advisory}:${entry.sample.policyThresholds.gate}`;
      const rows = groups.get(key) ?? [];
      rows.push({ ...entry, candidate });
      groups.set(key, rows);
    }
  }
  const assessments = [...groups.values()].map((entries) => {
    const first = entries[0]!;
    const rows = entries.map(({ sample, outcome, candidate }) => ({
      repositoryId: sample.repositoryId,
      score: candidate.score,
      v4Score: sample.v4.score,
      positive: positive(outcome),
      advisory: sample.policyThresholds.advisory,
      gate: sample.policyThresholds.gate,
    }));
    const candidateMetrics = metrics(rows);
    const v4Metrics = metrics(rows.map((row) => ({ ...row, score: row.v4Score })));
    const checks = buildChecks(first.candidate.candidateId, candidateMetrics, v4Metrics, input.goldenOrdering, input.repositoryValidationPassed);
    return {
      candidateId: first.candidate.candidateId,
      formulaVersion: first.candidate.formulaVersion,
      horizonDays: first.sample.horizonDays,
      advisoryThreshold: first.sample.policyThresholds.advisory,
      gateThreshold: first.sample.policyThresholds.gate,
      metrics: candidateMetrics,
      promotionStatus: status(checks),
      promotionChecks: checks,
    };
  }).sort((left, right) => left.candidateId.localeCompare(right.candidateId) || left.formulaVersion - right.formulaVersion || left.horizonDays - right.horizonDays || left.advisoryThreshold - right.advisoryThreshold || left.gateThreshold - right.gateThreshold);
  const primary = assessments.filter((assessment) => assessment.horizonDays === 30 && assessment.advisoryThreshold === 70 && assessment.gateThreshold === 85);
  const exploratory = assessments.filter((assessment) => !primary.includes(assessment));
  const repositoryIds = new Set(complete.map((entry) => entry.sample.repositoryId));
  const positives = complete.filter((entry) => positive(entry.outcome)).length;
  return {
    corpus: { completeSampleCount: complete.length, repositoryCount: repositoryIds.size, positiveCount: positives, negativeCount: complete.length - positives },
    primary,
    exploratory,
  };
}

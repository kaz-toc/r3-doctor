import {
  capabilityApprovedEvidence,
  countProductPaths,
  evaluableMechanismIdsForAxis,
} from '../assessment/capability.js';
import { buildMechanismClusters } from '../assessment/clusters.js';
import { scoreAxis } from '../assessment/score.js';
import type { RepositorySnapshot } from '../intake/snapshot.js';
import type { DiagnosisReport, Evidence, RiskAxisId, RiskCluster } from '../schema/report.v1.js';
import { riskAxisIdSchema, severityForStrength } from '../schema/report.v1.js';
import { isScoreEligibleSemanticFinding } from '../semantic/semantic-response.js';

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

const NUMERIC_ONSETS = {
  'high-fan-out': { metric: 'fanOut', onset: (snapshot: RepositorySnapshot) => snapshot.config.fanOutThreshold },
  'high-fan-in': { metric: 'fanIn', onset: (snapshot: RepositorySnapshot) => snapshot.config.fanInThreshold },
  'large-file': { metric: 'lines', onset: (snapshot: RepositorySnapshot) => snapshot.config.maxFileLines },
  'deep-nesting': { metric: 'depth', onset: () => 6 },
  'git-churn': { metric: 'churn', onset: () => 5 },
} as const;

function clampScore(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)));
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function axisScoresFromReport(report: DiagnosisReport): Record<RiskAxisId, number | null> {
  return Object.fromEntries(riskAxisIdSchema.options.map((axisId) => {
    const axis = report.axes.find((entry) => entry.axisId === axisId);
    return [axisId, axis && !axis.unevaluated ? axis.score : null];
  })) as Record<RiskAxisId, number | null>;
}

function axesAndClusters(
  snapshot: RepositorySnapshot,
  report: DiagnosisReport,
  softSaturation: boolean,
): { axisScores: Record<RiskAxisId, number | null>; clusters: RiskCluster[] } {
  if (!softSaturation) {
    return { axisScores: axisScoresFromReport(report), clusters: report.clusters };
  }

  const evidence = capabilityApprovedEvidence(report.evidence, report.capabilities).map((item) => {
    const normalized = normalizedEvidenceStrength(item, snapshot);
    return normalized === item.strength
      ? { ...item, relatedPaths: [...item.relatedPaths], metrics: item.metrics ? { ...item.metrics } : undefined }
      : {
          ...item,
          strength: normalized,
          severity: severityForStrength(normalized),
          relatedPaths: [...item.relatedPaths],
          metrics: item.metrics ? { ...item.metrics } : undefined,
        };
  });
  const productPathCount = countProductPaths(snapshot);
  const snapshotPaths = new Set(snapshot.files.map((file) => file.relativePath.replaceAll('\\', '/')));
  const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]));
  const scoreEligibleSemanticFindings = report.semanticFindings.filter((finding) =>
    isScoreEligibleSemanticFinding(finding, snapshotPaths, evidenceById),
  );
  const axisScores = Object.fromEntries(riskAxisIdSchema.options.map((axisId) => {
    const reportAxis = report.axes.find((axis) => axis.axisId === axisId);
    if (!reportAxis || reportAxis.unevaluated) {
      return [axisId, null];
    }
    const result = scoreAxis({
      axisId,
      evidence: evidence.filter((item) => item.axisId === axisId),
      semanticFindings: report.semanticFindings.filter((item) => item.axisId === axisId),
      productPathCount,
      evaluableMechanismIds: evaluableMechanismIdsForAxis(axisId, report.capabilities),
      snapshotPaths,
      evidenceById,
    });
    return [axisId, result.score];
  })) as Record<RiskAxisId, number | null>;
  return {
    axisScores,
    clusters: buildMechanismClusters(evidence, scoreEligibleSemanticFindings, 'en'),
  };
}

function normalizedEvidenceStrength(item: Evidence, snapshot: RepositorySnapshot): number {
  const mapping = NUMERIC_ONSETS[item.signalId as keyof typeof NUMERIC_ONSETS];
  if (!mapping || !item.metrics) {
    return item.strength;
  }
  const value = item.metrics[mapping.metric];
  const onset = mapping.onset(snapshot);
  return typeof value === 'number' && Number.isFinite(value) && Number.isFinite(onset)
    ? normalizeNumericStrength(value, onset)
    : item.strength;
}

function repositoryBase(axisScores: Record<RiskAxisId, number | null>): number {
  return mean(Object.values(axisScores).filter((score): score is number => score !== null));
}

function activityBase(axisScores: Record<RiskAxisId, number | null>): {
  core: number;
  activityUplift: number;
  adjustedBase: number;
} {
  const core = mean(Object.entries(axisScores)
    .filter(([axisId, score]) => axisId !== 'change-volatility' && score !== null)
    .map(([, score]) => score as number));
  const volatility = axisScores['change-volatility'] ?? 0;
  const activityUplift = 0.15 * (100 - core) * (volatility / 100);
  return { core, activityUplift, adjustedBase: core + activityUplift };
}

function clusterUplift(clusters: RiskCluster[], base: number, confidenceWeighted: boolean, excludeVolatility: boolean): number {
  const relevant = clusters.filter((cluster) => !excludeVolatility || cluster.axisId !== 'change-volatility');
  const maximum = relevant.length === 0 ? 0 : Math.max(...relevant.map((cluster) =>
    confidenceWeighted ? cluster.score * cluster.confidence : cluster.score,
  ));
  return 0.3 * Math.max(0, maximum - base);
}

function result(
  candidateId: ShadowCandidateId,
  axisScores: Record<RiskAxisId, number | null>,
  core: number,
  activityUplift: number,
  clusterUpliftValue: number,
): ShadowScore {
  return {
    candidateId,
    formulaVersion: 1,
    score: clampScore(core + activityUplift + clusterUpliftValue),
    axisScores,
    scoreBreakdown: { core, activityUplift, clusterUplift: clusterUpliftValue },
  };
}

export function normalizeNumericStrength(value: number, onset: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(onset) || onset <= 0 || value < onset) {
    return 0;
  }
  return Math.min(100, 25 + 25 * Math.log2(value / onset));
}

export function computeShadowScores(snapshot: RepositorySnapshot, report: DiagnosisReport): ShadowScore[] {
  const v4 = axesAndClusters(snapshot, report, false);
  const soft = axesAndClusters(snapshot, report, true);
  const v4Base = repositoryBase(v4.axisScores);
  const softBase = repositoryBase(soft.axisScores);
  const v4Activity = activityBase(v4.axisScores);
  const softActivity = activityBase(soft.axisScores);

  return [
    result(
      'v5-activity-modifier',
      v4.axisScores,
      v4Activity.core,
      v4Activity.activityUplift,
      clusterUplift(v4.clusters, v4Activity.adjustedBase, false, true),
    ),
    result(
      'v5-combined',
      soft.axisScores,
      softActivity.core,
      softActivity.activityUplift,
      clusterUplift(soft.clusters, softActivity.adjustedBase, true, true),
    ),
    result(
      'v5-confidence-uplift',
      v4.axisScores,
      v4Base,
      0,
      clusterUplift(v4.clusters, v4Base, true, false),
    ),
    result(
      'v5-soft-saturation',
      soft.axisScores,
      softBase,
      0,
      clusterUplift(soft.clusters, softBase, false, false),
    ),
  ];
}

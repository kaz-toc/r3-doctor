import type {
  AxisAssessment,
  AxisScoreBreakdown,
  Evidence,
  RepositoryAssessment,
  RiskAxisId,
  RiskCluster,
  SemanticFinding,
  SignalId,
} from '../schema/report.v1.js';
import { MECHANISM_FOR_SIGNAL } from '../schema/report.v1.js';
import { isScoreEligibleSemanticFinding, semanticRiskStrength } from '../semantic/semantic-response.js';

const AXIS_PEAK_WEIGHTS = [0.6, 0.3, 0.1] as const;
export const CLUSTER_PEAK_WEIGHTS = [0.7, 0.2, 0.1] as const;

export type AxisScoreInput = {
  axisId: RiskAxisId;
  evidence: Evidence[];
  semanticFindings: SemanticFinding[];
  productPathCount: number;
  evaluableMechanismIds: string[];
  snapshotPaths?: Set<string>;
  evidenceById?: Map<string, Evidence>;
};

export type AxisScoreResult = {
  score: number;
  scoreBreakdown: AxisScoreBreakdown;
};

export type RepositoryScoreResult = Pick<RepositoryAssessment, 'regressionRiskScore' | 'scoreBreakdown'>;

function mechanismForEvidence(item: Evidence): string {
  return MECHANISM_FOR_SIGNAL[item.signalId as Exclude<SignalId, 'semantic-ambiguity'>] ?? item.signalId;
}

function dedupeEvidence(items: Evidence[]): Evidence[] {
  const byKey = new Map<string, Evidence>();
  for (const item of items) {
    const key = `${item.signalId}:${item.path ?? 'repo'}`;
    const existing = byKey.get(key);
    if (!existing || item.strength > existing.strength) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()];
}

function productEvidence(items: Evidence[]): Evidence[] {
  return items.filter((item) => item.pathRole === 'product');
}

export function weightedPeak(strengths: number[], weights: readonly number[] = AXIS_PEAK_WEIGHTS): number {
  const sorted = [...strengths].sort((left, right) => right - left);
  let peak = 0;
  for (let index = 0; index < weights.length && index < sorted.length; index += 1) {
    peak += sorted[index]! * weights[index]!;
  }
  return peak;
}

function computeBreadth(affectedProductPaths: number, totalProductPaths: number): number {
  if (totalProductPaths <= 0 || affectedProductPaths <= 0) {
    return 0;
  }
  const ratio = affectedProductPaths / totalProductPaths;
  return Math.min(100, (ratio / 0.5) * 100);
}

function computeDiversity(observedMechanismIds: Set<string>, evaluableMechanismIds: string[]): number {
  if (evaluableMechanismIds.length === 0) {
    return 0;
  }
  const evaluable = new Set(evaluableMechanismIds);
  let observed = 0;
  for (const mechanismId of observedMechanismIds) {
    if (evaluable.has(mechanismId)) {
      observed += 1;
    }
  }
  return (observed / evaluable.size) * 100;
}

function semanticStrengths(
  findings: SemanticFinding[],
  snapshotPaths: Set<string>,
  evidenceById: Map<string, Evidence>,
): number[] {
  return findings
    .filter((finding) =>
      isScoreEligibleSemanticFinding(finding, snapshotPaths, evidenceById),
    )
    .map((finding) => {
      const impactScope = finding.impactScope ?? 'module';
      return semanticRiskStrength(impactScope);
    });
}

export function scoreAxis(input: AxisScoreInput): AxisScoreResult {
  const deduped = dedupeEvidence(input.evidence);
  const scoredEvidence = productEvidence(deduped);
  const snapshotPaths = input.snapshotPaths ?? new Set(
    scoredEvidence.map((item) => item.path).filter((itemPath): itemPath is string => Boolean(itemPath)),
  );
  const evidenceById = input.evidenceById ?? new Map(deduped.map((item) => [item.evidenceId, item]));

  const strengths = [
    ...scoredEvidence.map((item) => item.strength),
    ...semanticStrengths(input.semanticFindings, snapshotPaths, evidenceById),
  ];
  const peak = weightedPeak(strengths, AXIS_PEAK_WEIGHTS);

  const affectedPaths = new Set(
    scoredEvidence.map((item) => item.path).filter((itemPath): itemPath is string => Boolean(itemPath)),
  );
  for (const finding of input.semanticFindings) {
    if (finding.path && isScoreEligibleSemanticFinding(finding, snapshotPaths, evidenceById)) {
      affectedPaths.add(finding.path);
    }
  }
  const breadth = computeBreadth(affectedPaths.size, input.productPathCount);

  const observedMechanisms = new Set(
    scoredEvidence.map((item) => mechanismForEvidence(item)),
  );
  if (input.axisId === 'semantic-ambiguity' && semanticStrengths(input.semanticFindings, snapshotPaths, evidenceById).length > 0) {
    observedMechanisms.add('semantic-ambiguity');
  }
  const diversity = computeDiversity(observedMechanisms, input.evaluableMechanismIds);

  const score = Math.round(0.65 * peak + 0.25 * breadth + 0.1 * diversity);
  const scoreBreakdown: AxisScoreBreakdown = {
    peak: Math.round(peak),
    breadth: Math.round(breadth),
    diversity: Math.round(diversity),
  };

  return { score, scoreBreakdown };
}

export function scoreRepository(axes: AxisAssessment[], clusters: RiskCluster[]): RepositoryScoreResult {
  const evaluated = axes.filter((axis) => !axis.unevaluated);
  if (evaluated.length === 0) {
    return {
      regressionRiskScore: 0,
      scoreBreakdown: { axisBase: 0, criticalClusterUplift: 0 },
    };
  }

  const axisBase = evaluated.reduce((sum, axis) => sum + axis.score, 0) / evaluated.length;
  const maxClusterScore = clusters.length > 0 ? Math.max(...clusters.map((cluster) => cluster.score)) : 0;
  const uplift = 0.3 * Math.max(0, maxClusterScore - axisBase);
  const regressionRiskScore = Math.round(axisBase + uplift);
  const roundedAxisBase = Math.round(axisBase);

  return {
    regressionRiskScore,
    scoreBreakdown: {
      axisBase: roundedAxisBase,
      criticalClusterUplift: Math.max(0, regressionRiskScore - roundedAxisBase),
    },
  };
}

export function assignContributionPoints(axes: AxisAssessment[], axisBase: number): void {
  const evaluated = axes.filter((axis) => !axis.unevaluated);
  const totalScore = evaluated.reduce((sum, axis) => sum + axis.score, 0);
  for (const axis of axes) {
    if (axis.unevaluated || totalScore === 0) {
      axis.contributionPoints = 0;
      continue;
    }
    axis.contributionPoints = Number(((axis.score / totalScore) * axisBase).toFixed(1));
  }
}

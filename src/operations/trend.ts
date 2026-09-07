import type { DiagnosisReport, Intervention, TrendEntry } from '../schema/report.v1.js';
import { computePriorityScore, computeScopeFactor, COST_WEIGHT, displayTargetPaths } from '../recommendation/rules.js';
import { R3DoctorError } from '../shared/errors.js';

export { computePriorityScore, computeScopeFactor, COST_WEIGHT, displayTargetPaths };

export type ContributingChange = {
  generatedAt: string;
  commitSha?: string;
  score: number;
  changedFiles: string[];
};

export type TrendAnalysis = {
  entries: TrendEntry[];
  degradationStartAt?: string;
  scoreDeltaFromFirst: number;
  contributingClusterIds: string[];
  contributingChanges: ContributingChange[];
};

export type InvestmentPriority = {
  intervention: Intervention;
  urgency: number;
  rationale: string;
};

export function rankInvestmentPriorities(report: DiagnosisReport): InvestmentPriority[] {
  return [...report.interventions]
    .sort((left, right) => left.priority - right.priority)
    .map((intervention) => ({
      intervention,
      urgency: intervention.priorityScore,
      rationale: `priorityScore=${intervention.priorityScore}, priority=${intervention.priority}, cost=${intervention.cost}`,
    }));
}

export function analyzeTrend(entries: TrendEntry[]): TrendAnalysis {
  if (entries.length === 0) {
    return { entries: [], scoreDeltaFromFirst: 0, contributingClusterIds: [], contributingChanges: [] };
  }

  const contractVersions = new Set(entries.map((entry) => entry.contractVersion));
  if (contractVersions.size > 1) {
    throw new R3DoctorError('trend entries span multiple assessment contract versions');
  }

  const sorted = [...entries].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) {
    return { entries: sorted, scoreDeltaFromFirst: 0, contributingClusterIds: [], contributingChanges: [] };
  }

  const scoreDeltaFromFirst = last.score - first.score;

  let degradationStartAt: string | undefined;
  if (sorted.length >= 2 && last.score > first.score) {
    let startIdx = sorted.length - 1;
    for (let index = 0; index < sorted.length; index += 1) {
      const entry = sorted[index];
      if (!entry) {
        continue;
      }
      const maxFromIndex = Math.max(...sorted.slice(index).map((item) => item.score));
      if (entry.score < last.score && maxFromIndex > entry.score) {
        startIdx = Math.min(startIdx, index);
      }
    }
    degradationStartAt = sorted[startIdx]?.generatedAt;
  }

  const startEntry = degradationStartAt ? sorted.find((entry) => entry.generatedAt === degradationStartAt) : undefined;
  const startClusters = new Map((startEntry?.topClusters ?? []).map((cluster) => [cluster.clusterId, cluster.score]));
  const contributingClusterIds = last.topClusters
    .filter((cluster) => (startClusters.get(cluster.clusterId) ?? 0) < cluster.score)
    .map((cluster) => cluster.clusterId);

  const contributingChanges: ContributingChange[] = degradationStartAt
    ? sorted
        .filter((entry) => entry.generatedAt > degradationStartAt)
        .filter((entry, idx, arr) => idx === 0 || entry.score > (arr[idx - 1]?.score ?? entry.score))
        .map((entry) => ({
          generatedAt: entry.generatedAt,
          commitSha: entry.commitSha,
          score: entry.score,
          changedFiles: entry.changedFiles ?? [],
        }))
    : [];

  return {
    entries: sorted,
    degradationStartAt,
    scoreDeltaFromFirst,
    contributingClusterIds,
    contributingChanges,
  };
}

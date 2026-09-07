import type {
  AxisAssessment,
  CapabilityResult,
  DiagnosisReport,
  Evidence,
  Intervention,
  RiskCluster,
} from '../schema/report.v1.js';

export type ReportView = 'facts' | 'summary' | 'actions' | 'all';

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

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 } as const;

export type FactEvidenceGroup = {
  mechanismId: string;
  mechanismLabel: string;
  triggerSummary: string;
  evidence: Evidence[];
  remainingEvidenceCount: number;
};

export type FactsView = {
  metadata: DiagnosisReport['metadata'];
  capabilities: CapabilityResult[];
  unevaluatedAreas: string[];
  limitationSummaries: string[];
  factGroups: FactEvidenceGroup[];
  totalEvidenceCount: number;
};

export type SummaryAxisRow = {
  axisId: AxisAssessment['axisId'];
  name: string;
  scoreLabel: string;
  contributionPoints: number;
  confidence: number;
  topRationale: string;
};

export type SummaryClusterBlock = {
  cluster: RiskCluster;
  evidence: Evidence[];
  remainingEvidenceCount: number;
};

export type SummaryView = {
  regressionRiskScore: number;
  scoreBand: string;
  confidence: number;
  calibrationStatus: string;
  unevaluatedAxisCount: number;
  disclaimer: string;
  scoreBreakdown: DiagnosisReport['repository']['scoreBreakdown'];
  axes: SummaryAxisRow[];
  clusters: SummaryClusterBlock[];
  remainingClusterCount: number;
  limitations: string[];
};

export type ActionChangeRelevance = 'new-or-worsened' | 'direct-change' | 'blast-radius';

export type ActionItemView = {
  intervention: Intervention;
  linkedClusters: RiskCluster[];
  linkedEvidence: Evidence[];
  displayPaths: string[];
  remainingPathCount: number;
  effectiveConfidence: number;
  changeRelevance?: ActionChangeRelevance;
};

export type ActionsView = {
  items: ActionItemView[];
  remainingActionCount: number;
};

export type ReportViewModel = {
  facts: FactsView;
  summary: SummaryView;
  actions: ActionsView;
};

function sortEvidence(items: Evidence[]): Evidence[] {
  return [...items].sort((a, b) => {
    const strengthDiff = b.strength - a.strength;
    if (strengthDiff !== 0) {
      return strengthDiff;
    }
    const severityDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (severityDiff !== 0) {
      return severityDiff;
    }
    return a.evidenceId.localeCompare(b.evidenceId);
  });
}

function axisHasSignals(report: DiagnosisReport, axisId: AxisAssessment['axisId']): boolean {
  return report.evidence.some((item) => item.axisId === axisId) ||
    report.semanticFindings.some((item) => item.axisId === axisId);
}

export function formatAxisScoreLabel(axis: AxisAssessment, report: DiagnosisReport): string {
  if (axis.unevaluated) {
    return 'unevaluated (excluded from aggregate)';
  }
  if (!axisHasSignals(report, axis.axisId)) {
    return '0 (no signals detected)';
  }
  return String(axis.score);
}

export function scoreBand(score: number): string {
  if (score >= 66) {
    return 'high';
  }
  if (score >= 36) {
    return 'moderate';
  }
  return 'low';
}

function evidenceById(report: DiagnosisReport): Map<string, Evidence> {
  return new Map(report.evidence.map((item) => [item.evidenceId, item]));
}

function clusterById(report: DiagnosisReport): Map<string, RiskCluster> {
  return new Map(report.clusters.map((item) => [item.clusterId, item]));
}

function buildLimitationSummaries(report: DiagnosisReport): string[] {
  const lines: string[] = [];
  for (const capability of report.capabilities) {
    if (capability.unevaluatedSignals.length > 0) {
      lines.push(
        `${capability.language}: ${capability.unevaluatedSignals.length} unevaluated signals (${capability.completeness})`,
      );
    }
  }
  if (report.metadata.semanticProviderStatus === 'not-configured') {
    lines.push('semantic-ambiguity: LLM provider not configured');
  } else if (report.metadata.semanticProviderStatus === 'unavailable') {
    lines.push(`semantic-ambiguity: provider unavailable (${report.metadata.semanticProviderReason ?? 'unknown'})`);
  }
  for (const area of report.metadata.unevaluatedAreas) {
    lines.push(area);
  }
  return [...new Set(lines)];
}

function buildFactGroups(report: DiagnosisReport, limits: ReportViewLimits): FactEvidenceGroup[] {
  const evidenceToMechanism = new Map<string, { mechanismId: string; mechanismLabel: string; triggerSummary: string }>();
  for (const cluster of report.clusters) {
    const triggerSummary = cluster.triggerChanges.join('; ') || cluster.failureMechanism;
    for (const evidenceId of cluster.evidenceIds) {
      evidenceToMechanism.set(evidenceId, {
        mechanismId: cluster.mechanismId,
        mechanismLabel: cluster.failureMechanism,
        triggerSummary,
      });
    }
  }

  const grouped = new Map<string, { mechanismLabel: string; triggerSummary: string; evidence: Evidence[] }>();
  for (const item of sortEvidence(report.evidence)) {
    const mapping = evidenceToMechanism.get(item.evidenceId);
    const mechanismId = mapping?.mechanismId ?? item.signalId;
    const mechanismLabel = mapping?.mechanismLabel ?? item.signalId;
    const triggerSummary = mapping?.triggerSummary ?? item.message;
    const existing = grouped.get(mechanismId);
    if (existing) {
      existing.evidence.push(item);
      continue;
    }
    grouped.set(mechanismId, {
      mechanismLabel,
      triggerSummary,
      evidence: [item],
    });
  }

  return [...grouped.entries()]
    .sort(([, left], [, right]) => {
      const strengthDiff = (right.evidence[0]?.strength ?? 0) - (left.evidence[0]?.strength ?? 0);
      if (strengthDiff !== 0) {
        return strengthDiff;
      }
      return left.mechanismLabel.localeCompare(right.mechanismLabel);
    })
    .map(([mechanismId, group]) => {
      const visible = group.evidence.slice(0, limits.evidencePerFactGroup);
      return {
        mechanismId,
        mechanismLabel: group.mechanismLabel,
        triggerSummary: group.triggerSummary,
        evidence: visible,
        remainingEvidenceCount: Math.max(0, group.evidence.length - visible.length),
      };
    });
}

function topAxisRationale(report: DiagnosisReport, axisId: AxisAssessment['axisId']): string {
  const axisEvidence = sortEvidence(report.evidence.filter((item) => item.axisId === axisId));
  if (axisEvidence.length > 0) {
    const top = axisEvidence[0]!;
    return `${top.signalId} @ ${top.path ?? 'repo'}: ${top.rationale}`;
  }
  const finding = report.semanticFindings.find((item) => item.axisId === axisId);
  return finding?.summary ?? 'no scored signals';
}

function buildSummaryAxes(report: DiagnosisReport): SummaryAxisRow[] {
  return report.axes.map((axis) => ({
    axisId: axis.axisId,
    name: axis.name,
    scoreLabel: formatAxisScoreLabel(axis, report),
    contributionPoints: axis.contributionPoints,
    confidence: axis.confidence,
    topRationale: topAxisRationale(report, axis.axisId),
  }));
}

function buildSummaryClusters(report: DiagnosisReport, limits: ReportViewLimits): {
  clusters: SummaryClusterBlock[];
  remainingClusterCount: number;
} {
  const byId = evidenceById(report);
  const sortedClusters = [...report.clusters].sort((a, b) => b.score - a.score || a.clusterId.localeCompare(b.clusterId));
  const visible = sortedClusters.slice(0, limits.clusterCount);
  return {
    clusters: visible.map((cluster) => {
      const clusterEvidence = sortEvidence(
        cluster.evidenceIds
          .map((id) => byId.get(id))
          .filter((item): item is Evidence => Boolean(item)),
      );
      const shown = clusterEvidence.slice(0, limits.evidencePerCluster);
      return {
        cluster,
        evidence: shown,
        remainingEvidenceCount: Math.max(0, clusterEvidence.length - shown.length),
      };
    }),
    remainingClusterCount: Math.max(0, sortedClusters.length - visible.length),
  };
}

function buildActionItems(report: DiagnosisReport, limits: ReportViewLimits): {
  items: ActionItemView[];
  remainingActionCount: number;
} {
  const clusters = clusterById(report);
  const sorted = [...report.interventions].sort(
    (a, b) => a.priority - b.priority || b.priorityScore - a.priorityScore || a.interventionId.localeCompare(b.interventionId),
  );
  const visible = sorted.slice(0, limits.actionCount);
  return {
    items: visible.map((intervention) => {
      const linkedClusters = intervention.linkedClusterIds
        .map((id) => clusters.get(id))
        .filter((item): item is RiskCluster => Boolean(item));
      const linkedEvidenceIds = new Set(
        linkedClusters.flatMap((cluster) => cluster.evidenceIds),
      );
      const linkedEvidence = sortEvidence(
        report.evidence.filter((item) =>
          linkedEvidenceIds.has(item.evidenceId) && intervention.linkedSignalIds.includes(item.signalId),
        ),
      ).slice(0, limits.actionEvidencePerItem);
      const displayPaths = intervention.targetPaths.slice(0, limits.actionPathsPerItem);
      const clusterConfidence = linkedClusters.length > 0
        ? Math.min(...linkedClusters.map((cluster) => cluster.confidence))
        : report.repository.confidence;
      return {
        intervention,
        linkedClusters,
        linkedEvidence,
        displayPaths,
        remainingPathCount: Math.max(0, intervention.targetPaths.length - displayPaths.length),
        effectiveConfidence: Math.min(report.repository.confidence, clusterConfidence),
      };
    }),
    remainingActionCount: Math.max(0, sorted.length - visible.length),
  };
}

export function buildReportViewModel(
  report: DiagnosisReport,
  limits: ReportViewLimits = DEFAULT_REPORT_VIEW_LIMITS,
): ReportViewModel {
  const unevaluatedAxisCount = report.axes.filter((axis) => axis.unevaluated).length;
  const limitationSummaries = buildLimitationSummaries(report);
  const factGroups = buildFactGroups(report, limits);
  const { clusters, remainingClusterCount } = buildSummaryClusters(report, limits);
  const { items, remainingActionCount } = buildActionItems(report, limits);

  return {
    facts: {
      metadata: report.metadata,
      capabilities: report.capabilities,
      unevaluatedAreas: report.metadata.unevaluatedAreas,
      limitationSummaries,
      factGroups,
      totalEvidenceCount: report.evidence.length,
    },
    summary: {
      regressionRiskScore: report.repository.regressionRiskScore,
      scoreBand: scoreBand(report.repository.regressionRiskScore),
      confidence: report.repository.confidence,
      calibrationStatus: report.repository.calibration.status,
      unevaluatedAxisCount,
      disclaimer: report.repository.disclaimer,
      scoreBreakdown: report.repository.scoreBreakdown,
      axes: buildSummaryAxes(report),
      clusters,
      remainingClusterCount,
      limitations: limitationSummaries,
    },
    actions: {
      items,
      remainingActionCount,
    },
  };
}

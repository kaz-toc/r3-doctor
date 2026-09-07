import type {
  AxisAssessment,
  CapabilityResult,
  DiagnosisReport,
  Evidence,
  Intervention,
  RiskAxisId,
  RiskCluster,
  SemanticFinding,
  SignalId,
} from '../schema/report.v1.js';
import {
  ASSESSMENT_CONTRACT_VERSION,
  MECHANISM_FOR_SIGNAL,
  REPORT_SCHEMA_VERSION,
  SCORE_DISCLAIMER,
  SIGNAL_AXIS,
  diagnosisReportSchema,
} from '../schema/report.v1.js';
import type { RepositorySnapshot } from '../intake/snapshot.js';
import type { SemanticProviderResolution } from '../semantic/provider.js';
import { axisHasSupportedSignals, capabilityApprovedEvidence } from './capability.js';

const AXIS_NAMES: Record<RiskAxisId, string> = {
  'structural-fragility': 'Structural Fragility',
  'change-blast-radius': 'Change Blast Radius',
  'verification-gap': 'Verification Gap',
  'change-volatility': 'Change Volatility',
  'semantic-ambiguity': 'Semantic Ambiguity',
};

const SEVERITY_WEIGHT = { low: 1, medium: 2, high: 3 } as const;

function aggregateSignalStrength(items: Evidence[]): number {
  if (items.length === 0) {
    return 0;
  }
  const byKey = new Map<string, Evidence>();
  for (const item of items) {
    const key = `${item.signalId}:${item.path ?? 'repo'}`;
    const existing = byKey.get(key);
    if (!existing || SEVERITY_WEIGHT[item.severity] > SEVERITY_WEIGHT[existing.severity]) {
      byKey.set(key, item);
    }
  }
  const strengths = [...byKey.values()].map((item) => SEVERITY_WEIGHT[item.severity] * 25);
  return Math.min(100, Math.max(...strengths));
}

function axisScoreForEvidence(items: Evidence[], semantic: SemanticFinding[]): number {
  const deterministic = aggregateSignalStrength(items);
  const semanticScore =
    semantic.length > 0 ? Math.min(100, Math.round(Math.max(...semantic.map((f) => f.confidence * 100)) * 0.5)) : 0;
  return Math.max(deterministic, semanticScore);
}

function clusterScore(items: Evidence[], semantic: SemanticFinding[] = []): number {
  return axisScoreForEvidence(items, semantic);
}

function connectedPaths(paths: string[], edges: Array<{ from: string; to: string }>): string[][] {
  const graph = new Map<string, Set<string>>();
  for (const node of paths) {
    graph.set(node, new Set());
  }
  for (const edge of edges) {
    if (graph.has(edge.from) && graph.has(edge.to)) {
      graph.get(edge.from)?.add(edge.to);
      graph.get(edge.to)?.add(edge.from);
    }
  }

  const visited = new Set<string>();
  const components: string[][] = [];

  for (const start of [...graph.keys()].sort()) {
    if (visited.has(start)) {
      continue;
    }
    const queue = [start];
    const component: string[] = [];
    visited.add(start);
    while (queue.length > 0) {
      const node = queue.shift();
      if (!node) {
        continue;
      }
      component.push(node);
      for (const next of graph.get(node) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    components.push(component.sort());
  }

  return components;
}

function mechanismForEvidence(item: Evidence): string {
  return MECHANISM_FOR_SIGNAL[item.signalId as Exclude<SignalId, 'semantic-ambiguity'>] ?? item.signalId;
}

function buildMechanismClusters(evidence: Evidence[], semanticFindings: SemanticFinding[]): RiskCluster[] {
  const groups = new Map<string, Evidence[]>();

  for (const item of evidence) {
    const mechanismId = mechanismForEvidence(item);
    const key = `${item.axisId}:${mechanismId}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  const clusters: RiskCluster[] = [];

  for (const [key, items] of groups.entries()) {
    const [axisId, mechanismId] = key.split(':') as [RiskAxisId, string];
    const paths = [...new Set(items.map((item) => item.path).filter(Boolean) as string[])].sort();
    const edges = items
      .flatMap((item) => {
        const cycle = item.metrics?.cycle;
        if (typeof cycle !== 'string') {
          return [];
        }
        const nodes = cycle.split('->');
        const localEdges: Array<{ from: string; to: string }> = [];
        for (let index = 0; index < nodes.length - 1; index += 1) {
          const from = nodes[index];
          const to = nodes[index + 1];
          if (from && to) {
            localEdges.push({ from, to });
          }
        }
        return localEdges;
      })
      .filter((edge) => paths.includes(edge.from) || paths.includes(edge.to));

    const components =
      mechanismId === 'dependency-cycle'
        ? connectedPaths(paths, edges)
        : paths.length > 0
          ? paths.map((itemPath) => [itemPath])
          : [[]];

    components.forEach((componentPaths, index) => {
      const componentEvidence = items.filter((item) =>
        componentPaths.length === 0 ? !item.path : Boolean(item.path && componentPaths.includes(item.path)),
      );
      if (componentEvidence.length === 0) {
        return;
      }

      clusters.push({
        clusterId: `cluster:${axisId}:${mechanismId}:${index + 1}`,
        title: `${AXIS_NAMES[axisId]} / ${mechanismId}`,
        score: clusterScore(componentEvidence),
        confidence: Math.min(1, Number((componentEvidence.length / 4).toFixed(2))),
        axisId,
        mechanismId,
        paths: componentPaths,
        failureMechanism: describeMechanism(mechanismId),
        triggerChanges: describeTriggers(mechanismId),
        evidenceIds: componentEvidence.map((item) => item.evidenceId),
      });
    });
  }

  const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]));
  const semanticGroups = new Map<string, SemanticFinding[]>();
  for (const finding of semanticFindings) {
    const relatedPaths = finding.relatedEvidenceIds
      .map((evidenceId) => evidenceById.get(evidenceId)?.path)
      .filter((itemPath): itemPath is string => Boolean(itemPath));
    const paths = [...new Set([finding.path, ...relatedPaths].filter((itemPath): itemPath is string => Boolean(itemPath)))].sort();
    const anchor = paths.join('|') || [...finding.relatedEvidenceIds].sort().join('|');
    const current = semanticGroups.get(anchor) ?? [];
    current.push(finding);
    semanticGroups.set(anchor, current);
  }

  [...semanticGroups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([, findings], index) => {
      const evidenceIds = [...new Set(findings.flatMap((finding) => finding.relatedEvidenceIds))].sort();
      const paths = [...new Set([
        ...findings.map((finding) => finding.path),
        ...evidenceIds.map((evidenceId) => evidenceById.get(evidenceId)?.path),
      ].filter((itemPath): itemPath is string => Boolean(itemPath)))].sort();
      clusters.push({
        clusterId: `cluster:semantic-ambiguity:semantic-ambiguity:${index + 1}`,
        title: `${AXIS_NAMES['semantic-ambiguity']} / semantic-ambiguity`,
        score: clusterScore([], findings),
        confidence: Math.max(...findings.map((finding) => finding.confidence)),
        axisId: 'semantic-ambiguity',
        mechanismId: 'semantic-ambiguity',
        paths,
        failureMechanism: describeMechanism('semantic-ambiguity'),
        triggerChanges: describeTriggers('semantic-ambiguity'),
        evidenceIds,
      });
    });

  return clusters.sort((a, b) => b.score - a.score);
}

function describeMechanism(mechanismId: string): string {
  switch (mechanismId) {
    case 'dependency-cycle':
      return '循環依存により変更が予測不能な連鎖反応を起こす。';
    case 'high-connectivity':
      return '高い fan-in / fan-out により小さな変更が広範囲へ波及する。';
    case 'verification-gap':
      return '変更影響に対する検証が不足し、デグレが検出されにくい。';
    case 'volatility':
      return '頻繁な変更が不安定な領域へ集中している。';
    case 'semantic-ambiguity':
      return '暗黙契約や命名の乖離により意図復元が困難。';
    case 'large-file':
      return '単一ファイルへの責務集中により変更リスクが局所化している。';
    case 'barrel-export':
      return 'barrel 再エクスポートが依存境界を曖昧にしている。';
    default:
      return `${mechanismId} に関連する構造上の弱点。`;
  }
}

function describeTriggers(mechanismId: string): string[] {
  switch (mechanismId) {
    case 'dependency-cycle':
      return ['共有モジュールの API 変更', '循環内ファイルのリファクタリング'];
    case 'high-connectivity':
      return ['hub モジュールの公開 API 変更', '共通型の変更'];
    case 'verification-gap':
      return ['テスト未整備領域の機能追加', '境界条件の変更'];
    case 'volatility':
      return ['高 churn ファイルの連続変更', 'revert を伴う修正'];
    case 'semantic-ambiguity':
      return ['命名変更', '例外分岐の追加'];
    default:
      return ['関連ファイルの変更'];
  }
}

function aggregateRepositoryScore(axes: AxisAssessment[], clusters: RiskCluster[]): number {
  const evaluated = axes.filter((axis) => !axis.unevaluated);
  if (evaluated.length === 0) {
    return 0;
  }
  const axisAvg = evaluated.reduce((sum, axis) => sum + axis.score, 0) / evaluated.length;
  const maxCluster = clusters.length > 0 ? Math.max(...clusters.map((c) => c.score)) : 0;
  return Math.min(100, Math.round(axisAvg * 0.7 + maxCluster * 0.3));
}

function computeConfidence(input: {
  snapshot: RepositorySnapshot;
  capabilities: CapabilityResult[];
  selectedAnalyzers: number;
  successfulAnalyzers: number;
  semanticResolution: SemanticProviderResolution;
  axes: AxisAssessment[];
}): number {
  const expectedSignals = input.capabilities.flatMap((entry) => [...entry.supportedSignals, ...entry.unevaluatedSignals]);
  const supportedSignals = input.capabilities.flatMap((entry) => entry.supportedSignals);
  const capabilityRatio = expectedSignals.length > 0 ? supportedSignals.length / expectedSignals.length : 1;
  const analyzerRatio =
    input.selectedAnalyzers > 0 ? input.successfulAnalyzers / input.selectedAnalyzers : 1;
  const gitFactor = input.snapshot.gitAvailable ? 1 : 0.85;
  const truncationFactor = input.snapshot.truncated ? 0.85 : 1;
  const semanticFactor =
    input.semanticResolution.status === 'available'
      ? 1
      : input.snapshot.config.llm.enabled
        ? 0.85
        : 0.95;

  const confidence =
    capabilityRatio * 0.35 + analyzerRatio * 0.25 + gitFactor * 0.15 + truncationFactor * 0.15 + semanticFactor * 0.1;

  return Math.max(0, Math.min(1, Number(confidence.toFixed(2))));
}

export type AssessmentInput = {
  snapshot: RepositorySnapshot;
  evidence: Evidence[];
  semanticFindings: SemanticFinding[];
  capabilities: CapabilityResult[];
  analyzers: string[];
  selectedAnalyzers: number;
  successfulAnalyzers: number;
  semanticResolution: SemanticProviderResolution;
  llmProvider?: string;
  semanticProviderImplementationVersion?: string;
};

export function assessRisk(input: AssessmentInput): DiagnosisReport {
  const axisIds = Object.keys(AXIS_NAMES) as RiskAxisId[];
  const semanticAxisUnevaluated =
    input.semanticResolution.status !== 'available' ||
    (input.snapshot.config.llm.enabled && input.semanticFindings.length === 0);
  const evaluatedEvidence = capabilityApprovedEvidence(input.evidence, input.capabilities);

  const axes: AxisAssessment[] = axisIds.map((axisId) => {
    const axisEvidence = evaluatedEvidence.filter((item) => item.axisId === axisId);
    const semantic = input.semanticFindings.filter((item) => item.axisId === axisId);
    const unevaluated =
      axisId === 'semantic-ambiguity'
        ? semanticAxisUnevaluated
        : !axisHasSupportedSignals(axisId, input.capabilities);
    const score = unevaluated ? 0 : axisScoreForEvidence(axisEvidence, semantic);
    const languageCapability = input.capabilities.find((entry) =>
      entry.unevaluatedSignals.some((signal) => SIGNAL_AXIS[signal as Exclude<SignalId, 'semantic-ambiguity'>] === axisId),
    );
    const axisConfidence = unevaluated
      ? 0
      : axisId === 'semantic-ambiguity' && semantic.length > 0
        ? Math.max(...semantic.map((finding) => finding.confidence))
        : Math.min(1, Number(((axisEvidence.length > 0 ? 0.6 : 0) + (languageCapability ? 0.4 : 0.2)).toFixed(2)));
    return {
      axisId,
      name: AXIS_NAMES[axisId],
      score,
      contribution: 0,
      confidence: axisConfidence,
      unevaluated,
    };
  });

  const clusters = buildMechanismClusters(evaluatedEvidence, input.semanticFindings);
  const repositoryScore = aggregateRepositoryScore(axes, clusters);
  const totalContribution = axes.filter((a) => !a.unevaluated).reduce((sum, a) => sum + a.score, 0) || 1;
  for (const axis of axes) {
    axis.contribution = axis.unevaluated ? 0 : Number((axis.score / totalContribution).toFixed(2));
  }

  const confidence = computeConfidence({
    snapshot: input.snapshot,
    capabilities: input.capabilities,
    selectedAnalyzers: input.selectedAnalyzers,
    successfulAnalyzers: input.successfulAnalyzers,
    semanticResolution: input.semanticResolution,
    axes,
  });

  const unevaluatedAreas = axes.filter((a) => a.unevaluated).map((a) => a.name);
  for (const capability of input.capabilities) {
    for (const signal of capability.unevaluatedSignals) {
      unevaluatedAreas.push(`${capability.language}:signal:${signal}`);
    }
  }
  for (const issue of input.snapshot.intakeIssues) {
    unevaluatedAreas.push(`${issue.kind}:${issue.path}`);
  }
  if (!input.snapshot.gitAvailable) {
    unevaluatedAreas.push('Git churn (git unavailable)');
  }

  const semanticProviderStatus =
    input.semanticResolution.status === 'available'
      ? ('available' as const)
      : input.snapshot.config.llm.enabled
        ? input.semanticResolution.reason.includes('failed')
          ? ('failed' as const)
          : ('unavailable' as const)
        : ('not-configured' as const);

  const report: DiagnosisReport = {
    metadata: {
      schemaVersion: REPORT_SCHEMA_VERSION,
      assessmentContractVersion: ASSESSMENT_CONTRACT_VERSION,
      generatedAt: new Date().toISOString(),
      inputId: input.snapshot.inputId,
      repositoryPath: input.snapshot.repositoryPath,
      unitId: input.snapshot.unitId,
      analyzers: input.analyzers,
      llmProvider: input.llmProvider,
      semanticProviderImplementationVersion: input.semanticProviderImplementationVersion,
      truncated: input.snapshot.truncated,
      unevaluatedAreas: [...new Set(unevaluatedAreas)].sort(),
      semanticProviderStatus,
      semanticProviderReason:
        input.semanticResolution.status === 'unavailable'
          ? input.semanticResolution.reason
          : input.semanticResolution.status === 'available' &&
              input.snapshot.config.llm.enabled &&
              input.semanticFindings.length === 0
            ? 'no findings returned'
            : undefined,
    },
    repository: {
      regressionRiskScore: repositoryScore,
      confidence,
      disclaimer: SCORE_DISCLAIMER,
    },
    axes,
    clusters,
    evidence: input.evidence,
    semanticFindings: input.semanticFindings,
    interventions: [],
    capabilities: input.capabilities,
  };

  return diagnosisReportSchema.parse(report);
}

import type { Evidence, Intervention, RiskCluster, SignalId } from '../schema/report.v1.js';
import { isNonProductPath } from '../evidence/diagnostic-paths.js';
import type { ReportLocale } from '../i18n/locale.js';
import { DEFAULT_LOCALE } from '../i18n/locale.js';
import { t, type MessageKey } from '../i18n/messages.js';

export const COST_WEIGHT = { low: 1, medium: 2, high: 3 } as const;

export function computeScopeFactor(pathCount: number): number {
  return 1 + Math.min(0.5, Math.log2(pathCount + 1) / 10);
}

export function computePriorityScore(
  clusterScore: number,
  evidenceConfidence: number,
  pathCount: number,
  cost: Intervention['cost'],
): number {
  const scopeFactor = computeScopeFactor(pathCount);
  const raw = (clusterScore * evidenceConfidence * scopeFactor) / COST_WEIGHT[cost];
  return Math.min(100, Number(raw.toFixed(2)));
}

export function displayTargetPaths(targetPaths: string[], limit = 3): string[] {
  return targetPaths.slice(0, limit);
}

type TemplateContext = {
  cluster: RiskCluster;
  primaryPath: string;
  strongestMetric: string;
  targetPaths: string[];
  linkedSignalIds: SignalId[];
  churnDays: number;
};

type RecommendationBasis = {
  evidence: Evidence;
  primaryPath: string;
  strongestMetric: string;
};

type MechanismTemplateDef = {
  kind: Intervention['kind'];
  cost: Intervention['cost'];
  prefix: string;
};

const MECHANISM_TEMPLATE_DEFS: Record<string, MechanismTemplateDef> = {
  'dependency-cycle': { kind: 'structure', cost: 'medium', prefix: 'dependency-cycle' },
  'high-connectivity': { kind: 'structure', cost: 'high', prefix: 'high-connectivity' },
  'verification-gap': { kind: 'test', cost: 'low', prefix: 'verification-gap' },
  volatility: { kind: 'process', cost: 'low', prefix: 'volatility' },
  'large-file': { kind: 'structure', cost: 'medium', prefix: 'large-file' },
  'barrel-export': { kind: 'structure', cost: 'medium', prefix: 'barrel-export' },
  'deep-nesting': { kind: 'structure', cost: 'medium', prefix: 'deep-nesting' },
  'unresolved-import': { kind: 'structure', cost: 'high', prefix: 'unresolved-import' },
  'semantic-ambiguity': { kind: 'process', cost: 'medium', prefix: 'semantic-ambiguity' },
};

const DEFAULT_TEMPLATE_DEF: MechanismTemplateDef = {
  kind: 'structure',
  cost: 'medium',
  prefix: 'default',
};

function templateParams(ctx: TemplateContext): Record<string, string | number> {
  return {
    mechanismId: ctx.cluster.mechanismId,
    primaryPath: ctx.primaryPath,
    strongestMetric: ctx.strongestMetric,
    score: ctx.cluster.score,
    churnDays: ctx.churnDays,
  };
}

function interventionKey(prefix: string, field: string): MessageKey {
  return `intervention.${prefix}.${field}` as MessageKey;
}

function buildTemplateFields(locale: ReportLocale, prefix: string, ctx: TemplateContext): {
  title: string;
  description: string;
  expectedEffect: string;
  rationale: string;
  firstStep: string;
  verification: string;
  verificationHorizon: string;
} {
  const params = templateParams(ctx);
  return {
    title: t(locale, interventionKey(prefix, 'title')),
    description: t(locale, interventionKey(prefix, 'description')),
    expectedEffect: t(locale, interventionKey(prefix, 'expectedEffect')),
    rationale: t(locale, interventionKey(prefix, 'rationale'), params),
    firstStep: t(locale, interventionKey(prefix, 'firstStep'), params),
    verification: t(locale, interventionKey(prefix, 'verification'), params),
    verificationHorizon: t(locale, interventionKey(prefix, 'verificationHorizon'), params),
  };
}

function formatMetric(key: string, value: string | number | boolean): string {
  switch (key) {
    case 'fanIn':
      return `fan-in=${value}`;
    case 'fanOut':
      return `fan-out=${value}`;
    case 'churn':
      return `churn=${value}`;
    case 'days':
      return `days=${value}`;
    case 'lines':
      return `lines=${value}`;
    case 'depth':
      return `depth=${value}`;
    case 'cycle':
      return `cycle=${value}`;
    case 'expectedTest':
      return `expectedTest=${value}`;
    default:
      return `${key}=${value}`;
  }
}

function metricForEvidence(evidence: Evidence): string {
  const metricEntries = Object.entries(evidence.metrics ?? {});
  if (metricEntries.length === 0) {
    return evidence.message;
  }
  const [key, value] = metricEntries[0] ?? ['metric', 'unknown'];
  return formatMetric(key, value);
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
  if (!evidence) {
    return undefined;
  }
  return {
    evidence,
    primaryPath: evidence.path,
    strongestMetric: metricForEvidence(evidence),
  };
}

function templateDefForMechanism(mechanismId: string): MechanismTemplateDef {
  return MECHANISM_TEMPLATE_DEFS[mechanismId] ?? DEFAULT_TEMPLATE_DEF;
}

export function buildInterventions(
  evidence: Evidence[],
  clusters: RiskCluster[],
  diagnosticSkipRoots: string[] = [],
  evidenceConfidence = 1,
  churnDays = 90,
  locale: ReportLocale = DEFAULT_LOCALE,
): Intervention[] {
  const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]));
  const interventions: Intervention[] = [];

  for (const cluster of clusters) {
    const linkedEvidence = cluster.evidenceIds
      .map((evidenceId) => evidenceById.get(evidenceId))
      .filter((item): item is Evidence => Boolean(item));
    const targetPaths = [...new Set(linkedEvidence.map((item) => item.path).filter(Boolean) as string[])]
      .filter((filePath) => !isNonProductPath(filePath, diagnosticSkipRoots))
      .sort();
    if (targetPaths.length === 0) {
      continue;
    }

    const basis = selectRecommendationBasis(linkedEvidence, targetPaths);
    if (!basis) {
      continue;
    }
    const linkedSignalIds = [...new Set(linkedEvidence.map((item) => item.signalId))].sort() as SignalId[];
    const templateDef = templateDefForMechanism(cluster.mechanismId);
    const context: TemplateContext = {
      cluster,
      primaryPath: basis.primaryPath,
      strongestMetric: basis.strongestMetric,
      targetPaths,
      linkedSignalIds,
      churnDays,
    };
    const fields = buildTemplateFields(locale, templateDef.prefix, context);

    interventions.push({
      interventionId: `intervention:${cluster.clusterId}`,
      priority: 0,
      title: fields.title,
      description: fields.description,
      kind: templateDef.kind,
      targetPaths,
      linkedSignalIds,
      linkedClusterIds: [cluster.clusterId],
      expectedEffect: fields.expectedEffect,
      verification: fields.verification,
      cost: templateDef.cost,
      rationale: fields.rationale,
      firstStep: fields.firstStep,
      priorityScore: computePriorityScore(
        cluster.score,
        Math.min(evidenceConfidence, cluster.confidence),
        targetPaths.length,
        templateDef.cost,
      ),
      verificationHorizon: fields.verificationHorizon,
    });
  }

  return interventions
    .sort((left, right) => {
      if (right.priorityScore !== left.priorityScore) {
        return right.priorityScore - left.priorityScore;
      }
      return left.linkedClusterIds[0]!.localeCompare(right.linkedClusterIds[0]!);
    })
    .map((intervention, index) => ({
      ...intervention,
      priority: index + 1,
    }));
}

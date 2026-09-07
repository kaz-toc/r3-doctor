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

function primaryPath(cluster: RiskCluster, linkedEvidence: Evidence[]): string {
  const strengthByPath = new Map<string, number>();
  for (const item of linkedEvidence) {
    if (!item.path) {
      continue;
    }
    strengthByPath.set(item.path, Math.max(strengthByPath.get(item.path) ?? 0, item.strength));
  }
  const paths = cluster.paths.length > 0 ? cluster.paths : [...strengthByPath.keys()];
  return [...paths].sort((left, right) => {
    const leftStrength = strengthByPath.get(left) ?? 0;
    const rightStrength = strengthByPath.get(right) ?? 0;
    if (rightStrength !== leftStrength) {
      return rightStrength - leftStrength;
    }
    return left.localeCompare(right);
  })[0] ?? 'repository';
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

function strongestMetric(linkedEvidence: Evidence[]): string {
  const ranked = [...linkedEvidence].sort((left, right) => {
    if (right.strength !== left.strength) {
      return right.strength - left.strength;
    }
    return left.evidenceId.localeCompare(right.evidenceId);
  });
  const strongest = ranked[0];
  if (!strongest) {
    return 'strength=unknown';
  }
  const metricEntries = Object.entries(strongest.metrics ?? {});
  if (metricEntries.length === 0) {
    return strongest.message;
  }
  const [key, value] = metricEntries[0] ?? ['metric', 'unknown'];
  return formatMetric(key, value);
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

    const linkedSignalIds = [...new Set(linkedEvidence.map((item) => item.signalId))].sort() as SignalId[];
    const anchorPath = primaryPath(cluster, linkedEvidence);
    const metricLabel = strongestMetric(linkedEvidence);
    const templateDef = templateDefForMechanism(cluster.mechanismId);
    const context: TemplateContext = {
      cluster,
      primaryPath: anchorPath,
      strongestMetric: metricLabel,
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
        evidenceConfidence,
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

import type { Evidence, RiskAxisId, RiskCluster, SemanticFinding, SignalId } from '../schema/report.v1.js';
import { MECHANISM_FOR_SIGNAL } from '../schema/report.v1.js';
import type { ReportLocale } from '../i18n/locale.js';
import { DEFAULT_LOCALE } from '../i18n/locale.js';
import { t, type MessageKey } from '../i18n/messages.js';
import { MESSAGE_KEYS } from '../i18n/catalog.js';
import { semanticRiskStrength } from '../semantic/semantic-response.js';
import { CLUSTER_PEAK_WEIGHTS, weightedPeak } from './score.js';

const MECHANISM_TRIGGER_COUNTS: Record<string, number> = {
  'dependency-cycle': 2,
  'high-connectivity': 2,
  'verification-gap': 2,
  volatility: 2,
  'semantic-ambiguity': 2,
  'large-file': 1,
  'barrel-export': 1,
};

function mechanismLabel(locale: ReportLocale, mechanismId: string): string {
  const key = `mechanism.${mechanismId}.label`;
  if ((MESSAGE_KEYS as readonly string[]).includes(key)) {
    return t(locale, key as MessageKey);
  }
  return mechanismId;
}

function describeMechanism(locale: ReportLocale, mechanismId: string): {
  failureMechanism: string;
  triggerChanges: string[];
} {
  const failureKey = `mechanism.${mechanismId}.failure`;
  if ((MESSAGE_KEYS as readonly string[]).includes(failureKey)) {
    const triggerCount = MECHANISM_TRIGGER_COUNTS[mechanismId] ?? 1;
    const triggers: string[] = [];
    for (let index = 0; index < triggerCount; index += 1) {
      triggers.push(t(locale, `mechanism.${mechanismId}.trigger.${index}` as MessageKey));
    }
    return {
      failureMechanism: t(locale, failureKey as MessageKey),
      triggerChanges: triggers,
    };
  }
  return {
    failureMechanism: t(locale, 'cluster.fallback.failure', { mechanismId }),
    triggerChanges: [t(locale, 'cluster.fallback.trigger')],
  };
}

function mechanismForEvidence(item: Evidence): string {
  return MECHANISM_FOR_SIGNAL[item.signalId as Exclude<SignalId, 'semantic-ambiguity'>] ?? item.signalId;
}

function connectedComponents(paths: string[], edges: Array<{ from: string; to: string }>): string[][] {
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

function buildRelationEdges(items: Evidence[]): Array<{ from: string; to: string }> {
  const edges: Array<{ from: string; to: string }> = [];
  for (const item of items) {
    const path = item.path;
    if (!path) {
      continue;
    }
    for (const relatedPath of item.relatedPaths) {
      edges.push({ from: path, to: relatedPath });
    }
    const cycle = item.metrics?.cycle;
    if (typeof cycle === 'string') {
      const nodes = cycle.split('->');
      for (let index = 0; index < nodes.length - 1; index += 1) {
        const from = nodes[index];
        const to = nodes[index + 1];
        if (from && to) {
          edges.push({ from, to });
        }
      }
    }
  }
  return edges;
}

function primaryPath(componentPaths: string[], componentEvidence: Evidence[]): string {
  const strengthByPath = new Map<string, number>();
  for (const item of componentEvidence) {
    if (!item.path) {
      continue;
    }
    const current = strengthByPath.get(item.path) ?? 0;
    strengthByPath.set(item.path, Math.max(current, item.strength));
  }
  return [...componentPaths].sort((left, right) => {
    const leftStrength = strengthByPath.get(left) ?? 0;
    const rightStrength = strengthByPath.get(right) ?? 0;
    if (rightStrength !== leftStrength) {
      return rightStrength - leftStrength;
    }
    return left.localeCompare(right);
  })[0] ?? componentPaths[0] ?? 'repository';
}

function clusterTitle(
  locale: ReportLocale,
  mechanismId: string,
  componentPaths: string[],
  componentEvidence: Evidence[],
): string {
  const label = mechanismLabel(locale, mechanismId);
  const anchor = primaryPath(componentPaths, componentEvidence);
  const pathCount = componentPaths.length;
  if (pathCount === 0) {
    return t(locale, 'cluster.title.repositoryWide', { label });
  }
  return t(locale, 'cluster.title.centered', { anchor, label, pathCount });
}

function clusterConfidence(componentEvidence: Evidence[]): number {
  const uniqueSignals = new Set(componentEvidence.map((item) => item.signalId));
  return Math.min(1, Number((uniqueSignals.size / 3).toFixed(2)));
}

function semanticClusterScore(findings: SemanticFinding[]): number {
  const strengths = findings.map((finding) => {
    const impactScope = finding.impactScope ?? 'module';
    return semanticRiskStrength(impactScope);
  });
  return Math.round(weightedPeak(strengths, CLUSTER_PEAK_WEIGHTS));
}

function clusterScore(componentEvidence: Evidence[]): number {
  const strengths = componentEvidence.map((item) => item.strength);
  return Math.round(weightedPeak(strengths, CLUSTER_PEAK_WEIGHTS));
}

export function buildMechanismClusters(
  evidence: Evidence[],
  semanticFindings: SemanticFinding[] = [],
  locale: ReportLocale = DEFAULT_LOCALE,
): RiskCluster[] {
  const groups = new Map<string, Evidence[]>();

  for (const item of evidence) {
    if (item.pathRole !== 'product') {
      continue;
    }
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
    const edges = buildRelationEdges(items).filter((edge) => paths.includes(edge.from) || paths.includes(edge.to));
    const components = paths.length > 0 ? connectedComponents(paths, edges) : [[]];

    components.forEach((componentPaths, index) => {
      const componentEvidence = items.filter((item) =>
        componentPaths.length === 0 ? !item.path : Boolean(item.path && componentPaths.includes(item.path)),
      );
      if (componentEvidence.length === 0) {
        return;
      }

      const description = describeMechanism(locale, mechanismId);
      clusters.push({
        clusterId: `cluster:${axisId}:${mechanismId}:${index + 1}`,
        title: clusterTitle(locale, mechanismId, componentPaths, componentEvidence),
        score: clusterScore(componentEvidence),
        confidence: clusterConfidence(componentEvidence),
        axisId,
        mechanismId,
        paths: componentPaths,
        failureMechanism: description.failureMechanism,
        triggerChanges: description.triggerChanges,
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
      const description = describeMechanism(locale, 'semantic-ambiguity');
      clusters.push({
        clusterId: `cluster:semantic-ambiguity:semantic-ambiguity:${index + 1}`,
        title: clusterTitle(
          locale,
          'semantic-ambiguity',
          paths,
          evidence.filter((item) => evidenceIds.includes(item.evidenceId)),
        ),
        score: semanticClusterScore(findings),
        confidence: Math.max(...findings.map((finding) => finding.confidence)),
        axisId: 'semantic-ambiguity',
        mechanismId: 'semantic-ambiguity',
        paths,
        failureMechanism: description.failureMechanism,
        triggerChanges: description.triggerChanges,
        evidenceIds,
      });
    });

  return clusters.sort((left, right) => right.score - left.score);
}

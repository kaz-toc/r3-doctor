import type { Evidence, RiskAxisId, RiskCluster, SemanticFinding, SignalId } from '../schema/report.v1.js';
import { MECHANISM_FOR_SIGNAL } from '../schema/report.v1.js';
import { semanticRiskStrength } from '../semantic/semantic-response.js';
import { CLUSTER_PEAK_WEIGHTS, weightedPeak } from './score.js';

const AXIS_NAMES: Record<RiskAxisId, string> = {
  'structural-fragility': 'Structural Fragility',
  'change-blast-radius': 'Change Blast Radius',
  'verification-gap': 'Verification Gap',
  'change-volatility': 'Change Volatility',
  'semantic-ambiguity': 'Semantic Ambiguity',
};

const MECHANISM_LABELS: Record<string, string> = {
  'dependency-cycle': '循環依存',
  'high-connectivity': '高接続領域',
  'verification-gap': '検証ギャップ',
  volatility: '変動集中',
  'semantic-ambiguity': '意味的曖昧性',
  'large-file': '大規模ファイル',
  'barrel-export': 'barrel 再エクスポート',
  'deep-nesting': '深いネスト',
  'unresolved-import': '未解決 import',
};

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

function clusterTitle(mechanismId: string, componentPaths: string[], componentEvidence: Evidence[]): string {
  const label = MECHANISM_LABELS[mechanismId] ?? mechanismId;
  const anchor = primaryPath(componentPaths, componentEvidence);
  const pathCount = componentPaths.length;
  if (pathCount === 0) {
    return `${label}（repository-wide）`;
  }
  return `${anchor} を中心とする${label}（${pathCount} paths）`;
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

export function buildMechanismClusters(evidence: Evidence[], semanticFindings: SemanticFinding[] = []): RiskCluster[] {
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

      clusters.push({
        clusterId: `cluster:${axisId}:${mechanismId}:${index + 1}`,
        title: clusterTitle(mechanismId, componentPaths, componentEvidence),
        score: clusterScore(componentEvidence),
        confidence: clusterConfidence(componentEvidence),
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
        title: clusterTitle('semantic-ambiguity', paths, evidence.filter((item) => evidenceIds.includes(item.evidenceId))),
        score: semanticClusterScore(findings),
        confidence: Math.max(...findings.map((finding) => finding.confidence)),
        axisId: 'semantic-ambiguity',
        mechanismId: 'semantic-ambiguity',
        paths,
        failureMechanism: describeMechanism('semantic-ambiguity'),
        triggerChanges: describeTriggers('semantic-ambiguity'),
        evidenceIds,
      });
    });

  return clusters.sort((left, right) => right.score - left.score);
}

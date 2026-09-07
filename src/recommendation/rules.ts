import type { Evidence, Intervention, RiskCluster, SignalId } from '../schema/report.v1.js';
import { isNonProductPath } from '../evidence/diagnostic-paths.js';

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

type MechanismTemplate = {
  kind: Intervention['kind'];
  title: string;
  description: string;
  expectedEffect: string;
  cost: Intervention['cost'];
  buildVerification: (ctx: TemplateContext) => { verification: string; verificationHorizon: string };
  buildFirstStep: (ctx: TemplateContext) => string;
  buildRationale: (ctx: TemplateContext) => string;
};

const MECHANISM_TEMPLATES: Record<string, MechanismTemplate> = {
  'dependency-cycle': {
    kind: 'structure',
    title: '循環依存を解消する',
    description: '依存方向を一方向に整理し、共有契約を境界モジュールへ移す。',
    expectedEffect: 'structural-fragility と change-blast-radius の低下',
    cost: 'medium',
    buildRationale: ({ cluster, primaryPath, strongestMetric }) =>
      `${cluster.mechanismId} が ${primaryPath} 周辺で cluster score ${cluster.score} を形成している（${strongestMetric}）。`,
    buildFirstStep: ({ primaryPath, strongestMetric }) =>
      `${primaryPath} の ${strongestMetric} を起点に循環を断ち、共有契約を境界モジュールへ移す。`,
    buildVerification: ({ primaryPath, cluster }) => ({
      verification: `${primaryPath} 周辺の targeted test を実行し、r3-doctor scan で ${cluster.mechanismId} linked signal が減ることを確認する。`,
      verificationHorizon: '次回 scan で linked cluster score が低下していること。',
    }),
  },
  'high-connectivity': {
    kind: 'structure',
    title: '共有モジュールの表面積を縮小する',
    description: '公開 API を狭め、内部実装を隠蔽するファサードを導入する。',
    expectedEffect: 'change-blast-radius の低下',
    cost: 'high',
    buildRationale: ({ cluster, primaryPath, strongestMetric }) =>
      `${cluster.mechanismId} が ${primaryPath} を hub として cluster score ${cluster.score} を押し上げている（${strongestMetric}）。`,
    buildFirstStep: ({ primaryPath, strongestMetric }) =>
      `${primaryPath} の ${strongestMetric} を確認し、公開 API を最小集合へ絞る。`,
    buildVerification: ({ primaryPath, cluster }) => ({
      verification: `${primaryPath} の contract/regression test を追加し、fan-in/fan-out metric の再診断を行う。`,
      verificationHorizon: '次回 scan で linked cluster score と connectivity metric が低下していること。',
    }),
  },
  'verification-gap': {
    kind: 'test',
    title: '変更前に境界テストを追加する',
    description: '高 fan-in モジュールまたは共有契約に対し、回帰を検出するテストを先に追加する。',
    expectedEffect: 'verification-gap の低下',
    cost: 'low',
    buildRationale: ({ cluster, primaryPath, strongestMetric }) =>
      `${cluster.mechanismId} が ${primaryPath} で cluster score ${cluster.score} を形成している（${strongestMetric}）。`,
    buildFirstStep: ({ primaryPath, strongestMetric }) =>
      `${primaryPath} の ${strongestMetric} をカバーする境界テストを先に追加する。`,
    buildVerification: ({ primaryPath, cluster }) => ({
      verification: `${primaryPath} 向け test command を CI に追加し、missing-test-pair linked signal の解消を確認する。`,
      verificationHorizon: '次回 scan で linked cluster score が低下していること。',
    }),
  },
  volatility: {
    kind: 'process',
    title: '高 churn 領域の変更手順を固定する',
    description: '頻繁に壊れる領域に対し、変更チェックリストと小さな PR 単位を強制する。',
    expectedEffect: 'change-volatility の安定化',
    cost: 'low',
    buildRationale: ({ cluster, primaryPath, strongestMetric }) =>
      `${cluster.mechanismId} が ${primaryPath} に変更集中している（cluster score ${cluster.score}, ${strongestMetric}）。`,
    buildFirstStep: ({ primaryPath, strongestMetric }) =>
      `${primaryPath} の ${strongestMetric} を hotspot として regression test と ownership/checklist を整備する。`,
    buildVerification: ({ primaryPath }) => ({
      verification: `${primaryPath} の regression test と change checklist/ownership が存在することを確認する。`,
      verificationHorizon: 'churnDays 経過後の trend で git-churn linked signal/cluster が減少していること。',
    }),
  },
  'large-file': {
    kind: 'structure',
    title: '責務ごとにモジュールを分割する',
    description: '単一ファイルへの責務集中を解消し、変更単位を小さくする。',
    expectedEffect: 'structural-fragility の低下',
    cost: 'medium',
    buildRationale: ({ cluster, primaryPath, strongestMetric }) =>
      `${cluster.mechanismId} が ${primaryPath} で cluster score ${cluster.score} を形成している（${strongestMetric}）。`,
    buildFirstStep: ({ primaryPath, strongestMetric }) =>
      `${primaryPath} の ${strongestMetric} を確認し、責務単位でファイルを分割する。`,
    buildVerification: ({ primaryPath, cluster }) => ({
      verification: `${primaryPath} の split 後 test command を実行し、large-file linked signal の解消を確認する。`,
      verificationHorizon: '次回 scan で linked cluster score が低下していること。',
    }),
  },
  'barrel-export': {
    kind: 'structure',
    title: 'barrel 再エクスポートを具体 import に置き換える',
    description: 'barrel 再エクスポートをやめ、依存境界を明示する。',
    expectedEffect: 'structural-fragility の低下',
    cost: 'medium',
    buildRationale: ({ cluster, primaryPath, strongestMetric }) =>
      `${cluster.mechanismId} が ${primaryPath} で cluster score ${cluster.score} を形成している（${strongestMetric}）。`,
    buildFirstStep: ({ primaryPath, strongestMetric }) =>
      `${primaryPath} の ${strongestMetric} を確認し、export * を具体 import へ置き換える。`,
    buildVerification: ({ primaryPath, cluster }) => ({
      verification: `${primaryPath} 周辺 test command を実行し、barrel-reexport linked signal の解消を確認する。`,
      verificationHorizon: '次回 scan で linked cluster score が低下していること。',
    }),
  },
  'deep-nesting': {
    kind: 'structure',
    title: '深いネストを関数分割で解消する',
    description: '深いネストを小さな関数へ分割し、変更単位を局所化する。',
    expectedEffect: 'structural-fragility の低下',
    cost: 'medium',
    buildRationale: ({ cluster, primaryPath, strongestMetric }) =>
      `${cluster.mechanismId} が ${primaryPath} で cluster score ${cluster.score} を形成している（${strongestMetric}）。`,
    buildFirstStep: ({ primaryPath, strongestMetric }) =>
      `${primaryPath} の ${strongestMetric} を確認し、深い分岐を関数へ抽出する。`,
    buildVerification: ({ primaryPath, cluster }) => ({
      verification: `${primaryPath} の refactor 後 test command を実行し、deep-nesting linked signal の解消を確認する。`,
      verificationHorizon: '次回 scan で linked cluster score が低下していること。',
    }),
  },
  'unresolved-import': {
    kind: 'structure',
    title: '未解決 import を修正する',
    description: '未解決 import を修正し、依存グラフを健全化する。',
    expectedEffect: 'structural-fragility の低下',
    cost: 'high',
    buildRationale: ({ cluster, primaryPath, strongestMetric }) =>
      `${cluster.mechanismId} が ${primaryPath} で cluster score ${cluster.score} を形成している（${strongestMetric}）。`,
    buildFirstStep: ({ primaryPath, strongestMetric }) =>
      `${primaryPath} の ${strongestMetric} を確認し、未解決 import を修正する。`,
    buildVerification: ({ primaryPath, cluster }) => ({
      verification: `${primaryPath} 周辺 build/test command を実行し、unresolved-import linked signal の解消を確認する。`,
      verificationHorizon: '次回 scan で linked cluster score が低下していること。',
    }),
  },
  'semantic-ambiguity': {
    kind: 'process',
    title: '暗黙契約を decision record または contract test で固定する',
    description: '命名や例外分岐の暗黙契約を ADR または contract test で可視化する。',
    expectedEffect: 'semantic-ambiguity の低下',
    cost: 'medium',
    buildRationale: ({ cluster, primaryPath, strongestMetric }) =>
      `${cluster.mechanismId} が ${primaryPath} 周辺で cluster score ${cluster.score} を形成している（${strongestMetric}）。`,
    buildFirstStep: ({ primaryPath, strongestMetric }) =>
      `${primaryPath} の ${strongestMetric} を題材に contract test または decision record を追加する。`,
    buildVerification: ({ primaryPath, cluster }) => ({
      verification: `${primaryPath} 向け contract test または ADR を追加し、semantic scan を再実行する。`,
      verificationHorizon: '次回 semantic scan で linked cluster score が低下していること。',
    }),
  },
};

const DEFAULT_TEMPLATE: MechanismTemplate = {
  kind: 'structure',
  title: '関連リスクを解消する',
  description: 'cluster に関連する構造上の弱点を解消する。',
  expectedEffect: 'linked cluster score の低下',
  cost: 'medium',
  buildRationale: ({ cluster, primaryPath, strongestMetric }) =>
    `${cluster.mechanismId} が ${primaryPath} 周辺で cluster score ${cluster.score} を形成している（${strongestMetric}）。`,
  buildFirstStep: ({ primaryPath, strongestMetric }) =>
    `${primaryPath} の ${strongestMetric} を確認し、linked cluster の根本原因を解消する。`,
  buildVerification: ({ primaryPath, cluster }) => ({
    verification: `${primaryPath} 向け test command を実行し、linked signal/cluster の減少を確認する。`,
    verificationHorizon: '次回 scan で linked cluster score が低下していること。',
  }),
};

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

function templateForMechanism(mechanismId: string): MechanismTemplate {
  return MECHANISM_TEMPLATES[mechanismId] ?? DEFAULT_TEMPLATE;
}

function applyChurnHorizon(verificationHorizon: string, churnDays: number, mechanismId: string): string {
  if (mechanismId !== 'volatility') {
    return verificationHorizon;
  }
  return verificationHorizon.replace('churnDays', String(churnDays));
}

export function buildInterventions(
  evidence: Evidence[],
  clusters: RiskCluster[],
  diagnosticSkipRoots: string[] = [],
  evidenceConfidence = 1,
  churnDays = 90,
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
    const template = templateForMechanism(cluster.mechanismId);
    const context: TemplateContext = {
      cluster,
      primaryPath: anchorPath,
      strongestMetric: metricLabel,
      targetPaths,
      linkedSignalIds,
      churnDays,
    };
    const { verification, verificationHorizon } = template.buildVerification(context);

    interventions.push({
      interventionId: `intervention:${cluster.clusterId}`,
      priority: 0,
      title: template.title,
      description: template.description,
      kind: template.kind,
      targetPaths,
      linkedSignalIds,
      linkedClusterIds: [cluster.clusterId],
      expectedEffect: template.expectedEffect,
      verification,
      cost: template.cost,
      rationale: template.buildRationale(context),
      firstStep: template.buildFirstStep(context),
      priorityScore: computePriorityScore(
        cluster.score,
        evidenceConfidence,
        targetPaths.length,
        template.cost,
      ),
      verificationHorizon: applyChurnHorizon(verificationHorizon, churnDays, cluster.mechanismId),
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

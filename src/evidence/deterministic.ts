import path from 'node:path';
import ts from 'typescript';

import type { Evidence, RiskAxisId, SignalId } from '../schema/report.v1.js';
import type { RepositorySnapshot, SourceFile } from '../intake/snapshot.js';
import { isNonProductPath, isTestFile } from './diagnostic-paths.js';
import { DefaultGitProvider } from '../adapters/git-provider.js';

export type ImportEdge = {
  from: string;
  to: string;
  kind: 'relative' | 'package';
};

function extractImports(file: SourceFile): string[] {
  const targets: string[] = [];
  const scriptKindByExtension: Record<string, ts.ScriptKind> = {
    '.ts': ts.ScriptKind.TS,
    '.tsx': ts.ScriptKind.TSX,
    '.js': ts.ScriptKind.JS,
    '.jsx': ts.ScriptKind.JSX,
    '.mjs': ts.ScriptKind.JS,
    '.cjs': ts.ScriptKind.JS,
  };
  const sourceFile = ts.createSourceFile(
    file.relativePath,
    file.content ?? '',
    ts.ScriptTarget.Latest,
    true,
    scriptKindByExtension[file.extension] ?? ts.ScriptKind.Unknown,
  );

  const addStringLiteral = (node: ts.Expression | undefined): void => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      targets.push(node.text);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addStringLiteral(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addStringLiteral(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        addStringLiteral(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return targets;
}

function resolveRelativeImport(fromFile: SourceFile, target: string, availablePaths: Set<string>): string | null {
  if (!target.startsWith('.')) {
    return null;
  }
  const base = path.posix.dirname(fromFile.relativePath.replaceAll('\\', '/'));
  const joined = path.posix.normalize(path.posix.join(base, target.replaceAll('\\', '/')));
  const withoutExtension = joined.replace(/\.(mjs|cjs|tsx?|jsx?)$/, '');
  const extensions = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'];
  const candidates = [
    joined,
    withoutExtension,
    ...extensions.map((extension) => `${withoutExtension}.${extension}`),
    ...extensions.map((extension) => `${withoutExtension}/index.${extension}`),
  ];

  for (const candidate of candidates) {
    if (availablePaths.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function buildImportGraph(snapshot: RepositorySnapshot, virtualPaths: readonly string[] = []): ImportEdge[] {
  const availablePaths = new Set([
    ...snapshot.files.map((file) => file.relativePath.replaceAll('\\', '/')),
    ...virtualPaths.map((filePath) => filePath.replaceAll('\\', '/')),
  ]);
  const edges: ImportEdge[] = [];

  for (const file of snapshot.files) {
    for (const target of extractImports(file)) {
      if (target.startsWith('.')) {
        const resolved = resolveRelativeImport(file, target, availablePaths);
        if (resolved) {
          edges.push({ from: file.relativePath, to: resolved, kind: 'relative' });
        } else {
          edges.push({ from: file.relativePath, to: target, kind: 'relative' });
        }
      } else {
        edges.push({ from: file.relativePath, to: target, kind: 'package' });
      }
    }
  }

  return edges.sort((a, b) => `${a.from}->${a.to}`.localeCompare(`${b.from}->${b.to}`));
}

export function findImportCycles(edges: ImportEdge[]): string[][] {
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'relative') {
      continue;
    }
    const list = graph.get(edge.from) ?? [];
    list.push(edge.to);
    graph.set(edge.from, list);
  }

  const cycles: string[][] = [];

  function dfs(node: string, visiting: Set<string>, stack: string[]): void {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      if (start >= 0) {
        cycles.push([...stack.slice(start), node]);
      }
      return;
    }
    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      dfs(next, visiting, stack);
    }
    stack.pop();
    visiting.delete(node);
  }

  for (const node of [...graph.keys()].sort()) {
    dfs(node, new Set(), []);
  }

  const uniqueCycles = [...new Map(cycles.map((cycle) => {
    const key = [...new Set(cycle)].sort().join('->');
    return [key, [...new Set(cycle)].sort()] as const;
  })).values()];

  return uniqueCycles;
}

export function buildTestCoverageIndex(snapshot: RepositorySnapshot, edges: ImportEdge[]): Set<string> {
  const filesByPath = new Map(snapshot.files.map((file) => [file.relativePath, file]));
  const covered = new Set<string>();

  for (const file of snapshot.files) {
    if (!isTestFile(file.relativePath)) {
      continue;
    }
    for (const edge of edges) {
      if (edge.from !== file.relativePath || edge.kind !== 'relative') {
        continue;
      }
      if (filesByPath.has(edge.to) && !isTestFile(edge.to)) {
        covered.add(edge.to);
      }
    }
  }

  return covered;
}

function expectedTestPath(sourcePath: string): string | null {
  const dir = path.dirname(sourcePath);
  const base = path.basename(sourcePath).replace(/\.(tsx?|jsx?|mjs|cjs)$/, '');
  if (base.includes('.test') || base.includes('.spec')) {
    return null;
  }
  return path.join(dir, '__tests__', `${base}.test.ts`);
}

function maxBraceDepth(content: string): number {
  let depth = 0;
  let max = 0;
  for (const char of content) {
    if (char === '{') {
      depth += 1;
      max = Math.max(max, depth);
    } else if (char === '}') {
      depth = Math.max(0, depth - 1);
    }
  }
  return max;
}

function makeEvidence(
  signalId: SignalId,
  axisId: RiskAxisId,
  severity: Evidence['severity'],
  message: string,
  filePath?: string,
  metrics?: Evidence['metrics'],
): Evidence {
  const target = metrics && 'target' in metrics && typeof metrics.target === 'string' ? metrics.target : undefined;
  const evidenceKey =
    signalId === 'unresolved-import' && filePath && target
      ? `${filePath}:${target}`
      : (filePath ?? 'repo');
  return {
    evidenceId: `evidence:${signalId}:${evidenceKey}`,
    signalId,
    axisId,
    path: filePath,
    severity,
    message,
    metrics,
    source: 'deterministic',
  };
}

export async function extractDeterministicEvidence(snapshot: RepositorySnapshot): Promise<Evidence[]> {
  const evidence: Evidence[] = [];
  const edges = buildImportGraph(snapshot);
  const filesByPath = new Map(snapshot.files.map((file) => [file.relativePath, file]));
  const testCoverage = buildTestCoverageIndex(snapshot, edges);
  const skipRoots = snapshot.config.diagnosticSkipRoots;
  const fanOut = new Map<string, number>();
  const fanIn = new Map<string, number>();

  for (const edge of edges) {
    if (edge.kind === 'relative') {
      fanOut.set(edge.from, (fanOut.get(edge.from) ?? 0) + 1);
      if (filesByPath.has(edge.to)) {
        fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1);
      } else if (edge.to.startsWith('.') && !isTestFile(edge.from) && !isNonProductPath(edge.from, skipRoots)) {
        evidence.push(
          makeEvidence(
            'unresolved-import',
            'structural-fragility',
            'medium',
            `解決不能な相対 import: ${edge.to}`,
            edge.from,
            { target: edge.to },
          ),
        );
      }
    }
  }

  for (const [filePath, count] of fanOut.entries()) {
    if (isNonProductPath(filePath, skipRoots)) {
      continue;
    }
    if (count >= snapshot.config.fanOutThreshold) {
      evidence.push(
        makeEvidence(
          'high-fan-out',
          'change-blast-radius',
          count >= snapshot.config.fanOutThreshold * 2 ? 'high' : 'medium',
          `fan-out が高い (${count})`,
          filePath,
          { fanOut: count },
        ),
      );
    }
  }

  for (const [filePath, count] of fanIn.entries()) {
    if (isNonProductPath(filePath, skipRoots)) {
      continue;
    }
    if (count >= snapshot.config.fanInThreshold) {
      evidence.push(
        makeEvidence(
          'high-fan-in',
          'change-blast-radius',
          count >= snapshot.config.fanInThreshold * 2 ? 'high' : 'medium',
          `fan-in が高い (${count})`,
          filePath,
          { fanIn: count },
        ),
      );
    }
  }

  for (const cycle of findImportCycles(edges)) {
    const unique = [...new Set(cycle)].sort();
    if (!unique.some((filePath) => !isNonProductPath(filePath, skipRoots))) {
      continue;
    }
    const primaryPath = unique.find((filePath) => !isNonProductPath(filePath, skipRoots)) ?? unique[0];
    evidence.push({
      evidenceId: `evidence:dep-cycle:${unique.join('->')}`,
      signalId: 'dep-cycle',
      axisId: 'structural-fragility',
      path: primaryPath,
      severity: 'high',
      message: `循環依存: ${unique.join(' -> ')}`,
      metrics: { cycle: unique.join('->') },
      source: 'deterministic',
    });
  }

  for (const file of snapshot.files) {
    if (isNonProductPath(file.relativePath, skipRoots) || isTestFile(file.relativePath)) {
      continue;
    }

    if (file.nonBlankLines > snapshot.config.maxFileLines) {
      evidence.push(
        makeEvidence(
          'large-file',
          'structural-fragility',
          'medium',
          `大規模ファイル (${file.nonBlankLines} 行)`,
          file.relativePath,
          { lines: file.nonBlankLines },
        ),
      );
    }

    if (file.content.includes('export * from')) {
      evidence.push(
        makeEvidence(
          'barrel-reexport',
          'structural-fragility',
          'low',
          'barrel 再エクスポートを検出',
          file.relativePath,
        ),
      );
    }

    const depth = maxBraceDepth(file.content);
    if (depth >= 6) {
      evidence.push(
        makeEvidence(
          'deep-nesting',
          'structural-fragility',
          'medium',
          `深いネスト (深度 ${depth})`,
          file.relativePath,
          { depth },
        ),
      );
    }

    const expectedTest = expectedTestPath(file.relativePath);
    const hasColocatedTest = expectedTest ? filesByPath.has(expectedTest) : false;
    const hasImportCoverage = testCoverage.has(file.relativePath);
    if (expectedTest && !hasColocatedTest && !hasImportCoverage) {
      evidence.push(
        makeEvidence(
          'missing-test-pair',
          'verification-gap',
          'medium',
          `対応テストが見つからない (期待: ${expectedTest})`,
          file.relativePath,
          { expectedTest },
        ),
      );
    }
  }

  if (snapshot.gitAvailable) {
    const churn = await collectGitChurn(snapshot);
    for (const [filePath, count] of churn.entries()) {
      if (isNonProductPath(filePath, skipRoots)) {
        continue;
      }
      if (count >= 5) {
        evidence.push(
          makeEvidence(
            'git-churn',
            'change-volatility',
            count >= 10 ? 'high' : 'medium',
            `直近 ${snapshot.config.churnDays} 日で ${count} 回変更`,
            filePath,
            { churn: count, days: snapshot.config.churnDays },
          ),
        );
      }
    }
  }

  return evidence.sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
}

async function collectGitChurn(snapshot: RepositorySnapshot): Promise<Map<string, number>> {
  const analyzedPaths = new Set(snapshot.files.map((file) => file.relativePath.replace(/\\/g, '/')));
  const rawCounts = await new DefaultGitProvider().collectFileChurn(
    snapshot.repositoryPath,
    snapshot.config.churnDays,
  );
  const counts = new Map<string, number>();
  for (const [filePath, count] of rawCounts) {
    const normalized = filePath.replace(/\\/g, '/');
    if (!filePath.includes(' ') && analyzedPaths.has(normalized)) {
      counts.set(filePath, count);
    }
  }
  return counts;
}

import path from 'node:path';
import ts from 'typescript';

import type { Evidence, RiskAxisId, SignalId } from '../schema/report.v1.js';
import type { RepositorySnapshot, SourceFile } from '../intake/snapshot.js';
import type { ReportLocale } from '../i18n/locale.js';
import { DEFAULT_LOCALE } from '../i18n/locale.js';
import { t } from '../i18n/messages.js';
import { isNonProductPath, isTestFile } from './diagnostic-paths.js';
import { classifyPathRole } from './path-role.js';
import {
  BINARY_SIGNAL_STRENGTH,
  buildBinaryRationale,
  buildNumericRationale,
  normalizeAboveThreshold,
  severityForStrength,
} from './strength.js';
import { DefaultGitProvider } from '../adapters/git-provider.js';

export type ImportEdge = {
  from: string;
  to: string;
  kind: 'relative' | 'package';
};

type TestCoverage = {
  coverageKind: 'direct' | 'transitive';
  testPaths: string[];
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

function buildRelatedPathsIndex(edges: ImportEdge[], availablePaths: Set<string>): Map<string, string[]> {
  const imports = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();

  for (const edge of edges) {
    if (edge.kind !== 'relative') {
      continue;
    }
    if (!availablePaths.has(edge.from) || !availablePaths.has(edge.to)) {
      continue;
    }
    const importSet = imports.get(edge.from) ?? new Set<string>();
    importSet.add(edge.to);
    imports.set(edge.from, importSet);

    const dependentSet = dependents.get(edge.to) ?? new Set<string>();
    dependentSet.add(edge.from);
    dependents.set(edge.to, dependentSet);
  }

  const related = new Map<string, string[]>();
  for (const filePath of availablePaths) {
    const neighbors = new Set<string>();
    for (const imported of imports.get(filePath) ?? []) {
      neighbors.add(imported);
    }
    for (const dependent of dependents.get(filePath) ?? []) {
      neighbors.add(dependent);
    }
    related.set(filePath, [...neighbors].sort());
  }
  return related;
}

function buildTestCoverageIndex(
  snapshot: RepositorySnapshot,
  edges: ImportEdge[],
): Map<string, TestCoverage> {
  const filesByPath = new Map(snapshot.files.map((file) => [file.relativePath, file]));
  const importsFrom = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'relative' || !filesByPath.has(edge.to)) {
      continue;
    }
    const list = importsFrom.get(edge.from) ?? [];
    list.push(edge.to);
    importsFrom.set(edge.from, list);
  }

  const coverage = new Map<string, { coverageKind: 'direct' | 'transitive'; testPaths: Set<string> }>();

  for (const file of snapshot.files) {
    if (!isTestFile(file.relativePath)) {
      continue;
    }

    const queue: Array<{ path: string; hops: number }> = [{ path: file.relativePath, hops: 0 }];
    const visited = new Set<string>([file.relativePath]);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }

      for (const next of importsFrom.get(current.path) ?? []) {
        if (visited.has(next)) {
          continue;
        }
        visited.add(next);

        if (isTestFile(next)) {
          queue.push({ path: next, hops: current.hops + 1 });
          continue;
        }
        if (!filesByPath.has(next) || isNonProductPath(next, snapshot.config.diagnosticSkipRoots)) {
          continue;
        }

        const kind = current.hops + 1 === 1 ? 'direct' : 'transitive';
        const existing = coverage.get(next) ?? { coverageKind: kind, testPaths: new Set<string>() };
        if (existing.coverageKind === 'direct' || kind === 'direct') {
          existing.coverageKind = 'direct';
        }
        existing.testPaths.add(file.relativePath);
        coverage.set(next, existing);
        queue.push({ path: next, hops: current.hops + 1 });
      }
    }
  }

  return new Map(
    [...coverage.entries()].map(([filePath, entry]) => [
      filePath,
      {
        coverageKind: entry.coverageKind,
        testPaths: [...entry.testPaths].sort(),
      },
    ]),
  );
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

type EvidenceDetails = {
  strength: number;
  rationale: string;
  pathRole: Evidence['pathRole'];
  relatedPaths: string[];
  severity: Evidence['severity'];
};

function buildEvidenceDetails(
  snapshot: RepositorySnapshot,
  filePath: string | undefined,
  relatedPathsIndex: Map<string, string[]>,
  testCoverage: Map<string, TestCoverage>,
  input: { strength: number; rationale: string },
): EvidenceDetails {
  const pathRole = filePath
    ? classifyPathRole(filePath, snapshot.config.diagnosticSkipRoots)
    : 'product';
  const importNeighbors = filePath ? (relatedPathsIndex.get(filePath) ?? []) : [];
  const coverage = filePath ? testCoverage.get(filePath) : undefined;
  const relatedPaths = [...new Set([...importNeighbors, ...(coverage?.testPaths ?? [])])].sort();
  return {
    strength: input.strength,
    rationale: input.rationale,
    pathRole,
    relatedPaths,
    severity: severityForStrength(input.strength),
  };
}

function makeEvidence(
  snapshot: RepositorySnapshot,
  relatedPathsIndex: Map<string, string[]>,
  testCoverage: Map<string, TestCoverage>,
  signalId: SignalId,
  axisId: RiskAxisId,
  message: string,
  filePath?: string,
  metrics?: Evidence['metrics'],
  details?: { strength: number; rationale: string; relatedPaths?: string[] },
): Evidence {
  const target = metrics && 'target' in metrics && typeof metrics.target === 'string' ? metrics.target : undefined;
  const evidenceKey =
    signalId === 'unresolved-import' && filePath && target
      ? `${filePath}:${target}`
      : (filePath ?? 'repo');
  const built = buildEvidenceDetails(snapshot, filePath, relatedPathsIndex, testCoverage, {
    strength: details?.strength ?? 0,
    rationale: details?.rationale ?? 'formula=unknown',
  });

  return {
    evidenceId: `evidence:${signalId}:${evidenceKey}`,
    signalId,
    axisId,
    path: filePath,
    severity: built.severity,
    message,
    metrics,
    source: 'deterministic',
    strength: built.strength,
    rationale: built.rationale,
    pathRole: built.pathRole,
    relatedPaths: details?.relatedPaths ?? built.relatedPaths,
  };
}

export async function extractDeterministicEvidence(
  snapshot: RepositorySnapshot,
  locale: ReportLocale = DEFAULT_LOCALE,
): Promise<Evidence[]> {
  const evidence: Evidence[] = [];
  const edges = buildImportGraph(snapshot);
  const availablePaths = new Set(snapshot.files.map((file) => file.relativePath.replaceAll('\\', '/')));
  const relatedPathsIndex = buildRelatedPathsIndex(edges, availablePaths);
  const filesByPath = new Map(snapshot.files.map((file) => [file.relativePath, file]));
  const testCoverage = buildTestCoverageIndex(snapshot, edges);
  const skipRoots = snapshot.config.diagnosticSkipRoots;
  const fanOut = new Map<string, number>();
  const fanIn = new Map<string, number>();
  const churnOnset = 5;

  for (const edge of edges) {
    if (edge.kind === 'relative') {
      fanOut.set(edge.from, (fanOut.get(edge.from) ?? 0) + 1);
      if (filesByPath.has(edge.to)) {
        fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1);
      } else if (edge.to.startsWith('.') && !isTestFile(edge.from) && !isNonProductPath(edge.from, skipRoots)) {
        evidence.push(
          makeEvidence(
            snapshot,
            relatedPathsIndex,
            testCoverage,
            'unresolved-import',
            'structural-fragility',
            t(locale, 'evidence.unresolvedImport', { target: edge.to }),
            edge.from,
            { target: edge.to },
            {
              strength: BINARY_SIGNAL_STRENGTH['unresolved-import'],
              rationale: buildBinaryRationale('unresolved-import'),
            },
          ),
        );
      }
    }
  }

  for (const [filePath, count] of fanOut.entries()) {
    if (count >= snapshot.config.fanOutThreshold) {
      evidence.push(
        makeEvidence(
          snapshot,
          relatedPathsIndex,
          testCoverage,
          'high-fan-out',
          'change-blast-radius',
          t(locale, 'evidence.highFanOut', { count }),
          filePath,
          { fanOut: count },
          {
            strength: normalizeAboveThreshold(count, snapshot.config.fanOutThreshold),
            rationale: buildNumericRationale(count, snapshot.config.fanOutThreshold),
          },
        ),
      );
    }
  }

  for (const [filePath, count] of fanIn.entries()) {
    if (count >= snapshot.config.fanInThreshold) {
      evidence.push(
        makeEvidence(
          snapshot,
          relatedPathsIndex,
          testCoverage,
          'high-fan-in',
          'change-blast-radius',
          t(locale, 'evidence.highFanIn', { count }),
          filePath,
          { fanIn: count },
          {
            strength: normalizeAboveThreshold(count, snapshot.config.fanInThreshold),
            rationale: buildNumericRationale(count, snapshot.config.fanInThreshold),
          },
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
    const built = buildEvidenceDetails(snapshot, primaryPath, relatedPathsIndex, testCoverage, {
      strength: BINARY_SIGNAL_STRENGTH['dep-cycle'],
      rationale: buildBinaryRationale('dep-cycle'),
    });
    evidence.push({
      evidenceId: `evidence:dep-cycle:${unique.join('->')}`,
      signalId: 'dep-cycle',
      axisId: 'structural-fragility',
      path: primaryPath,
      severity: built.severity,
      message: t(locale, 'evidence.depCycle', { cycle: unique.join(' -> ') }),
      metrics: { cycle: unique.join('->') },
      source: 'deterministic',
      strength: built.strength,
      rationale: built.rationale,
      pathRole: built.pathRole,
      relatedPaths: unique,
    });
  }

  for (const file of snapshot.files) {
    if (isNonProductPath(file.relativePath, skipRoots)) {
      continue;
    }

    if (file.nonBlankLines > snapshot.config.maxFileLines) {
      evidence.push(
        makeEvidence(
          snapshot,
          relatedPathsIndex,
          testCoverage,
          'large-file',
          'structural-fragility',
          t(locale, 'evidence.largeFile', { lines: file.nonBlankLines }),
          file.relativePath,
          { lines: file.nonBlankLines },
          {
            strength: normalizeAboveThreshold(file.nonBlankLines, snapshot.config.maxFileLines),
            rationale: buildNumericRationale(file.nonBlankLines, snapshot.config.maxFileLines),
          },
        ),
      );
    }

    if (isTestFile(file.relativePath)) {
      continue;
    }

    if (file.content.includes('export * from')) {
      evidence.push(
        makeEvidence(
          snapshot,
          relatedPathsIndex,
          testCoverage,
          'barrel-reexport',
          'structural-fragility',
          t(locale, 'evidence.barrelReexport'),
          file.relativePath,
          undefined,
          {
            strength: BINARY_SIGNAL_STRENGTH['barrel-reexport'],
            rationale: buildBinaryRationale('barrel-reexport'),
          },
        ),
      );
    }

    const depth = maxBraceDepth(file.content);
    const nestingOnset = 6;
    if (depth >= nestingOnset) {
      evidence.push(
        makeEvidence(
          snapshot,
          relatedPathsIndex,
          testCoverage,
          'deep-nesting',
          'structural-fragility',
          t(locale, 'evidence.deepNesting', { depth }),
          file.relativePath,
          { depth },
          {
            strength: normalizeAboveThreshold(depth, nestingOnset),
            rationale: buildNumericRationale(depth, nestingOnset),
          },
        ),
      );
    }

    const expectedTest = expectedTestPath(file.relativePath);
    const hasColocatedTest = expectedTest ? filesByPath.has(expectedTest) : false;
    const coverage = testCoverage.get(file.relativePath);
    if (expectedTest && !hasColocatedTest && !coverage) {
      evidence.push(
        makeEvidence(
          snapshot,
          relatedPathsIndex,
          testCoverage,
          'missing-test-pair',
          'verification-gap',
          t(locale, 'evidence.missingTestPair', { expectedTest }),
          file.relativePath,
          { expectedTest, coverageKind: 'missing' },
          {
            strength: BINARY_SIGNAL_STRENGTH['missing-test-pair'],
            rationale: buildBinaryRationale('missing-test-pair'),
          },
        ),
      );
    }
  }

  if (snapshot.gitAvailable) {
    const churn = await collectGitChurn(snapshot);
    for (const [filePath, count] of churn.entries()) {
      if (count >= churnOnset) {
        evidence.push(
          makeEvidence(
            snapshot,
            relatedPathsIndex,
            testCoverage,
            'git-churn',
            'change-volatility',
            t(locale, 'evidence.gitChurn', { count, days: snapshot.config.churnDays }),
            filePath,
            { churn: count, days: snapshot.config.churnDays },
            {
              strength: normalizeAboveThreshold(count, churnOnset),
              rationale: buildNumericRationale(count, churnOnset),
            },
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

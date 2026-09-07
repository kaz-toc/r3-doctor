import { rename } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { DefaultGitProvider } from '../src/adapters/git-provider.js';
import { compareSignalChanges } from '../src/comparison/compare.js';
import { computeBlastRadius } from '../src/commands/diff.js';
import { createRepositorySnapshot } from '../src/intake/snapshot.js';
import { formatDiffConsoleReport, formatDiffMarkdownReport } from '../src/reporting/format.js';
import { diffReportSchema } from '../src/schema/report.v1.js';
import type { DiagnosisReport } from '../src/schema/report.v1.js';
import { createGitRepository } from './helpers/git-repository.js';

function minimalReport(evidenceIds: Array<{ id: string; severity: 'low' | 'medium' | 'high' }>): DiagnosisReport {
  return {
    metadata: {
      schemaVersion: 1,
      assessmentContractVersion: 3,
      generatedAt: '2026-01-01T00:00:00.000Z',
      inputId: 'test',
      repositoryPath: '/tmp',
      analyzers: [],
      truncated: false,
      unevaluatedAreas: [],
    },
    repository: {
      regressionRiskScore: 10,
      confidence: 1,
      disclaimer: 'test',
    },
    axes: [],
    clusters: [],
    evidence: evidenceIds.map((entry) => ({
      evidenceId: `evidence:dep-cycle:${entry.id}`,
      signalId: 'dep-cycle',
      axisId: 'structural-fragility',
      severity: entry.severity,
      message: entry.id,
      source: 'deterministic',
    })),
    semanticFindings: [],
    interventions: [],
    capabilities: [],
  };
}

describe('diff diagnostics', () => {
  it('classifies new, worsened, and improved signals', () => {
    const base = minimalReport([{ id: 'a', severity: 'low' }, { id: 'b', severity: 'high' }]);
    const current = minimalReport([{ id: 'a', severity: 'medium' }, { id: 'c', severity: 'low' }]);
    const changes = compareSignalChanges(current, base);
    expect(changes.newSignals.map((item) => item.evidenceId)).toContain('evidence:dep-cycle:c');
    expect(changes.worsenedSignals.map((item) => item.evidenceId)).toContain('evidence:dep-cycle:a');
    expect(changes.improvedSignals.map((item) => item.evidenceId)).toContain('evidence:dep-cycle:b');
  });

  it('computes blast radius for changed files', () => {
    const files = [
      { relativePath: 'src/a.ts', absolutePath: '', extension: '.ts', content: '', nonBlankLines: 1 },
      { relativePath: 'src/b.ts', absolutePath: '', extension: '.ts', content: "import './a.js'", nonBlankLines: 1 },
    ];
    const radius = computeBlastRadius(['src/a.ts'], '/repo', files);
    expect(radius[0]?.directDependents).toContain('src/b.ts');
    expect(radius[0]?.transitiveDependents).toContain('src/b.ts');
    expect(radius[0]?.paths.length).toBeGreaterThan(0);
  });

  it('REG-2026-004 retains incoming blast radius for a deleted TypeScript target imported through a JavaScript specifier', () => {
    const files = [
      { relativePath: 'src/b.ts', absolutePath: '', extension: '.ts', content: "import './a.js'", nonBlankLines: 1 },
    ];

    const radius = computeBlastRadius(['src/a.ts'], '/repo', files);

    expect(radius[0]?.directDependents).toEqual(['src/b.ts']);
    expect(radius[0]?.transitiveDependents).toEqual(['src/b.ts']);
  });

  it('REG-2026-004 retains both sides of a rename so dependents of the old path remain visible', async () => {
    const repo = await createGitRepository({
      'src/old.ts': 'export const value = 1;\n',
      'src/consumer.ts': "import { value } from './old.js';\nexport { value };\n",
    });
    try {
      await rename(`${repo.path}/src/old.ts`, `${repo.path}/src/new.ts`);
      await repo.commit('rename dependency without updating consumer');

      const changedFiles = await new DefaultGitProvider().listChangedFiles(repo.path, repo.headSha);
      const snapshot = await createRepositorySnapshot(repo.path);
      const radius = computeBlastRadius(changedFiles, repo.path, snapshot.files);

      expect(changedFiles).toEqual(expect.arrayContaining(['src/old.ts', 'src/new.ts']));
      expect(radius.find((entry) => entry.changedFile === 'src/old.ts')?.directDependents)
        .toEqual(['src/consumer.ts']);
    } finally {
      await repo.cleanup();
    }
  });

  it('renders blast radius and signal changes in human-readable diff output', () => {
    const base = minimalReport([]);
    const current = {
      ...minimalReport([{ id: 'a', severity: 'high' }]),
      repository: { ...minimalReport([]).repository, regressionRiskScore: 35 },
    };
    const diff = diffReportSchema.parse({
      schemaVersion: 2,
      current,
      base,
      comparison: {
        compatible: true,
        riskDelta: 25,
        baselineId: base.metadata.inputId,
        changedFiles: ['src/a.ts'],
        blastRadius: [{
          changedFile: 'src/a.ts',
          directDependents: ['src/b.ts'],
          directDependencies: ['src/c.ts'],
          transitiveDependents: ['src/b.ts'],
          transitiveDependencies: ['src/c.ts'],
          paths: [{ from: 'src/b.ts', to: 'src/a.ts' }],
        }],
        newSignals: [{
          evidenceId: 'evidence:dep-cycle:a',
          signalId: 'dep-cycle',
          path: undefined,
          currentSeverity: 'high',
          message: 'a',
        }],
        worsenedSignals: [],
        improvedSignals: [],
      },
    });

    const consoleOut = formatDiffConsoleReport(diff);
    const markdownOut = formatDiffMarkdownReport(diff);
    expect(consoleOut).toContain('Blast radius:');
    expect(consoleOut).toContain('direct dependents: src/b.ts');
    expect(consoleOut).toContain('[new] [high] dep-cycle repo: a');
    expect(markdownOut).toContain('### Blast radius');
    expect(markdownOut).toContain('Direct dependencies: src/c.ts');
    expect(markdownOut).toContain('[new]');
  });

  it('still reports changed files and blast radius when comparison is incompatible', () => {
    const diff = diffReportSchema.parse({
      schemaVersion: 2,
      current: minimalReport([{ id: 'a', severity: 'low' }]),
      comparison: {
        compatible: false,
        reason: 'assessment contract mismatch',
        changedFiles: ['src/a.ts'],
        blastRadius: [{
          changedFile: 'src/a.ts',
          directDependents: [],
          directDependencies: [],
          transitiveDependents: [],
          transitiveDependencies: [],
          paths: [],
        }],
        newSignals: [],
        worsenedSignals: [],
        improvedSignals: [],
      },
    });

    expect(formatDiffConsoleReport(diff)).toContain('changed files: src/a.ts');
    expect(formatDiffConsoleReport(diff)).toContain('Blast radius:');
    expect(formatDiffMarkdownReport(diff)).toContain('### Blast radius');
  });
});

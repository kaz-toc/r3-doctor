import { rename } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { DefaultGitProvider } from '../src/adapters/git-provider.js';
import { compareSignalChanges } from '../src/comparison/compare.js';
import { computeBlastRadius } from '../src/commands/diff.js';
import { createRepositorySnapshot } from '../src/intake/snapshot.js';
import { formatDiffConsoleReport, formatDiffMarkdownReport } from '../src/reporting/format.js';
import {
  ASSESSMENT_CONTRACT_VERSION,
  DIFF_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION,
  diffReportSchema,
  provisionalEvidenceDetails,
} from '../src/schema/report.v1.js';
import type { DiagnosisReport } from '../src/schema/report.v1.js';
import { buildDecisionReportFixture } from './fixtures/reporting/decision-report.fixture.js';
import { createGitRepository } from './helpers/git-repository.js';

function minimalRepository(overrides: Partial<DiagnosisReport['repository']> = {}): DiagnosisReport['repository'] {
  return {
    regressionRiskScore: 10,
    confidence: 1,
    disclaimer: 'test',
    scoreBreakdown: { axisBase: 10, criticalClusterUplift: 0 },
    confidenceBreakdown: {
      signalCoverage: 1,
      semanticAnalysis: 0,
      gitHistory: 1,
      inputCompleteness: 1,
    },
    calibration: { status: 'uncalibrated' },
    ...overrides,
  };
}

function minimalReport(evidenceIds: Array<{ id: string; severity: 'low' | 'medium' | 'high' }>): DiagnosisReport {
  return {
    metadata: {
      schemaVersion: REPORT_SCHEMA_VERSION,
      assessmentContractVersion: ASSESSMENT_CONTRACT_VERSION,
      generatedAt: '2026-01-01T00:00:00.000Z',
      inputId: 'test',
      repositoryPath: '/tmp',
      analyzers: [],
      truncated: false,
      unevaluatedAreas: [],
    },
    repository: minimalRepository(),
    axes: [],
    clusters: [],
    evidence: evidenceIds.map((entry) => ({
      evidenceId: `evidence:dep-cycle:${entry.id}`,
      signalId: 'dep-cycle',
      axisId: 'structural-fragility',
      severity: entry.severity,
      message: entry.id,
      source: 'deterministic',
      ...provisionalEvidenceDetails(entry.severity, entry.id),
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
      schemaVersion: DIFF_SCHEMA_VERSION,
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

  it('renders diff all as diagnosis, improvement, and current-state chapters', () => {
    const base = minimalReport([]);
    const current = minimalReport([{ id: 'a', severity: 'high' }]);
    const diff = diffReportSchema.parse({
      schemaVersion: DIFF_SCHEMA_VERSION,
      current,
      base,
      comparison: {
        compatible: true,
        riskDelta: 0,
        baselineId: base.metadata.inputId,
        changedFiles: ['src/a.ts'],
        blastRadius: [],
        ...compareSignalChanges(current, base),
      },
    });

    const markdown = formatDiffMarkdownReport(diff, { view: 'all' });
    const consoleOut = formatDiffConsoleReport(diff, { view: 'all' });

    expect(markdown.match(/^## (Diagnosis summary|Improvement points|Current state)$/gm))
      .toEqual(['## Diagnosis summary', '## Improvement points', '## Current state']);
    expect(consoleOut.match(/^(Diagnosis summary|Improvement points|Current state)$/gm))
      .toEqual(['Diagnosis summary', 'Improvement points', 'Current state']);
  });

  it('selects changed-risk actions before applying the action view limit', () => {
    const current = buildDecisionReportFixture();
    const base = structuredClone(current);
    base.metadata.inputId = 'decision-report-baseline';
    const changedEvidenceId = current.clusters[5]!.evidenceIds[0]!;
    const baseEvidence = base.evidence.find((item) => item.evidenceId === changedEvidenceId)!;
    baseEvidence.strength = 25;
    baseEvidence.severity = 'low';
    const changes = compareSignalChanges(current, base);
    const diff = diffReportSchema.parse({
      schemaVersion: DIFF_SCHEMA_VERSION,
      current,
      base,
      comparison: {
        compatible: true,
        riskDelta: 0,
        baselineId: base.metadata.inputId,
        changedFiles: [current.clusters[5]!.paths[0]!],
        blastRadius: [],
        ...changes,
      },
    });

    const markdown = formatDiffMarkdownReport(diff, { view: 'actions' });

    expect(changes.worsenedSignals.map((item) => item.evidenceId)).toEqual([changedEvidenceId]);
    expect(markdown).toContain('### 6. Break cycle 6');
    expect(markdown).not.toContain('(none linked to changed risk)');
  });

  it('keeps directly changed actions when the baseline is incompatible', () => {
    const current = buildDecisionReportFixture();
    const directTarget = current.interventions[0]!.targetPaths[0]!;
    const diff = diffReportSchema.parse({
      schemaVersion: DIFF_SCHEMA_VERSION,
      current,
      comparison: {
        compatible: false,
        reason: 'assessment contract mismatch',
        changedFiles: [directTarget],
        blastRadius: [],
        newSignals: [],
        worsenedSignals: [],
        improvedSignals: [],
      },
    });

    const markdown = formatDiffMarkdownReport(diff, { view: 'actions' });
    const consoleOut = formatDiffConsoleReport(diff, { view: 'actions' });

    expect(markdown).toContain('### 1. Break cycle 1');
    expect(markdown).toContain('PR relevance: direct-change');
    expect(consoleOut).toContain('PR relevance: direct-change');
  });

  it('keeps actions reached only through the changed-file blast radius', () => {
    const current = buildDecisionReportFixture();
    const blastTarget = current.interventions[1]!.targetPaths[0]!;
    const diff = diffReportSchema.parse({
      schemaVersion: DIFF_SCHEMA_VERSION,
      current,
      comparison: {
        compatible: false,
        reason: 'stored baseline not found',
        changedFiles: ['src/changed.ts'],
        blastRadius: [{
          changedFile: 'src/changed.ts',
          directDependents: [blastTarget],
          directDependencies: [],
          transitiveDependents: [blastTarget],
          transitiveDependencies: [],
          paths: [{ from: blastTarget, to: 'src/changed.ts' }],
        }],
        newSignals: [],
        worsenedSignals: [],
        improvedSignals: [],
      },
    });

    const markdown = formatDiffMarkdownReport(diff, { view: 'actions' });

    expect(markdown).toContain('### 2. Break cycle 2');
    expect(markdown).toContain('PR relevance: blast-radius');
  });

  it('orders new or worsened actions before directly changed actions', () => {
    const current = buildDecisionReportFixture();
    const base = structuredClone(current);
    base.metadata.inputId = 'decision-report-baseline';
    const worsenedEvidenceId = current.clusters[5]!.evidenceIds[0]!;
    const baseEvidence = base.evidence.find((item) => item.evidenceId === worsenedEvidenceId)!;
    baseEvidence.strength = 25;
    baseEvidence.severity = 'low';
    const diff = diffReportSchema.parse({
      schemaVersion: DIFF_SCHEMA_VERSION,
      current,
      base,
      comparison: {
        compatible: true,
        riskDelta: 0,
        baselineId: base.metadata.inputId,
        changedFiles: [current.interventions[0]!.targetPaths[0]!],
        blastRadius: [],
        ...compareSignalChanges(current, base),
      },
    });

    const markdown = formatDiffMarkdownReport(diff, { view: 'actions' });

    expect(markdown.indexOf('### 6. Break cycle 6')).toBeLessThan(markdown.indexOf('### 1. Break cycle 1'));
    expect(markdown).toContain('PR relevance: new-or-worsened');
    expect(markdown).toContain('PR relevance: direct-change');
  });

  it('still reports changed files and blast radius when comparison is incompatible', () => {
    const diff = diffReportSchema.parse({
      schemaVersion: DIFF_SCHEMA_VERSION,
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

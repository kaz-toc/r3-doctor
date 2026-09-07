import { describe, expect, it } from 'vitest';

import { buildMechanismClusters } from '../src/assessment/clusters.js';
import { assessRisk } from '../src/assessment/risk.js';
import { scoreAxis } from '../src/assessment/score.js';
import {
  buildNumericRationale,
  normalizeAboveThreshold,
  severityForStrength,
} from '../src/evidence/strength.js';
import { formatConsoleReport, formatMarkdownReport } from '../src/reporting/format.js';
import { diagnosisReportSchema, provisionalEvidenceDetails } from '../src/schema/report.v1.js';
import type { Evidence } from '../src/schema/report.v1.js';
import { TypeScriptAnalyzerPlugin, negotiateCapabilities } from '../src/plugins/analyzer.js';

const baseSnapshot = {
  repositoryPath: '/tmp/repo',
  inputId: 'abc',
  files: [],
  gitAvailable: true,
  truncated: false,
  intakeIssues: [],
  config: { schemaVersion: 1, llm: { enabled: false, provider: 'none', maxFiles: 20, sendScope: 'cluster-context' } },
} as const;

const fullCapabilities = [{
  language: 'typescript-javascript' as const,
  contractVersion: 3,
  completeness: 'full' as const,
  supportedSignals: ['dep-cycle', 'large-file', 'git-churn', 'missing-test-pair', 'barrel-reexport'],
  unevaluatedSignals: [],
  analyzerId: 'typescript-javascript-v1',
  analyzerImplementationVersion: '1.0.0',
}];

function evidence(
  overrides: Partial<Evidence> & Pick<Evidence, 'evidenceId' | 'signalId' | 'axisId' | 'severity' | 'message'>,
): Evidence {
  const details = provisionalEvidenceDetails(overrides.severity, overrides.path);
  return {
    ...details,
    source: 'deterministic',
    ...overrides,
    strength: overrides.strength ?? details.strength,
    severity: overrides.severity,
  };
}

function caseWithChurn(churn: number) {
  const strength = normalizeAboveThreshold(churn, 5);
  return {
    axisId: 'change-volatility' as const,
    evidence: [evidence({
      evidenceId: 'evidence:git-churn:src/a.ts',
      signalId: 'git-churn',
      axisId: 'change-volatility',
      path: 'src/a.ts',
      strength,
      rationale: buildNumericRationale(churn, 5),
      severity: severityForStrength(strength),
      message: `churn ${churn}`,
    })],
    semanticFindings: [],
    productPathCount: 1,
    evaluableMechanismIds: ['volatility'],
  };
}

describe('continuous axis scoring', () => {
  it('distinguishes churn tiers monotonically', () => {
    const churn6 = scoreAxis(caseWithChurn(6)).score;
    const churn10 = scoreAxis(caseWithChurn(10)).score;
    const churn15 = scoreAxis(caseWithChurn(15)).score;

    expect(churn6).toBeLessThan(churn10);
    expect(churn10).toBeLessThan(churn15);
    expect(new Set([churn6, churn10, churn15]).size).toBeGreaterThanOrEqual(3);
  });

  it('keeps repository breakdown aligned with regression risk score', () => {
    const report = assessRisk({
      snapshot: {
        ...baseSnapshot,
        files: [{ relativePath: 'src/a.ts', absolutePath: '/tmp/repo/src/a.ts', extension: '.ts', content: '', contentHash: 'a', nonBlankLines: 1 }],
      } as never,
      evidence: [caseWithChurn(10).evidence[0]!],
      semanticFindings: [],
      capabilities: fullCapabilities,
      analyzers: ['typescript-javascript-v1'],
      selectedAnalyzers: 1,
      successfulAnalyzers: 1,
      semanticResolution: { status: 'unavailable', reason: 'LLM not configured' },
    });

    expect(
      report.repository.scoreBreakdown.axisBase + report.repository.scoreBreakdown.criticalClusterUplift,
    ).toBeCloseTo(report.repository.regressionRiskScore, 0);
    expect(
      report.axes.reduce((sum, axis) => sum + axis.contributionPoints, 0),
    ).toBeCloseTo(report.repository.scoreBreakdown.axisBase, 1);
  });

  it('does not report perfect axis confidence when inputs are incomplete', () => {
    const report = assessRisk({
      snapshot: {
        ...baseSnapshot,
        truncated: true,
        files: [{ relativePath: 'src/a.ts', absolutePath: '/tmp/repo/src/a.ts', extension: '.ts', content: '', contentHash: 'a', nonBlankLines: 1 }],
      } as never,
      evidence: [caseWithChurn(10).evidence[0]!],
      semanticFindings: [],
      capabilities: fullCapabilities,
      analyzers: ['typescript-javascript-v1'],
      selectedAnalyzers: 1,
      successfulAnalyzers: 1,
      semanticResolution: { status: 'unavailable', reason: 'LLM not configured' },
    });

    const volatility = report.axes.find((axis) => axis.axisId === 'change-volatility');
    expect(volatility?.unevaluated).toBe(false);
    expect(volatility?.confidence).toBeLessThan(1);
    expect(volatility?.confidence).toBeGreaterThan(0);
  });

  it('does not change product score when test or tooling evidence is added', () => {
    const productOnly = assessRisk({
      snapshot: {
        ...baseSnapshot,
        files: [
          { relativePath: 'src/a.ts', absolutePath: '/tmp/repo/src/a.ts', extension: '.ts', content: '', contentHash: 'a', nonBlankLines: 1 },
          { relativePath: 'src/__tests__/a.test.ts', absolutePath: '/tmp/repo/src/__tests__/a.test.ts', extension: '.ts', content: '', contentHash: 'b', nonBlankLines: 1 },
        ],
      } as never,
      evidence: [caseWithChurn(10).evidence[0]!],
      semanticFindings: [],
      capabilities: fullCapabilities,
      analyzers: ['typescript-javascript-v1'],
      selectedAnalyzers: 1,
      successfulAnalyzers: 1,
      semanticResolution: { status: 'unavailable', reason: 'LLM not configured' },
    }).axes.find((axis) => axis.axisId === 'change-volatility')?.score;

    const withNonProduct = assessRisk({
      snapshot: {
        ...baseSnapshot,
        files: [
          { relativePath: 'src/a.ts', absolutePath: '/tmp/repo/src/a.ts', extension: '.ts', content: '', contentHash: 'a', nonBlankLines: 1 },
          { relativePath: 'src/__tests__/a.test.ts', absolutePath: '/tmp/repo/src/__tests__/a.test.ts', extension: '.ts', content: '', contentHash: 'b', nonBlankLines: 1 },
        ],
      } as never,
      evidence: [
        caseWithChurn(10).evidence[0]!,
        evidence({
          evidenceId: 'evidence:git-churn:src/__tests__/a.test.ts',
          signalId: 'git-churn',
          axisId: 'change-volatility',
          path: 'src/__tests__/a.test.ts',
          pathRole: 'test',
          strength: 100,
          rationale: 'test-only churn',
          severity: 'high',
          message: 'test churn',
        }),
      ],
      semanticFindings: [],
      capabilities: fullCapabilities,
      analyzers: ['typescript-javascript-v1'],
      selectedAnalyzers: 1,
      successfulAnalyzers: 1,
      semanticResolution: { status: 'unavailable', reason: 'LLM not configured' },
    }).axes.find((axis) => axis.axisId === 'change-volatility')?.score;

    expect(withNonProduct).toBe(productOnly);
  });
});

describe('relation-aware clusters', () => {
  it('merges related paths in the same mechanism into one cluster', () => {
    const relatedEvidence: Evidence[] = [
      evidence({
        evidenceId: 'evidence:large-file:src/a.ts',
        signalId: 'large-file',
        axisId: 'structural-fragility',
        path: 'src/a.ts',
        severity: 'medium',
        message: 'large a',
        relatedPaths: ['src/b.ts'],
      }),
      evidence({
        evidenceId: 'evidence:large-file:src/b.ts',
        signalId: 'large-file',
        axisId: 'structural-fragility',
        path: 'src/b.ts',
        severity: 'medium',
        message: 'large b',
        relatedPaths: ['src/c.ts'],
      }),
      evidence({
        evidenceId: 'evidence:large-file:src/c.ts',
        signalId: 'large-file',
        axisId: 'structural-fragility',
        path: 'src/c.ts',
        severity: 'low',
        message: 'large c',
        relatedPaths: ['src/a.ts'],
      }),
    ];

    const clusters = buildMechanismClusters(relatedEvidence);
    expect(clusters.filter((cluster) => cluster.mechanismId === 'large-file')).toHaveLength(1);
    expect(clusters.find((cluster) => cluster.mechanismId === 'large-file')?.paths.sort())
      .toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('keeps unrelated paths in separate clusters for the same mechanism', () => {
    const unrelatedEvidence: Evidence[] = ['src/a.ts', 'src/b.ts'].map((file) =>
      evidence({
        evidenceId: `evidence:large-file:${file}`,
        signalId: 'large-file',
        axisId: 'structural-fragility',
        path: file,
        severity: 'medium',
        message: 'large',
      }),
    );

    const clusters = buildMechanismClusters(unrelatedEvidence);
    expect(clusters.filter((cluster) => cluster.mechanismId === 'large-file').map((cluster) => cluster.paths))
      .toEqual([['src/a.ts'], ['src/b.ts']]);
  });

  it('keeps different mechanisms on the same path in separate clusters', () => {
    const mixedEvidence: Evidence[] = [
      evidence({
        evidenceId: 'evidence:large-file:src/a.ts',
        signalId: 'large-file',
        axisId: 'structural-fragility',
        path: 'src/a.ts',
        severity: 'medium',
        message: 'large',
      }),
      evidence({
        evidenceId: 'evidence:barrel-reexport:src/a.ts',
        signalId: 'barrel-reexport',
        axisId: 'structural-fragility',
        path: 'src/a.ts',
        severity: 'low',
        message: 'barrel',
        strength: 30,
        rationale: 'signal=barrel-reexport, strength=30, formula=provisional-binary',
      }),
    ];

    const clusters = buildMechanismClusters(mixedEvidence);
    expect(clusters.map((cluster) => cluster.mechanismId).sort())
      .toEqual(['barrel-export', 'large-file']);
  });
});

describe('assessment contract', () => {
  it('does not derive or expose comparison values from legacy assessment inputs', () => {
    const report = assessRisk({
      snapshot: baseSnapshot as never,
      evidence: [],
      semanticFindings: [],
      capabilities: [],
      analyzers: ['typescript-javascript-v1'],
      selectedAnalyzers: 1,
      successfulAnalyzers: 1,
      semanticResolution: { status: 'unavailable', reason: 'LLM not configured' },
      baselineScore: 5,
      baselineId: 'legacy-baseline',
      contractMismatch: false,
    } as unknown as Parameters<typeof assessRisk>[0]);

    expect(report.repository).not.toHaveProperty('riskDelta');
    expect(report.repository).not.toHaveProperty('baselineId');
    expect(formatConsoleReport(report)).not.toContain('Risk delta:');
    expect(formatMarkdownReport(report)).not.toContain('| Risk Delta |');
  });

  it('rejects legacy comparison values in a diagnosis report', () => {
    const report = assessRisk({
      snapshot: baseSnapshot as never,
      evidence: [],
      semanticFindings: [],
      capabilities: [],
      analyzers: ['typescript-javascript-v1'],
      selectedAnalyzers: 1,
      successfulAnalyzers: 1,
      semanticResolution: { status: 'unavailable', reason: 'LLM not configured' },
    });
    const legacyReport = {
      ...report,
      repository: {
        ...report.repository,
        riskDelta: 5,
        baselineId: 'legacy-baseline',
      },
    };

    expect(diagnosisReportSchema.safeParse(legacyReport).success).toBe(false);
  });

  it('does not dilute high severity when low severity duplicates are added', () => {
    const highOnly: Evidence[] = [evidence({
      evidenceId: 'evidence:dep-cycle:src/a.ts',
      signalId: 'dep-cycle',
      axisId: 'structural-fragility',
      path: 'src/a.ts',
      severity: 'high',
      strength: 90,
      rationale: 'signal=dep-cycle, strength=90, formula=provisional-binary',
      message: 'cycle',
    })];
    const withLowDuplicate: Evidence[] = [
      ...highOnly,
      evidence({
        evidenceId: 'evidence:dep-cycle:src/a.ts-dup',
        signalId: 'dep-cycle',
        axisId: 'structural-fragility',
        path: 'src/a.ts',
        severity: 'low',
        message: 'cycle duplicate',
      }),
    ];

    const assess = (items: Evidence[]) => assessRisk({
      snapshot: {
        ...baseSnapshot,
        files: [{ relativePath: 'src/a.ts', absolutePath: '/tmp/repo/src/a.ts', extension: '.ts', content: '', contentHash: 'a', nonBlankLines: 1 }],
      } as never,
      evidence: items,
      semanticFindings: [],
      capabilities: [{
        language: 'typescript-javascript',
        contractVersion: 3,
        completeness: 'full',
        supportedSignals: ['dep-cycle'],
        unevaluatedSignals: [],
        analyzerId: 'typescript-javascript-v1',
        analyzerImplementationVersion: '1.0.0',
      }],
      analyzers: ['typescript-javascript-v1'],
      selectedAnalyzers: 1,
      successfulAnalyzers: 1,
      semanticResolution: { status: 'unavailable', reason: 'LLM not configured' },
    }).repository.regressionRiskScore;

    expect(assess(withLowDuplicate)).toBe(assess(highOnly));
  });

  it('marks change volatility unevaluated when Git-backed signals are unavailable', () => {
    const nonGitSnapshot = { ...baseSnapshot, gitAvailable: false };
    const capabilities = negotiateCapabilities(
      {
        ...nonGitSnapshot,
        files: [{ relativePath: 'src/a.ts', absolutePath: '/tmp/repo/src/a.ts', extension: '.ts', content: '', contentHash: 'a', nonBlankLines: 1 }],
      } as never,
      [new TypeScriptAnalyzerPlugin()],
    ).capabilities;

    const report = assessRisk({
      snapshot: nonGitSnapshot as never,
      evidence: [],
      semanticFindings: [],
      capabilities,
      analyzers: ['typescript-javascript-v1'],
      selectedAnalyzers: 1,
      successfulAnalyzers: 1,
      semanticResolution: { status: 'unavailable', reason: 'LLM not configured' },
    });

    expect(report.axes.find((axis) => axis.axisId === 'change-volatility')?.unevaluated).toBe(true);
  });

  it('does not let unsupported git churn evidence override capability negotiation', () => {
    const nonGitSnapshot = { ...baseSnapshot, gitAvailable: false };
    const capabilities = negotiateCapabilities(
      {
        ...nonGitSnapshot,
        files: [{ relativePath: 'src/a.ts', absolutePath: '/tmp/repo/src/a.ts', extension: '.ts', content: '', contentHash: 'a', nonBlankLines: 1 }],
      } as never,
      [new TypeScriptAnalyzerPlugin()],
    ).capabilities;

    const report = assessRisk({
      snapshot: nonGitSnapshot as never,
      evidence: [
        evidence({
          evidenceId: 'evidence:git-churn:src/a.ts',
          signalId: 'git-churn',
          axisId: 'change-volatility',
          path: 'src/a.ts',
          severity: 'high',
          message: 'manually supplied churn evidence',
        }),
      ],
      semanticFindings: [],
      capabilities,
      analyzers: ['typescript-javascript-v1'],
      selectedAnalyzers: 1,
      successfulAnalyzers: 1,
      semanticResolution: { status: 'unavailable', reason: 'LLM not configured' },
    });

    expect(report.axes.find((axis) => axis.axisId === 'change-volatility')).toMatchObject({
      unevaluated: true,
      score: 0,
    });
    expect(report.clusters.some((cluster) => cluster.axisId === 'change-volatility')).toBe(false);
    expect(report.repository.regressionRiskScore).toBe(0);
  });

  it('scores only supported signals when an axis has mixed capability support', () => {
    const report = assessRisk({
      snapshot: {
        ...baseSnapshot,
        files: [{ relativePath: 'src/c.ts', absolutePath: '/tmp/repo/src/c.ts', extension: '.ts', content: '', contentHash: 'c', nonBlankLines: 1 }],
      } as never,
      evidence: [
        evidence({
          evidenceId: 'evidence:dep-cycle:src/a.ts->src/b.ts',
          signalId: 'dep-cycle',
          axisId: 'structural-fragility',
          path: 'src/a.ts',
          severity: 'high',
          strength: 90,
          rationale: 'signal=dep-cycle, strength=90, formula=provisional-binary',
          message: 'manually supplied dependency cycle',
        }),
        evidence({
          evidenceId: 'evidence:large-file:src/c.ts',
          signalId: 'large-file',
          axisId: 'structural-fragility',
          path: 'src/c.ts',
          severity: 'low',
          message: 'supported large file',
        }),
      ],
      semanticFindings: [],
      capabilities: [
        {
          language: 'typescript-javascript',
          contractVersion: 3,
          completeness: 'partial',
          supportedSignals: ['large-file'],
          unevaluatedSignals: ['dep-cycle'],
          analyzerId: 'typescript-javascript-v1',
          analyzerImplementationVersion: '1.0.0',
        },
      ],
      analyzers: ['typescript-javascript-v1'],
      selectedAnalyzers: 1,
      successfulAnalyzers: 1,
      semanticResolution: { status: 'unavailable', reason: 'LLM not configured' },
    });

    const structural = report.axes.find((axis) => axis.axisId === 'structural-fragility');
    expect(structural).toMatchObject({ unevaluated: false });
    expect(structural?.score).toBeGreaterThan(0);
    expect(report.clusters.some((cluster) => cluster.mechanismId === 'dependency-cycle')).toBe(false);
    expect(report.clusters.some((cluster) => cluster.mechanismId === 'large-file')).toBe(true);
    expect(report.repository.regressionRiskScore).toBe(structural?.score);
  });

  it('does not let unsupported semantic evidence affect clusters or repository score', () => {
    const report = assessRisk({
      snapshot: baseSnapshot as never,
      evidence: [
        evidence({
          evidenceId: 'evidence:semantic-ambiguity:src/a.ts',
          signalId: 'semantic-ambiguity',
          axisId: 'semantic-ambiguity',
          path: 'src/a.ts',
          severity: 'high',
          message: 'manually supplied semantic evidence',
          source: 'semantic',
        }),
      ],
      semanticFindings: [],
      capabilities: [
        {
          language: 'typescript-javascript',
          contractVersion: 3,
          completeness: 'partial',
          supportedSignals: ['large-file'],
          unevaluatedSignals: ['semantic-ambiguity'],
          analyzerId: 'typescript-javascript-v1',
          analyzerImplementationVersion: '1.0.0',
        },
      ],
      analyzers: ['typescript-javascript-v1'],
      selectedAnalyzers: 1,
      successfulAnalyzers: 1,
      semanticResolution: { status: 'unavailable', reason: 'LLM not configured' },
    });

    expect(report.axes.find((axis) => axis.axisId === 'semantic-ambiguity')).toMatchObject({
      unevaluated: true,
      score: 0,
    });
    expect(report.clusters.some((cluster) => cluster.axisId === 'semantic-ambiguity')).toBe(false);
    expect(report.repository.regressionRiskScore).toBe(0);
  });

  it('clusters by mechanism rather than axis only', () => {
    const evidenceItems: Evidence[] = [
      evidence({
        evidenceId: 'evidence:dep-cycle:src/a.ts->src/b.ts',
        signalId: 'dep-cycle',
        axisId: 'structural-fragility',
        path: 'src/a.ts',
        severity: 'high',
        strength: 90,
        rationale: 'signal=dep-cycle, strength=90, formula=provisional-binary',
        message: 'cycle',
        metrics: { cycle: 'src/a.ts->src/b.ts' },
        relatedPaths: ['src/b.ts'],
      }),
      evidence({
        evidenceId: 'evidence:large-file:src/c.ts',
        signalId: 'large-file',
        axisId: 'structural-fragility',
        path: 'src/c.ts',
        severity: 'medium',
        message: 'large',
      }),
    ];

    const report = assessRisk({
      snapshot: {
        ...baseSnapshot,
        files: [
          { relativePath: 'src/a.ts', absolutePath: '/tmp/repo/src/a.ts', extension: '.ts', content: '', contentHash: 'a', nonBlankLines: 1 },
          { relativePath: 'src/b.ts', absolutePath: '/tmp/repo/src/b.ts', extension: '.ts', content: '', contentHash: 'b', nonBlankLines: 1 },
          { relativePath: 'src/c.ts', absolutePath: '/tmp/repo/src/c.ts', extension: '.ts', content: '', contentHash: 'c', nonBlankLines: 1 },
        ],
      } as never,
      evidence: evidenceItems,
      semanticFindings: [],
      capabilities: [
        {
          language: 'typescript-javascript',
          contractVersion: 3,
          completeness: 'full',
          supportedSignals: ['dep-cycle', 'large-file'],
          unevaluatedSignals: [],
          analyzerId: 'typescript-javascript-v1',
          analyzerImplementationVersion: '1.0.0',
        },
      ],
      analyzers: ['typescript-javascript-v1'],
      selectedAnalyzers: 1,
      successfulAnalyzers: 1,
      semanticResolution: { status: 'unavailable', reason: 'LLM not configured' },
    });

    expect(report.clusters.some((cluster) => cluster.mechanismId === 'dependency-cycle')).toBe(true);
    expect(report.clusters.some((cluster) => cluster.mechanismId === 'large-file')).toBe(true);
    expect(diagnosisReportSchema.safeParse(report).success).toBe(true);
  });

  it('REG-2026-006 keeps unrelated non-cycle evidence in separate mechanism clusters', () => {
    const evidenceItems: Evidence[] = ['src/a.ts', 'src/b.ts'].map((file) =>
      evidence({
        evidenceId: `evidence:large-file:${file}`,
        signalId: 'large-file',
        axisId: 'structural-fragility',
        path: file,
        severity: 'medium',
        message: 'large',
      }),
    );

    const report = assessRisk({
      snapshot: baseSnapshot as never,
      evidence: evidenceItems,
      semanticFindings: [],
      capabilities: [{
        language: 'typescript-javascript',
        contractVersion: 3,
        completeness: 'full',
        supportedSignals: ['large-file'],
        unevaluatedSignals: [],
        analyzerId: 'typescript-javascript-v1',
        analyzerImplementationVersion: '1.0.0',
      }],
      analyzers: ['typescript-javascript-v1'],
      selectedAnalyzers: 1,
      successfulAnalyzers: 1,
      semanticResolution: { status: 'unavailable', reason: 'LLM not configured' },
    });

    expect(report.clusters.filter((cluster) => cluster.mechanismId === 'large-file').map((cluster) => cluster.paths))
      .toEqual([['src/a.ts'], ['src/b.ts']]);
  });
});

describe('assessment output labels', () => {
  it('distinguishes unevaluated axes from evaluated axes with no signals', () => {
    const nonGitSnapshot = { ...baseSnapshot, gitAvailable: false };
    const capabilities = negotiateCapabilities(
      {
        ...nonGitSnapshot,
        files: [{ relativePath: 'src/a.ts', absolutePath: '/tmp/repo/src/a.ts', extension: '.ts', content: '', contentHash: 'a', nonBlankLines: 1 }],
      } as never,
      [new TypeScriptAnalyzerPlugin()],
    ).capabilities;

    const report = assessRisk({
      snapshot: nonGitSnapshot as never,
      evidence: [],
      semanticFindings: [],
      capabilities,
      analyzers: ['typescript-javascript-v1'],
      selectedAnalyzers: 1,
      successfulAnalyzers: 1,
      semanticResolution: { status: 'unavailable', reason: 'LLM not configured' },
    });

    const consoleOut = formatConsoleReport(report);
    const markdownOut = formatMarkdownReport(report);
    expect(consoleOut).toContain('Change Volatility: unevaluated (excluded from aggregate)');
    expect(consoleOut).toContain('Structural Fragility: 0 (no signals detected)');
    expect(markdownOut).toContain('| Change Volatility | unevaluated (excluded from aggregate) |');
    expect(markdownOut).toContain('| Structural Fragility | 0 (no signals detected) |');
  });

  it('REG-2026-005 evaluates semantic ambiguity when validated findings are available', () => {
    const report = assessRisk({
      snapshot: {
        ...baseSnapshot,
        files: [{ relativePath: 'src/a.ts', absolutePath: '/tmp/repo/src/a.ts', extension: '.ts', content: '', contentHash: 'a', nonBlankLines: 1 }],
      },
      evidence: [evidence({
        evidenceId: 'evidence:large-file:src/a.ts',
        signalId: 'large-file',
        axisId: 'structural-fragility',
        path: 'src/a.ts',
        severity: 'medium',
        message: 'large file anchor',
      })],
      semanticFindings: [
        {
          findingId: 'finding:semantic:1',
          axisId: 'semantic-ambiguity',
          path: 'src/a.ts',
          summary: 'Ambiguous module boundary',
          relatedEvidenceIds: ['evidence:large-file:src/a.ts'],
          confidence: 0.8,
        },
      ],
      capabilities: [],
      analyzers: [],
      selectedAnalyzers: 0,
      successfulAnalyzers: 0,
      semanticResolution: { status: 'available', provider: { name: 'codex', implementationVersion: '1.0.0', analyze: async () => [] } },
      llmProvider: 'codex',
      semanticProviderImplementationVersion: '1.0.0',
    });

    const semanticAxis = report.axes.find((axis) => axis.axisId === 'semantic-ambiguity');
    expect(semanticAxis).toMatchObject({
      unevaluated: false,
      confidence: 0.8,
    });
    expect(semanticAxis?.score).toBeGreaterThan(0);
    expect(report.clusters.find((cluster) => cluster.axisId === 'semantic-ambiguity')).toMatchObject({
      paths: ['src/a.ts'],
      confidence: 0.8,
    });
    expect(formatConsoleReport(report)).toMatch(/Semantic Ambiguity: \d+/);
    expect(formatMarkdownReport(report)).toMatch(/\| Semantic Ambiguity \| \d+/);
  });

  it('keeps ungrounded semantic findings out of clusters and repository score', () => {
    const report = assessRisk({
      snapshot: {
        ...baseSnapshot,
        files: [{ relativePath: 'src/a.ts', absolutePath: '/tmp/repo/src/a.ts', extension: '.ts', content: '', contentHash: 'a', nonBlankLines: 1 }],
      },
      evidence: [],
      semanticFindings: [
        {
          findingId: 'finding:semantic:ungrounded',
          axisId: 'semantic-ambiguity',
          path: 'src/a.ts',
          summary: 'Finding has no deterministic evidence anchor',
          relatedEvidenceIds: [],
          confidence: 0.8,
          impactScope: 'repository',
        },
      ],
      capabilities: [],
      analyzers: [],
      selectedAnalyzers: 0,
      successfulAnalyzers: 0,
      semanticResolution: { status: 'available', provider: { name: 'codex', implementationVersion: '1.0.0', analyze: async () => [] } },
      llmProvider: 'codex',
      semanticProviderImplementationVersion: '1.0.0',
    });

    expect(report.semanticFindings).toHaveLength(1);
    expect(report.axes.find((axis) => axis.axisId === 'semantic-ambiguity')?.score).toBe(0);
    expect(report.clusters.some((cluster) => cluster.axisId === 'semantic-ambiguity')).toBe(false);
    expect(report.repository.regressionRiskScore).toBe(0);
  });

  it('records no findings reason when semantic provider succeeds with empty output', () => {
    const report = assessRisk({
      snapshot: { ...baseSnapshot, config: { ...baseSnapshot.config, llm: { ...baseSnapshot.config.llm, enabled: true, provider: 'codex' } } },
      evidence: [],
      semanticFindings: [],
      capabilities: [],
      analyzers: [],
      selectedAnalyzers: 0,
      successfulAnalyzers: 0,
      semanticResolution: { status: 'available', provider: { name: 'codex', implementationVersion: '1.0.0', analyze: async () => [] } },
      llmProvider: 'codex',
      semanticProviderImplementationVersion: '1.0.0',
    });

    expect(report.metadata.semanticProviderStatus).toBe('available');
    expect(report.metadata.semanticProviderReason).toBe('no findings returned');
    expect(report.axes.find((axis) => axis.axisId === 'semantic-ambiguity')?.unevaluated).toBe(true);
  });
});

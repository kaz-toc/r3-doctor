import {
  ASSESSMENT_CONTRACT_VERSION,
  REPORT_SCHEMA_VERSION,
  diagnosisReportSchema,
  provisionalEvidenceDetails,
  severityForStrength,
} from '../../../src/schema/report.v1.js';
import type { DiagnosisReport, Evidence, Intervention, RiskCluster } from '../../../src/schema/report.v1.js';

const MECHANISM_ID = 'dependency-cycle';

export function buildDecisionReportFixture(): DiagnosisReport {
  const evidence: Evidence[] = [];
  for (let index = 0; index < 70; index += 1) {
    const path = `src/module-${String(index).padStart(2, '0')}.ts`;
    const strength = 90 - index;
    evidence.push({
      evidenceId: `evidence:dep-cycle:${path}`,
      signalId: 'dep-cycle',
      axisId: 'structural-fragility',
      path,
      strength,
      rationale: `value=${index + 1}, onset=1, formula=v4-log2`,
      pathRole: 'product',
      relatedPaths: [path, `src/shared-${index % 5}.ts`],
      severity: severityForStrength(strength),
      message: `dependency cycle detected around ${path}`,
      source: 'deterministic',
      metrics: { cycleLength: index % 4 + 2 },
    });
  }

  const clusters: RiskCluster[] = [];
  for (let index = 0; index < 7; index += 1) {
    const start = index * 10;
    const slice = evidence.slice(start, start + 10).map((item) => item.evidenceId);
    clusters.push({
      clusterId: `cluster:dependency-cycle:${index}`,
      title: `Dependency cycle cluster ${index + 1}`,
      score: 92 - index,
      confidence: 0.85,
      axisId: 'structural-fragility',
      mechanismId: MECHANISM_ID,
      paths: slice.map((id) => evidence.find((item) => item.evidenceId === id)?.path ?? 'repo'),
      failureMechanism: 'Circular dependency between product modules',
      triggerChanges: [`refactor module-${index}`, `expand shared-${index % 5}`],
      evidenceIds: slice,
    });
  }

  const interventions: Intervention[] = [];
  for (let index = 0; index < 6; index += 1) {
    const cluster = clusters[index % clusters.length]!;
    interventions.push({
      interventionId: `intervention:dependency-cycle:${index}`,
      priority: index + 1,
      title: `Break cycle ${index + 1}`,
      description: `Untangle ${cluster.paths[0]} from the shared dependency hub.`,
      kind: 'structure',
      targetPaths: cluster.paths.slice(0, index + 4),
      linkedSignalIds: ['dep-cycle'],
      linkedClusterIds: [cluster.clusterId],
      expectedEffect: 'Lower structural-fragility and blast-radius scores',
      verification: `Run targeted tests around ${cluster.paths[0]} and rescan.`,
      cost: index % 2 === 0 ? 'medium' : 'high',
      rationale: `${MECHANISM_ID} cluster ${cluster.clusterId} keeps score ${cluster.score} on ${cluster.paths[0]}.`,
      firstStep: `Extract shared contracts from ${cluster.paths[0]} into a boundary module.`,
      priorityScore: 95 - index * 3,
      verificationHorizon: 'Next scan should show fewer dep-cycle evidence items.',
    });
  }

  const report: DiagnosisReport = {
    metadata: {
      schemaVersion: REPORT_SCHEMA_VERSION,
      assessmentContractVersion: ASSESSMENT_CONTRACT_VERSION,
      generatedAt: '2026-09-07T00:00:00.000Z',
      inputId: 'decision-report-fixture',
      repositoryPath: '/tmp/decision-report',
      analyzers: ['typescript-javascript-v1', 'python-stub-v1', 'go-stub-v1'],
      truncated: false,
      unevaluatedAreas: [
        'Semantic Ambiguity',
        'Python analyzer: partial coverage',
        'Go analyzer: partial coverage',
      ],
      semanticProviderStatus: 'not-configured',
    },
    repository: {
      regressionRiskScore: 78,
      confidence: 0.72,
      disclaimer: 'Regression Risk Score は将来のデグレ発生確率を保証しません。根拠と確信度とともに優先順位付けに使用してください。',
      scoreBreakdown: {
        axisBase: 68,
        criticalClusterUplift: 10,
      },
      confidenceBreakdown: {
        signalCoverage: 0.8,
        semanticAnalysis: 0,
        gitHistory: 0.9,
        inputCompleteness: 1,
      },
      calibration: { status: 'uncalibrated' },
    },
    axes: [
      {
        axisId: 'structural-fragility',
        name: 'Structural Fragility',
        score: 82,
        contributionPoints: 82,
        scoreBreakdown: { peak: 82, breadth: 70, diversity: 40 },
        confidence: 0.9,
        unevaluated: false,
      },
      {
        axisId: 'change-blast-radius',
        name: 'Change Blast Radius',
        score: 55,
        contributionPoints: 55,
        scoreBreakdown: { peak: 55, breadth: 30, diversity: 20 },
        confidence: 0.8,
        unevaluated: false,
      },
      {
        axisId: 'verification-gap',
        name: 'Verification Gap',
        score: 48,
        contributionPoints: 48,
        scoreBreakdown: { peak: 48, breadth: 25, diversity: 15 },
        confidence: 0.75,
        unevaluated: false,
      },
      {
        axisId: 'change-volatility',
        name: 'Change Volatility',
        score: 35,
        contributionPoints: 35,
        scoreBreakdown: { peak: 35, breadth: 20, diversity: 10 },
        confidence: 0.7,
        unevaluated: false,
      },
      {
        axisId: 'semantic-ambiguity',
        name: 'Semantic Ambiguity',
        score: 0,
        contributionPoints: 0,
        scoreBreakdown: { peak: 0, breadth: 0, diversity: 0 },
        confidence: 0,
        unevaluated: true,
      },
    ],
    clusters,
    evidence,
    semanticFindings: [],
    interventions,
    capabilities: [
      {
        language: 'typescript-javascript',
        contractVersion: 4,
        completeness: 'full',
        supportedSignals: ['dep-cycle', 'high-fan-out', 'missing-test-pair'],
        unevaluatedSignals: [],
        analyzerId: 'typescript-javascript-v1',
        analyzerImplementationVersion: '1.0.0',
      },
      {
        language: 'python',
        contractVersion: 4,
        completeness: 'partial',
        supportedSignals: ['large-file'],
        unevaluatedSignals: ['dep-cycle', 'high-fan-in', 'git-churn'],
        analyzerId: 'python-stub-v1',
        analyzerImplementationVersion: '1.0.0',
      },
      {
        language: 'go',
        contractVersion: 4,
        completeness: 'partial',
        supportedSignals: ['unresolved-import'],
        unevaluatedSignals: ['dep-cycle', 'high-fan-out', 'missing-test-pair'],
        analyzerId: 'go-stub-v1',
        analyzerImplementationVersion: '1.0.0',
      },
    ],
  };

  return diagnosisReportSchema.parse(report);
}

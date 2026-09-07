import type {
  AxisAssessment,
  CapabilityResult,
  DiagnosisReport,
  Evidence,
  Intervention,
  RiskAxisId,
  SemanticFinding,
} from '../schema/report.v1.js';
import {
  ASSESSMENT_CONTRACT_VERSION,
  REPORT_SCHEMA_VERSION,
  diagnosisReportSchema,
} from '../schema/report.v1.js';
import type { RepositorySnapshot } from '../intake/snapshot.js';
import type { SemanticProviderResolution } from '../semantic/provider.js';
import { getScoreDisclaimer } from '../i18n/messages.js';
import { resolveLocale } from '../i18n/locale.js';
import { isScoreEligibleSemanticFinding } from '../semantic/semantic-response.js';
import {
  axisHasSupportedSignals,
  capabilityApprovedEvidence,
  countProductPaths,
  evaluableMechanismIdsForAxis,
} from './capability.js';
import { buildMechanismClusters } from './clusters.js';
import { computeAxisEvidenceConfidence, computeEvidenceConfidence } from './confidence.js';
import { assignContributionPoints, scoreAxis, scoreRepository } from './score.js';

const AXIS_NAMES: Record<RiskAxisId, string> = {
  'structural-fragility': 'Structural Fragility',
  'change-blast-radius': 'Change Blast Radius',
  'verification-gap': 'Verification Gap',
  'change-volatility': 'Change Volatility',
  'semantic-ambiguity': 'Semantic Ambiguity',
};

export type AssessmentInput = {
  snapshot: RepositorySnapshot;
  evidence: Evidence[];
  semanticFindings: SemanticFinding[];
  capabilities: CapabilityResult[];
  analyzers: string[];
  selectedAnalyzers: number;
  successfulAnalyzers: number;
  semanticResolution: SemanticProviderResolution;
  llmProvider?: string;
  semanticProviderImplementationVersion?: string;
};

export function assessRisk(input: AssessmentInput): DiagnosisReport {
  const axisIds = Object.keys(AXIS_NAMES) as RiskAxisId[];
  const semanticAxisUnevaluated =
    input.semanticResolution.status !== 'available' ||
    (input.snapshot.config.llm.enabled && input.semanticFindings.length === 0);
  const evaluatedEvidence = capabilityApprovedEvidence(input.evidence, input.capabilities);
  const productPathCount = countProductPaths(input.snapshot);
  const snapshotPaths = new Set(
    input.snapshot.files.map((file) => file.relativePath.replaceAll('\\', '/')),
  );
  const evidenceById = new Map(input.evidence.map((item) => [item.evidenceId, item]));
  const scoreEligibleSemanticFindings = input.semanticFindings.filter((finding) =>
    isScoreEligibleSemanticFinding(finding, snapshotPaths, evidenceById),
  );

  const locale = resolveLocale(input.snapshot.config);
  const axes: AxisAssessment[] = axisIds.map((axisId) => {
    const axisEvidence = evaluatedEvidence.filter((item) => item.axisId === axisId);
    const semantic = input.semanticFindings.filter((item) => item.axisId === axisId);
    const unevaluated =
      axisId === 'semantic-ambiguity'
        ? semanticAxisUnevaluated
        : !axisHasSupportedSignals(axisId, input.capabilities);
    const axisResult = unevaluated
      ? { score: 0, scoreBreakdown: { peak: 0, breadth: 0, diversity: 0 } }
      : scoreAxis({
          axisId,
          evidence: axisEvidence,
          semanticFindings: semantic,
          productPathCount,
          evaluableMechanismIds: evaluableMechanismIdsForAxis(axisId, input.capabilities),
          snapshotPaths,
          evidenceById,
        });
    return {
      axisId,
      name: AXIS_NAMES[axisId],
      score: axisResult.score,
      contributionPoints: 0,
      scoreBreakdown: axisResult.scoreBreakdown,
      confidence: 0,
      unevaluated,
    };
  });

  const clusters = buildMechanismClusters(evaluatedEvidence, scoreEligibleSemanticFindings, locale);
  const repositoryResult = scoreRepository(axes, clusters);
  assignContributionPoints(axes, repositoryResult.scoreBreakdown.axisBase);

  const { confidence, confidenceBreakdown } = computeEvidenceConfidence({
    snapshot: input.snapshot,
    capabilities: input.capabilities,
    selectedAnalyzers: input.selectedAnalyzers,
    successfulAnalyzers: input.successfulAnalyzers,
    semanticResolution: input.semanticResolution,
    axes,
  });
  for (const axis of axes) {
    if (axis.unevaluated) {
      axis.confidence = 0;
    } else if (axis.axisId === 'semantic-ambiguity') {
      const semantic = input.semanticFindings.filter((item) => item.axisId === axis.axisId);
      axis.confidence = semantic.length > 0
        ? Math.max(...semantic.map((finding) => finding.confidence))
        : 0;
    } else {
      axis.confidence = computeAxisEvidenceConfidence({
        snapshot: input.snapshot,
        capabilities: input.capabilities,
        selectedAnalyzers: input.selectedAnalyzers,
        successfulAnalyzers: input.successfulAnalyzers,
        semanticResolution: input.semanticResolution,
        axes,
      }, axis.axisId);
    }
  }

  const unevaluatedAreas = axes.filter((a) => a.unevaluated).map((a) => a.name);
  for (const capability of input.capabilities) {
    for (const signal of capability.unevaluatedSignals) {
      unevaluatedAreas.push(`${capability.language}:signal:${signal}`);
    }
  }
  for (const issue of input.snapshot.intakeIssues) {
    unevaluatedAreas.push(`${issue.kind}:${issue.path}`);
  }
  if (!input.snapshot.gitAvailable) {
    unevaluatedAreas.push('Git churn (git unavailable)');
  }

  const semanticProviderStatus =
    input.semanticResolution.status === 'available'
      ? ('available' as const)
      : input.snapshot.config.llm.enabled
        ? input.semanticResolution.reason.includes('failed')
          ? ('failed' as const)
          : ('unavailable' as const)
        : ('not-configured' as const);

  const report: DiagnosisReport = {
    metadata: {
      schemaVersion: REPORT_SCHEMA_VERSION,
      assessmentContractVersion: ASSESSMENT_CONTRACT_VERSION,
      generatedAt: new Date().toISOString(),
      inputId: input.snapshot.inputId,
      repositoryPath: input.snapshot.repositoryPath,
      unitId: input.snapshot.unitId,
      analyzers: input.analyzers,
      llmProvider: input.llmProvider,
      semanticProviderImplementationVersion: input.semanticProviderImplementationVersion,
      truncated: input.snapshot.truncated,
      unevaluatedAreas: [...new Set(unevaluatedAreas)].sort(),
      semanticProviderStatus,
      semanticProviderReason:
        input.semanticResolution.status === 'unavailable'
          ? input.semanticResolution.reason
          : input.semanticResolution.status === 'available' &&
              input.snapshot.config.llm.enabled &&
              input.semanticFindings.length === 0
            ? 'no findings returned'
            : undefined,
      reportLocale: locale,
    },
    repository: {
      regressionRiskScore: repositoryResult.regressionRiskScore,
      confidence,
      disclaimer: getScoreDisclaimer(locale),
      scoreBreakdown: repositoryResult.scoreBreakdown,
      confidenceBreakdown,
      calibration: {
        status: 'uncalibrated',
      },
    },
    axes,
    clusters,
    evidence: input.evidence,
    semanticFindings: input.semanticFindings,
    interventions: [] as Intervention[],
    capabilities: input.capabilities,
  };

  return diagnosisReportSchema.parse(report);
}

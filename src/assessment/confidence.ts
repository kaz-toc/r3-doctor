import type { AxisAssessment, CapabilityResult, ConfidenceBreakdown } from '../schema/report.v1.js';
import type { RepositorySnapshot } from '../intake/snapshot.js';
import type { SemanticProviderResolution } from '../semantic/provider.js';

export type ConfidenceInput = {
  snapshot: RepositorySnapshot;
  capabilities: CapabilityResult[];
  selectedAnalyzers: number;
  successfulAnalyzers: number;
  semanticResolution: SemanticProviderResolution;
  axes: AxisAssessment[];
};

export type ConfidenceResult = {
  confidence: number;
  confidenceBreakdown: ConfidenceBreakdown;
};

function computeCapabilityCoverage(capabilities: CapabilityResult[]): number {
  const expectedSignals = capabilities.flatMap((entry) => [...entry.supportedSignals, ...entry.unevaluatedSignals]);
  if (expectedSignals.length === 0) {
    return 1;
  }
  const supportedSignals = capabilities.flatMap((entry) => entry.supportedSignals);
  return supportedSignals.length / expectedSignals.length;
}

function computeInputCompleteness(snapshot: RepositorySnapshot, axes: AxisAssessment[]): number {
  let completeness = 1;
  if (snapshot.truncated) {
    completeness *= 0.85;
  }
  if (snapshot.intakeIssues.length > 0) {
    completeness *= Math.max(0.7, 1 - snapshot.intakeIssues.length * 0.05);
  }
  const gitRequiredUnevaluated = axes.some(
    (axis) => axis.unevaluated && axis.axisId === 'change-volatility',
  );
  if (!snapshot.gitAvailable && gitRequiredUnevaluated) {
    completeness *= 0.85;
  }
  return completeness;
}

function computeMeasurementReliability(
  selectedAnalyzers: number,
  successfulAnalyzers: number,
  semanticResolution: SemanticProviderResolution,
  snapshot: RepositorySnapshot,
): number {
  const analyzerRatio = selectedAnalyzers > 0 ? successfulAnalyzers / selectedAnalyzers : 1;
  const semanticFactor =
    semanticResolution.status === 'available'
      ? 1
      : snapshot.config.llm.enabled
        ? 0.85
        : 0.95;
  return analyzerRatio * semanticFactor;
}

export function computeEvidenceConfidence(input: ConfidenceInput): ConfidenceResult {
  const capabilityCoverage = computeCapabilityCoverage(input.capabilities);
  const inputCompleteness = computeInputCompleteness(input.snapshot, input.axes);
  const measurementReliability = computeMeasurementReliability(
    input.selectedAnalyzers,
    input.successfulAnalyzers,
    input.semanticResolution,
    input.snapshot,
  );

  const confidence = Math.max(
    0,
    Math.min(
      1,
      Number(
        (0.5 * capabilityCoverage + 0.3 * inputCompleteness + 0.2 * measurementReliability).toFixed(2),
      ),
    ),
  );

  const semanticAnalysis =
    input.semanticResolution.status === 'available'
      ? 1
      : input.snapshot.config.llm.enabled
        ? 0.85
        : 0;

  return {
    confidence,
    confidenceBreakdown: {
      signalCoverage: Number(capabilityCoverage.toFixed(2)),
      semanticAnalysis,
      gitHistory: input.snapshot.gitAvailable ? 1 : 0.85,
      inputCompleteness: Number(inputCompleteness.toFixed(2)),
    },
  };
}

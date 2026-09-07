import type { CalibrationResult } from './dataset.js';
import type { CalibrationSummary } from '../schema/report.v1.js';
import { loadPolicy } from '../operations/policy.js';
import { loadCalibration } from './dataset.js';
import { runGoldenAssessmentRegression } from './golden-regression.js';

const MEASURED_METRICS = [
  'falsePositiveRate',
  'missRate',
  'rankingQuality',
  'explanationUsefulness',
] as const;

export type CalibrationQualityInput = CalibrationResult;

export function summarizeCalibrationQuality(dataset: CalibrationQualityInput): CalibrationSummary {
  if (dataset.records.length === 0) {
    return { status: 'uncalibrated' };
  }

  const missingConditions = collectMissingValidationConditions(dataset);
  if (missingConditions.length === 0) {
    const sampleCount = dataset.records.reduce((total, record) => total + record.sampleCount, 0);
    const measured = MEASURED_METRICS.filter((metric) =>
      dataset.records.some((record) => record[metric] !== undefined),
    );
    return {
      status: 'validated',
      sampleCount,
      measured: [...measured],
    };
  }

  return {
    status: 'provisional',
    missingConditions,
  };
}

function collectMissingValidationConditions(dataset: CalibrationQualityInput): string[] {
  const missing: string[] = [];

  if (!dataset.records.every((record) => record.sampleCount >= 30)) {
    missing.push('calibration dataset with >= 30 samples per score band');
  }
  if (!dataset.records.some((record) => record.falsePositiveRate !== undefined)
    || !dataset.records.some((record) => record.missRate !== undefined)) {
    missing.push('documented false positive / false negative rates');
  }
  if (!dataset.records.some((record) => record.rankingQuality !== undefined)
    || !dataset.records.some((record) => record.explanationUsefulness !== undefined)) {
    missing.push('ranking quality and explanation usefulness recorded');
  }
  if (!dataset.goldenRegressionPassed) {
    missing.push('golden assessment regression tests passing');
  }
  for (const condition of dataset.missingRequiredConditions) {
    missing.push(condition);
  }

  return [...new Set(missing)];
}

export async function resolveCalibrationQuality(
  repositoryPath: string,
  policyFile?: string,
): Promise<CalibrationSummary> {
  const policy = await loadPolicy(repositoryPath, policyFile ?? 'r3-doctor.policy.json');
  const preliminary = await loadCalibration(repositoryPath, false, policy.requiredCalibrationConditions);
  if (preliminary.records.length === 0) {
    return { status: 'uncalibrated' };
  }

  const golden = await runGoldenAssessmentRegression();
  const dataset = await loadCalibration(
    repositoryPath,
    golden.passed,
    policy.requiredCalibrationConditions,
  );
  return summarizeCalibrationQuality(dataset);
}
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { ConfigError } from '../shared/errors.js';
import { deriveGateEligible } from '../operations/policy.js';

const calibrationConditionsSchema = z
  .array(z.string().trim().min(1))
  .refine((values) => new Set(values).size === values.length, 'conditions must be unique');

export const calibrationRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    scoreBand: z.string(),
    sampleCount: z.number().int().nonnegative(),
    observedRegressions: z.number().int().nonnegative(),
    observedReverts: z.number().int().nonnegative(),
    falsePositiveRate: z.number().min(0).max(1).optional(),
    missRate: z.number().min(0).max(1).optional(),
    rankingQuality: z.number().min(0).max(1).optional(),
    explanationUsefulness: z.number().min(0).max(1).optional(),
  })
  .strict();

export const calibrationDatasetSchema = z
  .object({
    schemaVersion: z.literal(1),
    records: z.array(calibrationRecordSchema),
    gateEligible: z.boolean().optional(),
    gateConditions: calibrationConditionsSchema,
    satisfiedConditions: calibrationConditionsSchema,
  })
  .strict();

export type CalibrationDataset = z.infer<typeof calibrationDatasetSchema>;
export type CalibrationResult = CalibrationDataset & {
  gateEligible: boolean;
  missingRequiredConditions: string[];
  goldenRegressionPassed: boolean;
};

const DEFAULT_GATE_CONDITIONS = [
  'calibration dataset with >= 30 samples per score band',
  'golden assessment regression tests passing',
  'documented false positive / false negative rates',
  'ranking quality and explanation usefulness recorded',
];

export async function loadCalibration(
  repositoryPath: string,
  goldenRegressionPassed: boolean,
  requiredConditions: string[],
): Promise<CalibrationResult> {
  const calibrationPath = path.join(repositoryPath, '.r3-doctor', 'calibration.json');
  try {
    await access(calibrationPath);
  } catch {
    return {
      schemaVersion: 1,
      records: [],
      gateEligible: false,
      gateConditions: DEFAULT_GATE_CONDITIONS,
      satisfiedConditions: [],
      missingRequiredConditions: [...requiredConditions],
      goldenRegressionPassed,
    };
  }

  try {
    const raw = await readFile(calibrationPath, 'utf8');
    const dataset = calibrationDatasetSchema.parse(JSON.parse(raw));
    const minSamplesPerBand = dataset.records.every((record) => record.sampleCount >= 30);
    const hasFalsePositiveRate = dataset.records.some((record) => record.falsePositiveRate !== undefined);
    const hasMissRate = dataset.records.some((record) => record.missRate !== undefined);
    const hasRankingQuality = dataset.records.some((record) => record.rankingQuality !== undefined);
    const hasExplanationUsefulness = dataset.records.some((record) => record.explanationUsefulness !== undefined);
    const missingRequiredConditions = requiredConditions.filter(
      (condition) => !dataset.satisfiedConditions.includes(condition),
    );

    const gateEligible = deriveGateEligible(
      {
        calibrationPresent: dataset.records.length > 0,
        minSamplesPerBand,
        hasFalsePositiveRate,
        hasMissRate,
        hasRankingQuality,
        hasExplanationUsefulness,
        goldenRegressionPassed,
      },
      requiredConditions,
      dataset.satisfiedConditions,
    );

    return { ...dataset, gateEligible, missingRequiredConditions, goldenRegressionPassed };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(calibrationPath, reason);
  }
}

export function summarizeCalibration(dataset: CalibrationResult): string {
  const lines = ['Calibration summary:', `Gate eligible (derived): ${dataset.gateEligible}`];
  for (const record of dataset.records) {
    lines.push(
      `- band ${record.scoreBand}: n=${record.sampleCount}, regressions=${record.observedRegressions}, reverts=${record.observedReverts}, fp=${record.falsePositiveRate ?? 'n/a'}, miss=${record.missRate ?? 'n/a'}, rank=${record.rankingQuality ?? 'n/a'}, explain=${record.explanationUsefulness ?? 'n/a'}`,
    );
  }
  if (dataset.missingRequiredConditions.length > 0) {
    lines.push('Missing required conditions:');
    for (const condition of dataset.missingRequiredConditions) {
      lines.push(`  - ${condition}`);
    }
  }
  if (!dataset.gateEligible && dataset.gateConditions.length > 0) {
    lines.push('Gate conditions not met:');
    for (const condition of dataset.gateConditions) {
      lines.push(`  - ${condition}`);
    }
  }
  return lines.join('\n');
}

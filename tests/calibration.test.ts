import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';

import { runGoldenAssessmentRegression } from '../src/calibration/golden-regression.js';
import { calibrationDatasetSchema, loadCalibration, summarizeCalibration } from '../src/calibration/dataset.js';
import type { CalibrationResult } from '../src/calibration/dataset.js';
import { summarizeCalibrationQuality } from '../src/calibration/quality.js';
import { ConfigError } from '../src/shared/errors.js';
import { policySchema } from '../src/operations/policy.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

function calibrationRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    scoreBand: '0-30',
    sampleCount: 30,
    observedRegressions: 1,
    observedReverts: 0,
    falsePositiveRate: 0.08,
    missRate: 0.12,
    rankingQuality: 0.62,
    explanationUsefulness: 0.71,
    ...overrides,
  };
}

function calibrationDataset(
  records: CalibrationResult['records'],
  overrides: Partial<CalibrationResult> = {},
): CalibrationResult {
  return {
    schemaVersion: 1,
    records,
    gateConditions: [],
    satisfiedConditions: [],
    gateEligible: false,
    missingRequiredConditions: [],
    goldenRegressionPassed: false,
    ...overrides,
  };
}

describe('calibration quality', () => {
  it('classifies missing calibration data as uncalibrated', () => {
    const noRecords = calibrationDataset([]);
    expect(summarizeCalibrationQuality({ ...noRecords, goldenRegressionPassed: false }).status).toBe('uncalibrated');
  });

  it('classifies incomplete calibration data as provisional with missing conditions', () => {
    const partialRecords = calibrationDataset([
      calibrationRecord({ scoreBand: '0-30', sampleCount: 12 }),
      calibrationRecord({ scoreBand: '31-60', sampleCount: 8 }),
    ], { missingRequiredConditions: ['security-reviewed'], goldenRegressionPassed: true });

    expect(summarizeCalibrationQuality(partialRecords)).toMatchObject({
      status: 'provisional',
      missingConditions: expect.arrayContaining([
        'calibration dataset with >= 30 samples per score band',
        'security-reviewed',
      ]),
    });
  });

  it('classifies fully satisfied calibration data as validated', () => {
    const validatedRecords = calibrationDataset([
      calibrationRecord({ scoreBand: '0-30', sampleCount: 30 }),
      calibrationRecord({ scoreBand: '31-60', sampleCount: 30 }),
      calibrationRecord({ scoreBand: '61-80', sampleCount: 30 }),
      calibrationRecord({ scoreBand: '81-100', sampleCount: 30 }),
    ], { gateEligible: true, goldenRegressionPassed: true });

    expect(summarizeCalibrationQuality(validatedRecords)).toMatchObject({
      status: 'validated',
      sampleCount: 120,
      measured: ['falsePositiveRate', 'missRate', 'rankingQuality', 'explanationUsefulness'],
    });
  });

  it('rejects invalid calibration schema with ConfigError', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-calibration-invalid-'));
    try {
      await mkdir(path.join(repositoryPath, '.r3-doctor'), { recursive: true });
      await writeFile(
        path.join(repositoryPath, '.r3-doctor', 'calibration.json'),
        JSON.stringify({ schemaVersion: 1, records: [{ scoreBand: 'bad' }] }),
      );

      await expect(loadCalibration(repositoryPath, true, [])).rejects.toBeInstanceOf(ConfigError);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it('publishes score-band metrics with sample counts', async () => {
    const dataset = await loadCalibration(path.join(root, '..'), false, []);
    expect(dataset.records.length).toBeGreaterThan(0);
    for (const record of dataset.records) {
      expect(record.sampleCount).toBeGreaterThan(0);
      expect(record.falsePositiveRate).toBeDefined();
      expect(record.missRate).toBeDefined();
    }
    expect(summarizeCalibration(dataset)).toContain('fp=');
  });

  it('detects golden assessment regression when expectations fail', async () => {
    const report = await runGoldenAssessmentRegression();
    expect(report.passed).toBe(true);
    expect(report.results.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects blank or duplicate persisted calibration conditions', () => {
    expect(() => policySchema.parse({ schemaVersion: 1, requiredCalibrationConditions: [''] })).toThrow();
    expect(() => policySchema.parse({ schemaVersion: 1 })).toThrow();
    expect(() => calibrationDatasetSchema.parse({
      schemaVersion: 1,
      records: [],
      gateConditions: [],
      satisfiedConditions: ['security-reviewed', 'security-reviewed'],
    })).toThrow();
    expect(() => calibrationDatasetSchema.parse({ schemaVersion: 1, records: [], gateConditions: [] })).toThrow();
  });

  it('returns and summarizes missing required custom conditions', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-calibration-conditions-'));
    try {
      await mkdir(path.join(repositoryPath, '.r3-doctor'), { recursive: true });
      await writeFile(path.join(repositoryPath, '.r3-doctor', 'calibration.json'), JSON.stringify({
        schemaVersion: 1,
        records: [{
          schemaVersion: 1,
          scoreBand: '0-100',
          sampleCount: 30,
          observedRegressions: 1,
          observedReverts: 0,
          falsePositiveRate: 0.1,
          missRate: 0.1,
          rankingQuality: 0.8,
          explanationUsefulness: 0.8,
        }],
        gateConditions: [],
        satisfiedConditions: [],
      }));

      const result = await loadCalibration(repositoryPath, true, ['security-reviewed']);

      expect(result.gateEligible).toBe(false);
      expect(result.missingRequiredConditions).toEqual(['security-reviewed']);
      expect(summarizeCalibration(result)).toContain('Missing required conditions:\n  - security-reviewed');
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});

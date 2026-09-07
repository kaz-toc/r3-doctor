import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRepositorySnapshot } from '../intake/snapshot.js';
import { runDiagnosis } from '../pipeline/diagnose.js';
import type { SignalId } from '../schema/report.v1.js';

export type GoldenSpec = {
  description: string;
  expected: {
    minScore?: number;
    maxScore?: number;
    requiredSignals: string[];
    forbiddenSignals: string[];
    minClusters: number;
  };
};

export type GoldenRegressionResult = {
  fixture: string;
  passed: boolean;
  score: number;
  violations: string[];
};

export type QualityRegressionReport = {
  passed: boolean;
  results: GoldenRegressionResult[];
};

export async function runGoldenAssessmentRegression(fixturesRoot?: string): Promise<QualityRegressionReport> {
  const root =
    fixturesRoot ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
  const goldenPath = path.join(root, 'golden', 'assessments.json');
  const golden = JSON.parse(await readFile(goldenPath, 'utf8')) as Record<string, GoldenSpec>;
  const results: GoldenRegressionResult[] = [];
  const scores = new Map<string, number>();

  for (const [fixture, spec] of Object.entries(golden)) {
    const snapshot = await createRepositorySnapshot(path.join(root, fixture));
    const report = await runDiagnosis(snapshot, { skipCalibrationResolution: true });
    const signals = new Set(report.evidence.map((item) => item.signalId));
    const violations: string[] = [];
    scores.set(fixture, report.repository.regressionRiskScore);

    if (spec.expected.maxScore !== undefined && report.repository.regressionRiskScore > spec.expected.maxScore) {
      violations.push(`score ${report.repository.regressionRiskScore} > max ${spec.expected.maxScore}`);
    }
    if (spec.expected.minScore !== undefined && report.repository.regressionRiskScore < spec.expected.minScore) {
      violations.push(`score ${report.repository.regressionRiskScore} < min ${spec.expected.minScore}`);
    }
    for (const required of spec.expected.requiredSignals) {
      if (!signals.has(required as SignalId)) {
        violations.push(`missing required signal ${required}`);
      }
    }
    for (const forbidden of spec.expected.forbiddenSignals) {
      if (signals.has(forbidden as SignalId)) {
        violations.push(`forbidden signal present ${forbidden}`);
      }
    }
    if (report.clusters.length < spec.expected.minClusters) {
      violations.push(`clusters ${report.clusters.length} < min ${spec.expected.minClusters}`);
    }

    results.push({
      fixture,
      passed: violations.length === 0,
      score: report.repository.regressionRiskScore,
      violations,
    });
  }

  const fragile = scores.get('fragile-cart');
  const improved = scores.get('fragile-cart-improved');
  const stable = scores.get('stable-cart');
  if (fragile !== undefined && improved !== undefined && fragile <= improved) {
    const orderingViolation = `expected fragile-cart (${fragile}) > fragile-cart-improved (${improved})`;
    const fragileResult = results.find((result) => result.fixture === 'fragile-cart');
    if (fragileResult) {
      fragileResult.violations.push(orderingViolation);
      fragileResult.passed = false;
    }
  }
  if (improved !== undefined && stable !== undefined && improved < stable) {
    const orderingViolation = `expected fragile-cart-improved (${improved}) >= stable-cart (${stable})`;
    const improvedResult = results.find((result) => result.fixture === 'fragile-cart-improved');
    if (improvedResult) {
      improvedResult.violations.push(orderingViolation);
      improvedResult.passed = false;
    }
  }

  return {
    passed: results.every((result) => result.passed),
    results,
  };
}

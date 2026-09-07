import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createRepositorySnapshot } from '../src/intake/snapshot.js';
import { runDiagnosis } from '../src/pipeline/diagnose.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const goldenPath = path.join(root, 'fixtures', 'golden', 'assessments.json');

describe('golden assessments', () => {
  it('matches expected risk profile per fixture', async () => {
    const golden = JSON.parse(await readFile(goldenPath, 'utf8')) as Record<
      string,
      {
        expected: {
          minScore?: number;
          maxScore?: number;
          requiredSignals: string[];
          forbiddenSignals: string[];
          minClusters: number;
        };
      }
    >;

    const scores = new Map<string, number>();

    for (const [name, spec] of Object.entries(golden)) {
      const snapshot = await createRepositorySnapshot(path.join(root, 'fixtures', name));
      const report = await runDiagnosis(snapshot);
      const signals = new Set(report.evidence.map((e) => e.signalId));
      scores.set(name, report.repository.regressionRiskScore);

      if (spec.expected.maxScore !== undefined) {
        expect(report.repository.regressionRiskScore).toBeLessThanOrEqual(spec.expected.maxScore);
      }
      if (spec.expected.minScore !== undefined) {
        expect(report.repository.regressionRiskScore).toBeGreaterThanOrEqual(spec.expected.minScore);
      }
      for (const required of spec.expected.requiredSignals) {
        expect(signals.has(required)).toBe(true);
      }
      for (const forbidden of spec.expected.forbiddenSignals) {
        expect(signals.has(forbidden)).toBe(false);
      }
      expect(report.clusters.length).toBeGreaterThanOrEqual(spec.expected.minClusters);
    }

    const fragile = scores.get('fragile-cart');
    const improved = scores.get('fragile-cart-improved');
    const stable = scores.get('stable-cart');
    expect(fragile).toBeDefined();
    expect(improved).toBeDefined();
    expect(stable).toBeDefined();
    expect(fragile!).toBeGreaterThan(improved!);
    expect(improved!).toBeGreaterThanOrEqual(stable!);
  });
});

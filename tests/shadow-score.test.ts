import { describe, expect, it } from 'vitest';

import { computeShadowScores, normalizeNumericStrength, SHADOW_CANDIDATE_IDS } from '../src/validation/shadow-score.js';
import { createRepositorySnapshot } from '../src/intake/snapshot.js';
import { runDiagnosis } from '../src/pipeline/diagnose.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('shadow score candidates', () => {
  it('soft-saturates numeric strengths without premature rounding', () => {
    expect([0.5, 1, 2, 4, 8].map((factor) => normalizeNumericStrength(factor * 10, 10)))
      .toEqual([0, 25, 50, 75, 100]);
    expect(normalizeNumericStrength(15, 10)).toBeGreaterThan(25);
    expect(normalizeNumericStrength(15, 10)).toBeLessThan(50);
  });

  it('is stable, complete, and does not mutate assessment inputs', async () => {
    const snapshot = await createRepositorySnapshot(path.join(fixtures, 'fragile-cart'));
    const report = await runDiagnosis(snapshot, { skipCalibrationResolution: true });
    const before = structuredClone({ snapshot, report });
    const scores = computeShadowScores(snapshot, report);

    expect(scores.map((score) => score.candidateId)).toEqual(SHADOW_CANDIDATE_IDS);
    expect(scores).toHaveLength(4);
    expect(scores.every((score) => score.formulaVersion === 1 && Number.isInteger(score.score))).toBe(true);
    expect(scores.every((score) => Object.keys(score.axisScores).length === 5)).toBe(true);
    expect({ snapshot, report }).toEqual(before);
  });
});

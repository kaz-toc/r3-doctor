import { describe, expect, it } from 'vitest';

import { computeRocAuc } from '../src/validation/evaluate.js';

describe('validation model metrics', () => {
  it('calculates perfect, tied, and unavailable ROC-AUC deterministically', () => {
    expect(computeRocAuc([
      { score: 100, positive: true },
      { score: 0, positive: false },
    ])).toBe(1);
    expect(computeRocAuc([
      { score: 50, positive: true },
      { score: 50, positive: false },
    ])).toBe(0.5);
    expect(computeRocAuc([{ score: 50, positive: true }])).toBeNull();
  });
});

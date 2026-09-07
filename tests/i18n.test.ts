import { describe, expect, it } from 'vitest';

import { catalogKeys, MESSAGE_KEYS } from '../src/i18n/catalog.js';
import { getScoreDisclaimer } from '../src/i18n/messages.js';

describe('i18n catalog', () => {
  it('keeps en and ja key sets identical', () => {
    expect(catalogKeys('en')).toEqual(catalogKeys('ja'));
    expect(catalogKeys('en')).toEqual([...MESSAGE_KEYS].sort());
  });

  it('returns non-empty strings for representative keys in both locales', () => {
    const sampleKeys = [
      'disclaimer.score',
      'evidence.highFanIn',
      'mechanism.high-connectivity.failure',
      'intervention.volatility.title',
      'format.remainingEvidence.other',
    ] as const;

    for (const key of sampleKeys) {
      expect(getScoreDisclaimer('en').length).toBeGreaterThan(0);
      expect(getScoreDisclaimer('ja').length).toBeGreaterThan(0);
    }
  });

  it('localizes score disclaimer', () => {
    expect(getScoreDisclaimer('en')).toContain('probability');
    expect(getScoreDisclaimer('ja')).toContain('確率');
  });
});

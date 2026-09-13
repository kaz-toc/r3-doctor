import { describe, expect, it } from 'vitest';

import { capSecurityConfidence, classifySeverity } from '../../src/addons/security/severity.js';

describe('security severity rubric', () => {
  it('maps impact and attack prerequisites to a fixed severity', () => {
    const cases: Array<[Parameters<typeof classifySeverity>[0], string]> = [
      [{ impact: 'arbitrary-execution', prerequisites: 'none' }, 'critical'],
      [{ impact: 'arbitrary-execution', prerequisites: 'authenticated' }, 'high'],
      [{ impact: 'cross-tenant-access', prerequisites: 'none' }, 'critical'],
      [{ impact: 'cross-tenant-access', prerequisites: 'privileged' }, 'high'],
      [{ impact: 'sensitive-data-access', prerequisites: 'none' }, 'high'],
      [{ impact: 'limited-data-access', prerequisites: 'none' }, 'medium'],
      [{ impact: 'defense-in-depth', prerequisites: 'none' }, 'low'],
    ];
    for (const [input, severity] of cases) {
      expect(classifySeverity(input)).toBe(severity);
    }
  });

  it('caps unknown prerequisites at medium', () => {
    expect(classifySeverity({ impact: 'arbitrary-execution', prerequisites: 'unknown' })).toBe('medium');
    expect(classifySeverity({ impact: 'sensitive-data-access', prerequisites: 'unknown' })).toBe('medium');
    expect(classifySeverity({ impact: 'limited-data-access', prerequisites: 'unknown' })).toBe('medium');
    expect(classifySeverity({ impact: 'defense-in-depth', prerequisites: 'unknown' })).toBe('low');
  });

  it('lowers findings backed only by context evidence to info', () => {
    expect(classifySeverity({ impact: 'sensitive-data-access', prerequisites: 'none', evidenceRoles: ['context', 'context'] }))
      .toBe('info');
    expect(classifySeverity({ impact: 'sensitive-data-access', prerequisites: 'none', evidenceRoles: ['context', 'sink'] }))
      .toBe('high');
  });
});

describe('security confidence cap', () => {
  const base = {
    proposed: 'high' as const,
    prerequisites: 'authenticated' as const,
    unitStatus: 'evaluated' as const,
    unitLimitations: [] as string[],
    conflicting: false,
  };

  it('keeps the proposed confidence when context is complete', () => {
    expect(capSecurityConfidence(base)).toBe('high');
    expect(capSecurityConfidence({ ...base, proposed: 'medium', unitLimitations: ['secret-masked'] })).toBe('medium');
  });

  it('caps at low for unknown prerequisites, insufficient context, unresolved relations, or conflicts', () => {
    expect(capSecurityConfidence({ ...base, prerequisites: 'unknown' })).toBe('low');
    expect(capSecurityConfidence({ ...base, unitStatus: 'insufficient-context' })).toBe('low');
    for (const limitation of ['dynamic-import', 'computed-call', 'external-middleware', 'unresolved-import', 'related-context-omitted']) {
      expect(capSecurityConfidence({ ...base, unitLimitations: [limitation] })).toBe('low');
    }
    expect(capSecurityConfidence({ ...base, conflicting: true })).toBe('low');
  });
});

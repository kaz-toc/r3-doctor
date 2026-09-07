import { describe, expect, it } from 'vitest';

import type { Evidence } from '../../src/schema/report.v1.js';
import {
  IMPACT_SCOPE_STRENGTH,
  isScoreEligibleSemanticFinding,
  parseSemanticResponse,
  semanticRiskStrength,
} from '../../src/semantic/semantic-response.js';

describe('parseSemanticResponse', () => {
  it('parses a bare JSON array', () => {
    const raw = parseSemanticResponse('[{"axisId":"semantic-ambiguity","summary":"x","confidence":0.5}]');
    expect(raw).toEqual([{ axisId: 'semantic-ambiguity', summary: 'x', confidence: 0.5 }]);
  });

  it('parses a fenced JSON array', () => {
    const raw = parseSemanticResponse('```json\n[{"axisId":"semantic-ambiguity","summary":"x","confidence":0.5}]\n```');
    expect(Array.isArray(raw)).toBe(true);
  });

  it('throws when no JSON array is present', () => {
    expect(() => parseSemanticResponse('not json')).toThrow(/JSON array/);
  });

  it('preserves impactScope separately from confidence', () => {
    const raw = parseSemanticResponse(
      '[{"axisId":"semantic-ambiguity","summary":"x","confidence":0.9,"impactScope":"repository","relatedEvidenceIds":["evidence:large-file:src/a.ts"]}]',
    ) as Array<Record<string, unknown>>;

    expect(raw[0]).toMatchObject({
      confidence: 0.9,
      impactScope: 'repository',
    });
  });
});

describe('semantic risk magnitude', () => {
  it('maps impactScope to contract rubric strengths', () => {
    expect(IMPACT_SCOPE_STRENGTH).toEqual({
      local: 35,
      module: 60,
      repository: 85,
    });
    expect(semanticRiskStrength('local')).toBe(35);
    expect(semanticRiskStrength('module')).toBe(60);
    expect(semanticRiskStrength('repository')).toBe(85);
  });

  it('does not derive risk magnitude from confidence', () => {
    expect(semanticRiskStrength('local')).not.toBeCloseTo(0.9 * 100 * 0.5);
  });
});

describe('semantic score eligibility', () => {
  const evidence: Evidence[] = [{
    evidenceId: 'evidence:large-file:src/a.ts',
    signalId: 'large-file',
    axisId: 'structural-fragility',
    path: 'src/a.ts',
    strength: 50,
    rationale: 'value=900, onset=800, formula=v4-log2',
    pathRole: 'product',
    relatedPaths: ['src/a.ts'],
    severity: 'medium',
    message: 'large file',
    source: 'deterministic',
  }];

  it('requires snapshot path and related deterministic evidence', () => {
    expect(
      isScoreEligibleSemanticFinding(
        {
          path: 'src/a.ts',
          relatedEvidenceIds: ['evidence:large-file:src/a.ts'],
          impactScope: 'module',
        },
        new Set(['src/a.ts']),
        new Map(evidence.map((item) => [item.evidenceId, item])),
      ),
    ).toBe(true);
  });

  it('rejects findings without related deterministic evidence', () => {
    expect(
      isScoreEligibleSemanticFinding(
        {
          path: 'src/a.ts',
          relatedEvidenceIds: [],
          impactScope: 'module',
        },
        new Set(['src/a.ts']),
        new Map(evidence.map((item) => [item.evidenceId, item])),
      ),
    ).toBe(false);
  });

  it('rejects findings whose path is absent from the snapshot', () => {
    expect(
      isScoreEligibleSemanticFinding(
        {
          path: 'src/missing.ts',
          relatedEvidenceIds: ['evidence:large-file:src/a.ts'],
          impactScope: 'module',
        },
        new Set(['src/a.ts']),
        new Map(evidence.map((item) => [item.evidenceId, item])),
      ),
    ).toBe(false);
  });
});

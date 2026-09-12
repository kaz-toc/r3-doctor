import { describe, expect, it } from 'vitest';

import { buildValidationStatus } from '../src/validation/status.js';
import type { ValidationOutcomeV1, ValidationSnapshotV1 } from '../src/validation/schema.js';

const id = 'a'.repeat(64);
const sample = {
  sampleId: id,
  recordedAt: '2026-09-01T00:00:00.000Z',
  dueAt: '2026-10-01T00:00:00.000Z',
  horizonDays: 30,
} as ValidationSnapshotV1;

describe('validation lifecycle status', () => {
  it('projects pending, due, and complete states deterministically', () => {
    expect(buildValidationStatus([sample], [], new Date('2026-09-30T00:00:00.000Z'), 90).samples[0]?.state).toBe('pending');
    expect(buildValidationStatus([sample], [], new Date('2026-10-01T00:00:00.000Z'), 90).samples[0]?.state).toBe('due');
    const outcome = { sampleId: id, outcome: 'no-regression' } as ValidationOutcomeV1;
    expect(buildValidationStatus([sample], [outcome], new Date('2026-10-01T00:00:00.000Z'), 90)).toMatchObject({
      counts: { pending: 0, due: 0, complete: 1 },
      samples: [{ state: 'complete', outcome: 'no-regression' }],
    });
  });
});

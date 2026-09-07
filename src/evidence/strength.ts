import type { Evidence, SignalId } from '../schema/report.v1.js';

export function normalizeAboveThreshold(value: number, onset: number): number {
  if (value < onset) {
    return 0;
  }
  return Math.round(Math.min(100, 25 + 50 * Math.log2(value / onset)));
}

export function severityForStrength(strength: number): Evidence['severity'] {
  if (strength >= 70) {
    return 'high';
  }
  if (strength >= 40) {
    return 'medium';
  }
  return 'low';
}

export const BINARY_SIGNAL_STRENGTH = {
  'dep-cycle': 90,
  'unresolved-import': 65,
  'missing-test-pair': 50,
  'barrel-reexport': 30,
} as const satisfies Partial<Record<SignalId, number>>;

export function buildNumericRationale(value: number, onset: number): string {
  return `value=${value}, onset=${onset}, formula=v4-log2`;
}

export function buildBinaryRationale(signalId: keyof typeof BINARY_SIGNAL_STRENGTH): string {
  return `signal=${signalId}, strength=${BINARY_SIGNAL_STRENGTH[signalId]}, formula=provisional-binary`;
}

import type { ValidationComparison } from './evaluate.js';
import type { ValidationStatus } from './status.js';

export type ValidationFormat = 'console' | 'json';

export function escapeConsoleIdentifier(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, (character) =>
    `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
}

export function parseValidationFormat(value: string): ValidationFormat {
  if (value === 'console' || value === 'json') return value;
  throw new Error(`invalid format: ${value}`);
}

export function formatValidationStatus(value: ValidationStatus, format: ValidationFormat): string {
  if (format === 'json') return `${JSON.stringify(value, null, 2)}\n`;
  const lines = [
    `pending=${value.counts.pending} due=${value.counts.due} complete=${value.counts.complete}`,
    ...value.samples.map((sample) =>
      `sample=${escapeConsoleIdentifier(sample.sampleId)} state=${sample.state} dueAt=${sample.dueAt}${sample.outcome ? ` outcome=${sample.outcome}` : ''}${sample.retentionExpired ? ' retention=expired' : ''}`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

export function formatValidationComparison(value: ValidationComparison, format: ValidationFormat): string {
  if (format === 'json') return `${JSON.stringify(value, null, 2)}\n`;
  const formatAssessment = (scope: string, candidate: ValidationComparison['primary'][number]) =>
    `${scope} candidate=${candidate.candidateId} formula=${candidate.formulaVersion} horizon=${candidate.horizonDays} status=${candidate.promotionStatus} samples=${candidate.metrics.sampleCount} auc=${candidate.metrics.rocAuc ?? 'unavailable'}`;
  return `${[
    `complete=${value.corpus.completeSampleCount} repositories=${value.corpus.repositoryCount} positives=${value.corpus.positiveCount} negatives=${value.corpus.negativeCount}`,
    ...value.primary.map((candidate) => formatAssessment('primary', candidate)),
    ...value.exploratory.map((candidate) => formatAssessment('exploratory', candidate)),
  ].join('\n')}\n`;
}

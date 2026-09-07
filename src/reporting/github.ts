import { writeFile } from 'node:fs/promises';

import type { DiffReport } from '../schema/report.v1.js';

function escapeWorkflowData(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeWorkflowProperty(value: string): string {
  return escapeWorkflowData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([`*_[\]{}()#+\-.!|])/g, '\\$1');
}

function annotationLines(diff: DiffReport): string[] {
  const lines: string[] = [];

  for (const change of [...diff.comparison.newSignals, ...diff.comparison.worsenedSignals]) {
    if (!change.path) {
      continue;
    }
    const evidence = diff.current.evidence.find((item) => item.evidenceId === change.evidenceId);
    const level = evidence?.severity === 'high' ? 'error' : 'warning';
    const message = `r3-doctor: ${change.message} (${change.signalId})`;
    lines.push(`::${level} file=${escapeWorkflowProperty(change.path)},line=1::${escapeWorkflowData(message)}`);
  }

  if (!diff.comparison.compatible) {
    lines.push(
      `::notice title=r3-doctor::${escapeWorkflowData(diff.comparison.reason ?? 'Assessment contract mismatch — compare scores cautiously')}`,
    );
  }

  return lines;
}

export function formatGitHubAnnotations(diff: DiffReport): string {
  const lines = annotationLines(diff);
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

export async function writeGitHubAnnotationsFile(diff: DiffReport, outputPath: string): Promise<void> {
  await writeFile(outputPath, formatGitHubAnnotations(diff));
}

export async function writeGitHubSummaryFile(diff: DiffReport, outputPath: string): Promise<void> {
  const markdown = escapeMarkdownText;
  const lines = [
    '# r3-doctor PR Advisory',
    '',
    `Score: ${diff.current.repository.regressionRiskScore}`,
    ...(diff.comparison.compatible && diff.base
      ? [
          `Baseline: ${markdown(diff.comparison.baselineId ?? diff.base.metadata.inputId)}`,
          `Base score: ${diff.base.repository.regressionRiskScore}`,
          `Delta vs base: ${diff.comparison.riskDelta ?? 0}`,
        ]
      : [`Contract incompatible — ${markdown(diff.comparison.reason ?? 'delta suppressed')}`]),
    '',
    '## Changed files',
    ...(diff.comparison.changedFiles.length > 0 ? diff.comparison.changedFiles.map((f) => `- ${markdown(f)}`) : ['- (none detected)']),
    '',
    '## Blast radius',
    ...diff.comparison.blastRadius.flatMap((entry) => [
      `### ${markdown(entry.changedFile)}`,
      `- Direct dependents: ${entry.directDependents.map(markdown).join(', ') || 'none'}`,
      `- Direct dependencies: ${entry.directDependencies.map(markdown).join(', ') || 'none'}`,
      `- Transitive dependents: ${entry.transitiveDependents.map(markdown).join(', ') || 'none'}`,
      `- Transitive dependencies: ${entry.transitiveDependencies.map(markdown).join(', ') || 'none'}`,
      `- Paths: ${entry.paths.map((p) => `${markdown(p.from)}-&gt;${markdown(p.to)}`).join('; ') || 'none'}`,
    ]),
    '',
    '## New signals',
    ...diff.comparison.newSignals.map((s) => `- ${markdown(s.evidenceId)}: ${markdown(s.message)}`),
    '',
    '## Worsened',
    ...diff.comparison.worsenedSignals.map((s) => `- ${markdown(s.evidenceId)}: ${markdown(s.message)}`),
    '',
    '## Improved',
    ...diff.comparison.improvedSignals.map((s) => `- ${markdown(s.evidenceId)}: ${markdown(s.message)}`),
  ];
  await writeFile(outputPath, `${lines.join('\n')}\n`);
}

import type { AxisAssessment, DiagnosisReport, DiffReport, Evidence } from '../schema/report.v1.js';

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 } as const;

function sortEvidence(items: Evidence[]): Evidence[] {
  return [...items].sort((a, b) => {
    const severityDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (severityDiff !== 0) {
      return severityDiff;
    }
    return a.evidenceId.localeCompare(b.evidenceId);
  });
}

function axisHasSignals(report: DiagnosisReport, axisId: AxisAssessment['axisId']): boolean {
  return report.evidence.some((item) => item.axisId === axisId) ||
    report.semanticFindings.some((item) => item.axisId === axisId);
}

function formatAxisScoreLabel(axis: AxisAssessment, report: DiagnosisReport): string {
  if (axis.unevaluated) {
    return 'unevaluated (excluded from aggregate)';
  }
  if (!axisHasSignals(report, axis.axisId)) {
    return '0 (no signals detected)';
  }
  return String(axis.score);
}

function unevaluatedAxisCount(report: DiagnosisReport): number {
  return report.axes.filter((axis) => axis.unevaluated).length;
}

function evidenceLines(report: DiagnosisReport, evidenceIds: string[]): string[] {
  return evidenceIds
    .map((id) => report.evidence.find((item) => item.evidenceId === id))
    .filter(Boolean)
    .map(
      (item) =>
        `    - [${item!.severity}] ${item!.signalId} ${item!.path ?? 'repo'}: ${item!.message}${item!.metrics ? ` (${JSON.stringify(item!.metrics)})` : ''}`,
    );
}

function formatEvidenceConsoleLines(report: DiagnosisReport): string[] {
  const lines: string[] = ['Evidence:'];
  const sorted = sortEvidence(report.evidence);
  if (sorted.length === 0) {
    lines.push('  - (none)');
    return lines;
  }
  for (const item of sorted) {
    lines.push(
      `  - [${item.severity}] ${item.signalId} ${item.path ?? 'repo'}: ${item.message}${item.metrics ? ` (${JSON.stringify(item.metrics)})` : ''}`,
    );
  }
  return lines;
}

function formatEvidenceMarkdownLines(report: DiagnosisReport): string[] {
  const lines: string[] = ['## Evidence', ''];
  const sorted = sortEvidence(report.evidence);
  if (sorted.length === 0) {
    lines.push('- (none)');
    lines.push('');
    return lines;
  }
  for (const item of sorted) {
    lines.push(
      `- \`${item.evidenceId}\` [${item.severity}] \`${item.signalId}\` ${item.path ?? 'repo'}: ${item.message}`,
    );
  }
  lines.push('');
  return lines;
}

function formatSemanticFindingsConsoleLines(report: DiagnosisReport): string[] {
  const lines: string[] = ['Semantic findings:'];
  if (report.semanticFindings.length === 0) {
    const semanticUnevaluated = report.axes.find((axis) => axis.axisId === 'semantic-ambiguity')?.unevaluated;
    lines.push(semanticUnevaluated ? '  - none (axis unevaluated)' : '  - (none)');
    return lines;
  }
  for (const finding of report.semanticFindings) {
    lines.push(`  - [${finding.axisId}] ${finding.summary} (confidence ${finding.confidence})`);
  }
  return lines;
}

function formatSemanticFindingsMarkdownLines(report: DiagnosisReport): string[] {
  const lines: string[] = ['## Semantic Findings', ''];
  if (report.semanticFindings.length === 0) {
    const semanticUnevaluated = report.axes.find((axis) => axis.axisId === 'semantic-ambiguity')?.unevaluated;
    lines.push(semanticUnevaluated ? '- none (axis unevaluated)' : '- (none)');
    lines.push('');
    return lines;
  }
  for (const finding of report.semanticFindings) {
    lines.push(
      `- \`${finding.findingId}\` (${finding.axisId}, confidence ${finding.confidence}): ${finding.summary}`,
    );
  }
  lines.push('');
  return lines;
}

function formatBlastRadiusConsoleLines(diff: DiffReport): string[] {
  const lines: string[] = ['Blast radius:'];
  if (diff.comparison.blastRadius.length === 0) {
    lines.push('  - (none)');
    return lines;
  }
  for (const entry of diff.comparison.blastRadius) {
    lines.push(`  - ${entry.changedFile}`);
    lines.push(`    direct dependents: ${entry.directDependents.join(', ') || 'none'}`);
    lines.push(`    direct dependencies: ${entry.directDependencies.join(', ') || 'none'}`);
    lines.push(`    transitive dependents: ${entry.transitiveDependents.join(', ') || 'none'}`);
    lines.push(`    transitive dependencies: ${entry.transitiveDependencies.join(', ') || 'none'}`);
    lines.push(`    paths: ${entry.paths.map((p) => `${p.from}->${p.to}`).join('; ') || 'none'}`);
  }
  return lines;
}

function formatBlastRadiusMarkdownLines(diff: DiffReport): string[] {
  const lines: string[] = ['### Blast radius', ''];
  if (diff.comparison.blastRadius.length === 0) {
    lines.push('- (none)');
    lines.push('');
    return lines;
  }
  for (const entry of diff.comparison.blastRadius) {
    lines.push(`#### ${entry.changedFile}`);
    lines.push(`- Direct dependents: ${entry.directDependents.join(', ') || 'none'}`);
    lines.push(`- Direct dependencies: ${entry.directDependencies.join(', ') || 'none'}`);
    lines.push(`- Transitive dependents: ${entry.transitiveDependents.join(', ') || 'none'}`);
    lines.push(`- Transitive dependencies: ${entry.transitiveDependencies.join(', ') || 'none'}`);
    lines.push(`- Paths: ${entry.paths.map((p) => `${p.from}->${p.to}`).join('; ') || 'none'}`);
    lines.push('');
  }
  return lines;
}

function formatSignalChangeConsoleLines(diff: DiffReport): string[] {
  const lines: string[] = ['Signal changes:'];
  const groups = [
    ['new', diff.comparison.newSignals] as const,
    ['worsened', diff.comparison.worsenedSignals] as const,
    ['improved', diff.comparison.improvedSignals] as const,
  ];
  let any = false;
  for (const [kind, changes] of groups) {
    for (const change of changes) {
      any = true;
      lines.push(
        `  - [${kind}] [${change.currentSeverity}] ${change.signalId} ${change.path ?? 'repo'}: ${change.message}`,
      );
    }
  }
  if (!any) {
    lines.push('  - (none)');
  }
  return lines;
}

function formatSignalChangeMarkdownLines(diff: DiffReport): string[] {
  const lines: string[] = ['### Signal changes', ''];
  const groups = [
    ['new', diff.comparison.newSignals] as const,
    ['worsened', diff.comparison.worsenedSignals] as const,
    ['improved', diff.comparison.improvedSignals] as const,
  ];
  let any = false;
  for (const [kind, changes] of groups) {
    for (const change of changes) {
      any = true;
      lines.push(
        `- [${kind}] \`${change.evidenceId}\` [${change.currentSeverity}] \`${change.signalId}\` ${change.path ?? 'repo'}: ${change.message}`,
      );
    }
  }
  if (!any) {
    lines.push('- (none)');
  }
  lines.push('');
  return lines;
}

export function formatJsonReport(report: DiagnosisReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatDiffJsonReport(diff: DiffReport): string {
  return `${JSON.stringify(diff, null, 2)}\n`;
}

export function formatConsoleReport(report: DiagnosisReport): string {
  const lines: string[] = [];
  const unevaluatedCount = unevaluatedAxisCount(report);
  lines.push(
    `Regression Risk Score: ${report.repository.regressionRiskScore} (confidence ${report.repository.confidence}, unevaluated axes: ${unevaluatedCount})`,
  );
  lines.push(report.repository.disclaimer);
  lines.push('');
  lines.push('Capabilities:');
  for (const capability of report.capabilities) {
    lines.push(
      `  - ${capability.language} (${capability.completeness}): supported=${capability.supportedSignals.join(', ') || 'none'}; unevaluated=${capability.unevaluatedSignals.join(', ') || 'none'}`,
    );
  }
  lines.push('');
  lines.push('Axes:');
  for (const axis of report.axes) {
    lines.push(`  - ${axis.name}: ${formatAxisScoreLabel(axis, report)}`);
  }
  lines.push('');
  lines.push('Top clusters:');
  for (const cluster of report.clusters.slice(0, 5)) {
    lines.push(`  - [${cluster.score}] ${cluster.title} (${cluster.mechanismId})`);
    lines.push(`    mechanism: ${cluster.failureMechanism}`);
    lines.push(`    triggers: ${cluster.triggerChanges.join('; ')}`);
    lines.push(`    paths: ${cluster.paths.join(', ') || 'n/a'}`);
    lines.push('    evidence:');
    lines.push(...evidenceLines(report, cluster.evidenceIds.slice(0, 3)));
  }
  lines.push('');
  lines.push(...formatEvidenceConsoleLines(report));
  lines.push('');
  lines.push(...formatSemanticFindingsConsoleLines(report));
  lines.push('');
  if (report.metadata.unevaluatedAreas.length > 0) {
    lines.push('Unevaluated areas:');
    for (const area of report.metadata.unevaluatedAreas) {
      lines.push(`  - ${area}`);
    }
    lines.push('');
  }
  lines.push('Interventions:');
  for (const item of report.interventions.slice(0, 5)) {
    lines.push(`  - (${item.priority}) ${item.title}`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatDiffConsoleReport(diff: DiffReport): string {
  const lines: string[] = [];
  lines.push(formatConsoleReport(diff.current).trimEnd());
  lines.push('');
  lines.push('Diff summary:');
  lines.push(`  compatible: ${diff.comparison.compatible}`);
  if (diff.comparison.reason) {
    lines.push(`  reason: ${diff.comparison.reason}`);
  }
  if (diff.comparison.compatible && diff.base) {
    lines.push(`  baseline: ${diff.comparison.baselineId ?? diff.base.metadata.inputId}`);
    lines.push(`  Base score: ${diff.base.repository.regressionRiskScore}`);
    lines.push(`  risk delta: ${diff.comparison.riskDelta ?? 0}`);
  }
  lines.push(`  changed files: ${diff.comparison.changedFiles.join(', ') || 'none'}`);
  lines.push('');
  for (const line of formatBlastRadiusConsoleLines(diff)) {
    lines.push(line === 'Blast radius:' ? `  ${line}` : `  ${line}`);
  }
  lines.push('');
  for (const line of formatSignalChangeConsoleLines(diff)) {
    lines.push(line === 'Signal changes:' ? `  ${line}` : `  ${line}`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatMarkdownReport(report: DiagnosisReport): string {
  const lines: string[] = [];
  const unevaluatedCount = unevaluatedAxisCount(report);
  lines.push('# r3-doctor Diagnosis Report');
  lines.push('');
  lines.push(`- Generated: ${report.metadata.generatedAt}`);
  lines.push(`- Input ID: ${report.metadata.inputId}`);
  lines.push(`- Contract: v${report.metadata.assessmentContractVersion}`);
  lines.push(`- Unevaluated axes: ${unevaluatedCount}`);
  lines.push('');
  lines.push('## Repository Assessment');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Regression Risk Score | ${report.repository.regressionRiskScore} |`);
  lines.push(`| Confidence | ${report.repository.confidence} |`);
  lines.push(`| Unevaluated axes | ${unevaluatedCount} |`);
  lines.push('');
  lines.push(`> ${report.repository.disclaimer}`);
  lines.push('');
  lines.push('## Capabilities');
  lines.push('');
  for (const capability of report.capabilities) {
    lines.push(`- ${capability.language} (${capability.completeness}, ${capability.analyzerId})`);
    lines.push(`  - supported: ${capability.supportedSignals.join(', ') || 'none'}`);
    lines.push(`  - unevaluated: ${capability.unevaluatedSignals.join(', ') || 'none'}`);
  }
  lines.push('');
  lines.push('## Risk Axes');
  lines.push('');
  for (const axis of report.axes) {
    lines.push(`### ${axis.name}`);
    lines.push(`- Score: ${formatAxisScoreLabel(axis, report)}`);
    lines.push(`- Contribution: ${axis.contribution}`);
    lines.push(`- Confidence: ${axis.confidence}`);
    lines.push('');
  }
  lines.push('## Risk Clusters');
  lines.push('');
  for (const cluster of report.clusters) {
    lines.push(`### ${cluster.title} (${cluster.score})`);
    lines.push(`- Mechanism: ${cluster.failureMechanism}`);
    lines.push(`- Mechanism ID: ${cluster.mechanismId}`);
    lines.push(`- Paths: ${cluster.paths.join(', ') || 'n/a'}`);
    lines.push(`- Triggers: ${cluster.triggerChanges.join('; ')}`);
    lines.push('- Evidence:');
    lines.push(...evidenceLines(report, cluster.evidenceIds).map((line) => line.replace(/^    /, '- ')));
    lines.push('');
  }
  lines.push(...formatEvidenceMarkdownLines(report));
  lines.push(...formatSemanticFindingsMarkdownLines(report));
  lines.push('## Interventions');
  lines.push('');
  for (const item of report.interventions) {
    lines.push(`### ${item.priority}. ${item.title}`);
    lines.push(`- Kind: ${item.kind}`);
    lines.push(`- Targets: ${item.targetPaths.join(', ') || 'n/a'}`);
    lines.push(`- Expected: ${item.expectedEffect}`);
    lines.push(`- Verify: ${item.verification}`);
    lines.push('');
  }
  if (report.metadata.unevaluatedAreas.length > 0) {
    lines.push('## Unevaluated Areas');
    lines.push('');
    for (const area of report.metadata.unevaluatedAreas) {
      lines.push(`- ${area}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export function formatDiffMarkdownReport(diff: DiffReport): string {
  const lines = [formatMarkdownReport(diff.current).trimEnd(), '', '## Diff Comparison', ''];
  lines.push(`- Compatible: ${diff.comparison.compatible}`);
  if (diff.comparison.reason) {
    lines.push(`- Reason: ${diff.comparison.reason}`);
  }
  if (diff.comparison.compatible && diff.base) {
    lines.push(`- Baseline: ${diff.comparison.baselineId ?? diff.base.metadata.inputId}`);
    lines.push(`- Base score: ${diff.base.repository.regressionRiskScore}`);
    lines.push(`- Risk delta: ${diff.comparison.riskDelta ?? 0}`);
  }
  lines.push(`- Changed files: ${diff.comparison.changedFiles.join(', ') || 'none'}`);
  lines.push('');
  lines.push(...formatBlastRadiusMarkdownLines(diff));
  lines.push(...formatSignalChangeMarkdownLines(diff));
  return `${lines.join('\n')}\n`;
}

export function formatReport(report: DiagnosisReport, format: 'json' | 'markdown' | 'console'): string {
  switch (format) {
    case 'json':
      return formatJsonReport(report);
    case 'markdown':
      return formatMarkdownReport(report);
    case 'console':
      return formatConsoleReport(report);
  }
}

export function formatDiffReport(diff: DiffReport, format: 'json' | 'markdown' | 'console'): string {
  switch (format) {
    case 'json':
      return formatDiffJsonReport(diff);
    case 'markdown':
      return formatDiffMarkdownReport(diff);
    case 'console':
      return formatDiffConsoleReport(diff);
  }
}

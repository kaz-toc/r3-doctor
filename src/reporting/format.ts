import type { DiagnosisReport, DiffReport, Evidence } from '../schema/report.v1.js';
import type { ReportLocale } from '../i18n/locale.js';
import { DEFAULT_LOCALE } from '../i18n/locale.js';
import { t } from '../i18n/messages.js';
import {
  buildReportViewModel,
  DEFAULT_REPORT_VIEW_LIMITS,
  formatAxisScoreLabel,
  type ActionItemView,
  type FactEvidenceGroup,
  type ReportView,
  type ReportViewModel,
  type SummaryClusterBlock,
} from './view-model.js';

export type { ReportView } from './view-model.js';

export type FormatReportOptions = {
  view?: ReportView;
  locale?: ReportLocale;
};

function resolveFormatLocale(report: DiagnosisReport, options: FormatReportOptions = {}): ReportLocale {
  return options.locale ?? report.metadata.reportLocale ?? DEFAULT_LOCALE;
}

function remainingSuffix(locale: ReportLocale, key: 'format.remainingEvidence' | 'format.remainingClusters' | 'format.remainingPaths' | 'format.remainingInterventions', count: number): string {
  return t(locale, key, { count });
}

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

function formatEvidenceMetrics(item: Evidence): string {
  const entries = Object.entries(item.metrics ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return entries.length > 0
    ? entries.map(([key, value]) => `${key}=${String(value)}`).join(',')
    : 'none';
}

function reportHeaderLines(report: DiagnosisReport): string[] {
  const unevaluatedCount = report.axes.filter((axis) => axis.unevaluated).length;
  return [
    '# r3-doctor Diagnosis Report',
    '',
    `- Generated: ${report.metadata.generatedAt}`,
    `- Input ID: ${report.metadata.inputId}`,
    `- Contract: v${report.metadata.assessmentContractVersion}`,
    `- Unevaluated axes: ${unevaluatedCount}`,
    '',
  ];
}

function formatEvidenceBullet(item: Evidence): string {
  return `- \`${item.evidenceId}\` [${item.severity}] strength=${item.strength} metrics=${formatEvidenceMetrics(item)} \`${item.signalId}\` ${item.path ?? 'repo'}: ${item.message}`;
}

function formatEvidenceConsoleBullet(item: Evidence): string {
  return `  - [${item.severity}] strength=${item.strength} metrics=${formatEvidenceMetrics(item)} ${item.signalId} ${item.path ?? 'repo'}: ${item.message}`;
}

function renderFactGroupMarkdown(group: FactEvidenceGroup, locale: ReportLocale): string[] {
  const lines = [
    `### ${group.mechanismLabel}`,
    `- Mechanism ID: ${group.mechanismId}`,
    `- Trigger: ${group.triggerSummary}`,
    '- Evidence:',
  ];
  for (const item of group.evidence) {
    lines.push(`  ${formatEvidenceBullet(item).replace(/^- /, '')}`);
  }
  if (group.remainingEvidenceCount > 0) {
    lines.push(`  - ${remainingSuffix(locale, 'format.remainingEvidence', group.remainingEvidenceCount)}`);
  }
  lines.push('');
  return lines;
}

function renderFactGroupConsole(group: FactEvidenceGroup, locale: ReportLocale): string[] {
  const lines = [
    `  - ${group.mechanismLabel} (${group.mechanismId})`,
    `    trigger: ${group.triggerSummary}`,
    '    evidence:',
  ];
  for (const item of group.evidence) {
    lines.push(`  ${formatEvidenceConsoleBullet(item)}`);
  }
  if (group.remainingEvidenceCount > 0) {
    lines.push(`    - ${remainingSuffix(locale, 'format.remainingEvidence', group.remainingEvidenceCount)}`);
  }
  return lines;
}

function renderFactsMarkdown(model: ReportViewModel, heading = '## Current state', locale: ReportLocale = DEFAULT_LOCALE): string[] {
  const { facts } = model;
  const lines = [heading, '', '### Analysis coverage', ''];
  for (const capability of facts.capabilities) {
    lines.push(`- ${capability.language} (${capability.completeness}, ${capability.analyzerId})`);
    lines.push(`  - supported: ${capability.supportedSignals.join(', ') || 'none'}`);
    lines.push(`  - unevaluated: ${capability.unevaluatedSignals.join(', ') || 'none'}`);
  }
  lines.push('');
  if (facts.limitationSummaries.length > 0) {
    lines.push('### Limitations', '');
    for (const limitation of facts.limitationSummaries) {
      lines.push(`- ${limitation}`);
    }
    lines.push('');
  }
  lines.push('### Grouped evidence', '');
  for (const group of facts.factGroups) {
    lines.push(...renderFactGroupMarkdown(group, locale));
  }
  if (facts.totalEvidenceCount > facts.factGroups.reduce((sum, group) => sum + group.evidence.length + group.remainingEvidenceCount, 0)) {
    lines.push(`- Full evidence list available via \`--format json\` (${facts.totalEvidenceCount} total)`);
    lines.push('');
  } else if (facts.totalEvidenceCount > 0) {
    lines.push(`- Full evidence list available via \`--format json\` (${facts.totalEvidenceCount} total)`);
    lines.push('');
  }
  return lines;
}

function renderFactsConsole(model: ReportViewModel, heading = 'Current state', locale: ReportLocale = DEFAULT_LOCALE): string[] {
  const { facts } = model;
  const lines = [heading, 'Analysis coverage:'];
  for (const capability of facts.capabilities) {
    lines.push(
      `  - ${capability.language} (${capability.completeness}): supported=${capability.supportedSignals.join(', ') || 'none'}; unevaluated=${capability.unevaluatedSignals.join(', ') || 'none'}`,
    );
  }
  if (facts.limitationSummaries.length > 0) {
    lines.push('Limitations:');
    for (const limitation of facts.limitationSummaries) {
      lines.push(`  - ${limitation}`);
    }
  }
  lines.push('Grouped evidence:');
  for (const group of facts.factGroups) {
    lines.push(...renderFactGroupConsole(group, locale));
  }
  lines.push(`Full evidence list available via --format json (${facts.totalEvidenceCount} total)`);
  return lines;
}

function renderSummaryMarkdown(
  model: ReportViewModel,
  heading = '## Assessment summary',
  options: { includeClusterEvidence?: boolean; locale?: ReportLocale } = {},
): string[] {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const { summary } = model;
  const lines = [
    heading,
    '',
    `- Regression Risk Score: ${summary.regressionRiskScore} (${summary.scoreBand})`,
    `- Confidence: ${summary.confidence}`,
    `- Calibration: ${summary.calibrationStatus}`,
    `- Unevaluated axes: ${summary.unevaluatedAxisCount}`,
    '',
    `> ${summary.disclaimer}`,
    '',
    '## Why this score',
    '',
    `- Axis base: ${summary.scoreBreakdown.axisBase}`,
    `- Critical cluster uplift: ${summary.scoreBreakdown.criticalClusterUplift}`,
    '',
    '| Axis | Score | Contribution | Confidence | Top rationale |',
    '|---|---:|---:|---:|---|',
  ];
  for (const axis of summary.axes) {
    lines.push(
      `| ${axis.name} | ${axis.scoreLabel} | ${axis.contributionPoints} | ${axis.confidence} | ${axis.topRationale} |`,
    );
  }
  lines.push('');
  lines.push('## Top risk clusters', '');
  for (const block of summary.clusters) {
    lines.push(...renderClusterMarkdown(block, { includeEvidence: options.includeClusterEvidence, locale }));
  }
  if (summary.remainingClusterCount > 0) {
    lines.push(`- ${remainingSuffix(locale, 'format.remainingClusters', summary.remainingClusterCount)}`);
    lines.push('');
  }
  if (summary.limitations.length > 0) {
    lines.push('## Limitations', '');
    for (const limitation of summary.limitations) {
      lines.push(`- ${limitation}`);
    }
    lines.push('');
  }
  return lines;
}

function renderClusterMarkdown(
  block: SummaryClusterBlock,
  options: { includeEvidence?: boolean; locale?: ReportLocale } = {},
): string[] {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const { cluster, evidence, remainingEvidenceCount } = block;
  const includeEvidence = options.includeEvidence ?? true;
  const lines = [
    `### ${cluster.title} (${cluster.score})`,
    `- Trigger: ${cluster.triggerChanges.join('; ')}`,
    `- Mechanism: ${cluster.failureMechanism}`,
    `- Measurable impact: score ${cluster.score}, confidence ${cluster.confidence}`,
  ];
  if (includeEvidence) {
    lines.push('- Evidence:');
    for (const item of evidence) {
      lines.push(`  - \`${item.evidenceId}\` ${item.path ?? 'repo'}: ${item.message}`);
    }
    if (remainingEvidenceCount > 0) {
      lines.push(`  - ${remainingSuffix(locale, 'format.remainingEvidence', remainingEvidenceCount)}`);
    }
  } else {
    const totalEvidence = evidence.length + remainingEvidenceCount;
    lines.push(`- Evidence: ${totalEvidence} items (see Current state)`);
  }
  lines.push('');
  return lines;
}

function renderSummaryConsole(
  model: ReportViewModel,
  heading = 'Assessment summary',
  options: { includeClusterEvidence?: boolean; locale?: ReportLocale } = {},
): string[] {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const { summary } = model;
  const lines = [
    heading,
    `Regression Risk Score: ${summary.regressionRiskScore} (${summary.scoreBand}, confidence ${summary.confidence}, calibration ${summary.calibrationStatus}, unevaluated axes: ${summary.unevaluatedAxisCount})`,
    summary.disclaimer,
    '',
    'Why this score:',
    `  - axis base: ${summary.scoreBreakdown.axisBase}`,
    `  - critical cluster uplift: ${summary.scoreBreakdown.criticalClusterUplift}`,
    'Axes:',
  ];
  for (const axis of summary.axes) {
    lines.push(`  - ${axis.name}: ${axis.scoreLabel} (contribution ${axis.contributionPoints}, confidence ${axis.confidence})`);
    lines.push(`    rationale: ${axis.topRationale}`);
  }
  lines.push('Top risk clusters:');
  for (const block of summary.clusters) {
    const { cluster, evidence, remainingEvidenceCount } = block;
    lines.push(`  - [${cluster.score}] ${cluster.title} (${cluster.mechanismId})`);
    lines.push(`    trigger: ${cluster.triggerChanges.join('; ')}`);
    lines.push(`    mechanism: ${cluster.failureMechanism}`);
    if (options.includeClusterEvidence ?? true) {
      lines.push('    evidence:');
      for (const item of evidence) {
        lines.push(`      - ${item.evidenceId} ${item.path ?? 'repo'}: ${item.message}`);
      }
      if (remainingEvidenceCount > 0) {
        lines.push(`      - ${remainingSuffix(locale, 'format.remainingEvidence', remainingEvidenceCount)}`);
      }
    } else {
      lines.push(`    evidence: ${evidence.length + remainingEvidenceCount} items (see Current state)`);
    }
  }
  if (summary.remainingClusterCount > 0) {
    lines.push(`  - ${remainingSuffix(locale, 'format.remainingClusters', summary.remainingClusterCount)}`);
  }
  if (summary.limitations.length > 0) {
    lines.push('Limitations:');
    for (const limitation of summary.limitations) {
      lines.push(`  - ${limitation}`);
    }
  }
  return lines;
}

function renderActionItemMarkdown(
  item: ActionItemView,
  options: { includeLinkedEvidence?: boolean; locale?: ReportLocale } = {},
): string[] {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const { intervention, linkedClusters, linkedEvidence, displayPaths, remainingPathCount } = item;
  const includeLinkedEvidence = options.includeLinkedEvidence ?? true;
  const pathSuffix = remainingPathCount > 0
    ? ` (${remainingSuffix(locale, 'format.remainingPaths', remainingPathCount)})`
    : '';
  const lines = [
    `### ${intervention.priority}. ${intervention.title}`,
    `- Rationale: ${intervention.rationale}`,
    `- First step: ${intervention.firstStep}`,
    `- Targets: ${displayPaths.join(', ') || 'n/a'}${pathSuffix}`,
    `- Verify: ${intervention.verification}`,
    `- Horizon: ${intervention.verificationHorizon}`,
  ];
  if (linkedClusters.length > 0) {
    lines.push(`- Linked clusters: ${linkedClusters.map((cluster) => cluster.clusterId).join(', ')}`);
  }
  if (includeLinkedEvidence && linkedEvidence.length > 0) {
    lines.push(`- Linked evidence: ${linkedEvidence.map((evidence) => evidence.evidenceId).join(', ')}`);
  }
  lines.push('');
  return lines;
}

function renderActionsMarkdown(
  model: ReportViewModel,
  heading = '## Improvement points',
  options: { includeLinkedEvidence?: boolean; locale?: ReportLocale } = {},
): string[] {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const lines = [heading, ''];
  for (const item of model.actions.items) {
    lines.push(...renderActionItemMarkdown(item, { ...options, locale }));
  }
  if (model.actions.remainingActionCount > 0) {
    lines.push(`- ${remainingSuffix(locale, 'format.remainingInterventions', model.actions.remainingActionCount)}`);
    lines.push('');
  }
  return lines;
}

function renderActionsConsole(
  model: ReportViewModel,
  heading = 'Improvement points',
  options: { includeLinkedEvidence?: boolean; locale?: ReportLocale } = {},
): string[] {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const lines = [heading];
  for (const item of model.actions.items) {
    const { intervention, linkedClusters, linkedEvidence, displayPaths, remainingPathCount } = item;
    const pathSuffix = remainingPathCount > 0
      ? ` (${remainingSuffix(locale, 'format.remainingPaths', remainingPathCount)})`
      : '';
    lines.push(`  - (${intervention.priority}) ${intervention.title}`);
    lines.push(`    rationale: ${intervention.rationale}`);
    lines.push(`    first step: ${intervention.firstStep}`);
    lines.push(`    targets: ${displayPaths.join(', ') || 'n/a'}${pathSuffix}`);
    lines.push(`    verify: ${intervention.verification}`);
    if (linkedClusters.length > 0) {
      lines.push(`    linked clusters: ${linkedClusters.map((cluster) => cluster.clusterId).join(', ')}`);
    }
    if ((options.includeLinkedEvidence ?? true) && linkedEvidence.length > 0) {
      lines.push(`    linked evidence: ${linkedEvidence.map((evidence) => evidence.evidenceId).join(', ')}`);
    }
  }
  if (model.actions.remainingActionCount > 0) {
    lines.push(`  - ${remainingSuffix(locale, 'format.remainingInterventions', model.actions.remainingActionCount)}`);
  }
  return lines;
}

function renderAllMarkdown(model: ReportViewModel, locale: ReportLocale = DEFAULT_LOCALE): string[] {
  const summaryLines = renderSummaryMarkdown(model, '## Diagnosis summary', { includeClusterEvidence: false, locale });
  const actionsLines = renderActionsMarkdown(model, '## Improvement points', { includeLinkedEvidence: false, locale });
  const factsLines = renderFactsMarkdown(model, '## Current state', locale);
  const limitationsStart = summaryLines.findIndex((line) => line === '## Limitations');
  const trimmedSummary = limitationsStart >= 0 ? summaryLines.slice(0, limitationsStart) : summaryLines;
  return [...trimmedSummary, ...actionsLines, ...factsLines];
}

function renderAllConsole(model: ReportViewModel, locale: ReportLocale = DEFAULT_LOCALE): string[] {
  const summaryLines = renderSummaryConsole(model, 'Diagnosis summary', { includeClusterEvidence: false, locale });
  const actionsLines = renderActionsConsole(model, 'Improvement points', { includeLinkedEvidence: false, locale });
  const factsLines = renderFactsConsole(model, 'Current state', locale);
  const limitationsIndex = summaryLines.findIndex((line) => line === 'Limitations:');
  const trimmedSummary = limitationsIndex >= 0 ? summaryLines.slice(0, limitationsIndex) : summaryLines;
  return [...trimmedSummary, '', ...actionsLines, '', ...factsLines];
}

function resolveViewModel(report: DiagnosisReport): ReportViewModel {
  return buildReportViewModel(report, DEFAULT_REPORT_VIEW_LIMITS);
}

export function formatJsonReport(report: DiagnosisReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatDiffJsonReport(diff: DiffReport): string {
  return `${JSON.stringify(diff, null, 2)}\n`;
}

export function formatConsoleReport(report: DiagnosisReport, options: FormatReportOptions = {}): string {
  const view = options.view ?? 'all';
  const locale = resolveFormatLocale(report, options);
  const model = resolveViewModel(report);
  const lines: string[] = [];

  switch (view) {
    case 'facts':
      lines.push(...renderFactsConsole(model, 'Current state', locale));
      break;
    case 'summary':
      lines.push(...renderSummaryConsole(model, 'Assessment summary', { locale }));
      break;
    case 'actions':
      lines.push(...renderActionsConsole(model, 'Improvement points', { locale }));
      break;
    case 'all':
      lines.push(...renderAllConsole(model, locale));
      break;
  }

  return `${lines.join('\n')}\n`;
}

export function formatMarkdownReport(report: DiagnosisReport, options: FormatReportOptions = {}): string {
  const view = options.view ?? 'all';
  const locale = resolveFormatLocale(report, options);
  const model = resolveViewModel(report);
  const lines = [...reportHeaderLines(report)];

  switch (view) {
    case 'facts':
      lines.push(...renderFactsMarkdown(model, '## Current state', locale));
      break;
    case 'summary':
      lines.push(...renderSummaryMarkdown(model, '## Assessment summary', { locale }));
      break;
    case 'actions':
      lines.push(...renderActionsMarkdown(model, '## Improvement points', { locale }));
      break;
    case 'all':
      lines.push(...renderAllMarkdown(model, locale));
      break;
  }

  return `${lines.join('\n')}\n`;
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

function diffSummaryLines(diff: DiffReport): string[] {
  const lines = ['Diff summary:'];
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
  return lines;
}

function diffSummaryMarkdown(diff: DiffReport, heading = '## Diff Comparison'): string[] {
  const lines = [heading, ''];
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
  return lines;
}

function renderDiffFactsConsole(diff: DiffReport, heading = 'Current state'): string[] {
  const lines = [heading, ...diffSummaryLines(diff), ''];
  for (const line of formatBlastRadiusConsoleLines(diff)) {
    lines.push(line === 'Blast radius:' ? `  ${line}` : `  ${line}`);
  }
  lines.push('');
  for (const line of formatSignalChangeConsoleLines(diff)) {
    lines.push(line === 'Signal changes:' ? `  ${line}` : `  ${line}`);
  }
  return lines;
}

function renderDiffFactsMarkdown(diff: DiffReport, heading = '## Current state'): string[] {
  const lines = [
    heading,
    '',
    ...diffSummaryMarkdown(diff, '### Diff comparison'),
    ...formatBlastRadiusMarkdownLines(diff),
    ...formatSignalChangeMarkdownLines(diff),
  ];
  return lines;
}

function renderDiffSummaryConsole(diff: DiffReport): string[] {
  const lines = [...diffSummaryLines(diff)];
  const changedClusters = diff.current.clusters.filter((cluster) =>
    cluster.evidenceIds.some((id) =>
      diff.comparison.newSignals.some((change) => change.evidenceId === id) ||
      diff.comparison.worsenedSignals.some((change) => change.evidenceId === id),
    ),
  );
  lines.push('  changed clusters:');
  if (changedClusters.length === 0) {
    lines.push('    - (none)');
  } else {
    for (const cluster of changedClusters.slice(0, 5)) {
      lines.push(`    - [${cluster.score}] ${cluster.title}`);
    }
  }
  return lines;
}

function renderDiffSummaryMarkdown(diff: DiffReport): string[] {
  const lines = [...diffSummaryMarkdown(diff), '### Changed clusters', ''];
  const changedClusters = diff.current.clusters.filter((cluster) =>
    cluster.evidenceIds.some((id) =>
      diff.comparison.newSignals.some((change) => change.evidenceId === id) ||
      diff.comparison.worsenedSignals.some((change) => change.evidenceId === id),
    ),
  );
  if (changedClusters.length === 0) {
    lines.push('- (none)');
  } else {
    for (const cluster of changedClusters.slice(0, 5)) {
      lines.push(`- [${cluster.score}] ${cluster.title} (${cluster.mechanismId})`);
    }
  }
  lines.push('');
  return lines;
}

function resolveChangedActionViewModel(diff: DiffReport): ReportViewModel {
  const changedEvidenceIds = new Set([
    ...diff.comparison.newSignals.map((item) => item.evidenceId),
    ...diff.comparison.worsenedSignals.map((item) => item.evidenceId),
  ]);
  const model = buildReportViewModel(diff.current, {
    ...DEFAULT_REPORT_VIEW_LIMITS,
    actionCount: diff.current.interventions.length,
  });
  const matching = model.actions.items.filter((item) =>
    item.linkedEvidence.some((evidence) => changedEvidenceIds.has(evidence.evidenceId)) ||
    item.linkedClusters.some((cluster) => cluster.evidenceIds.some((id) => changedEvidenceIds.has(id))),
  );
  const items = matching.slice(0, DEFAULT_REPORT_VIEW_LIMITS.actionCount);
  return {
    ...model,
    actions: {
      items,
      remainingActionCount: Math.max(0, matching.length - items.length),
    },
  };
}

function renderDiffActionsConsole(diff: DiffReport, locale: ReportLocale = DEFAULT_LOCALE): string[] {
  const model = resolveChangedActionViewModel(diff);
  const lines = ['Improvement points'];
  if (model.actions.items.length === 0) {
    lines.push('  - (none linked to changed risk)');
  } else {
    lines.push(...renderActionsConsole(model, 'Improvement points', { locale }).slice(1));
  }
  return lines;
}

function renderDiffActionsMarkdown(diff: DiffReport, locale: ReportLocale = DEFAULT_LOCALE): string[] {
  return renderActionsMarkdown(resolveChangedActionViewModel(diff), '## Improvement points', { locale });
}

function renderDiffAllConsole(diff: DiffReport, locale: ReportLocale = DEFAULT_LOCALE): string[] {
  const model = resolveViewModel(diff.current);
  return [
    ...renderSummaryConsole(model, 'Diagnosis summary', { includeClusterEvidence: false, locale }),
    '',
    ...renderDiffActionsConsole(diff, locale),
    '',
    ...renderDiffFactsConsole(diff),
  ];
}

function renderDiffAllMarkdown(diff: DiffReport, locale: ReportLocale = DEFAULT_LOCALE): string[] {
  const model = resolveViewModel(diff.current);
  return [
    ...renderSummaryMarkdown(model, '## Diagnosis summary', { includeClusterEvidence: false, locale }),
    ...renderDiffActionsMarkdown(diff, locale),
    ...renderDiffFactsMarkdown(diff),
  ];
}

export function formatDiffConsoleReport(diff: DiffReport, options: FormatReportOptions = {}): string {
  const view = options.view ?? 'all';
  const locale = resolveFormatLocale(diff.current, options);
  const lines: string[] = [];
  switch (view) {
    case 'facts':
      lines.push(...renderDiffFactsConsole(diff));
      break;
    case 'summary':
      lines.push(...renderDiffSummaryConsole(diff));
      break;
    case 'actions':
      lines.push(...renderDiffActionsConsole(diff, locale));
      break;
    case 'all':
      lines.push(...renderDiffAllConsole(diff, locale));
      break;
  }
  return `${lines.join('\n')}\n`;
}

export function formatDiffMarkdownReport(diff: DiffReport, options: FormatReportOptions = {}): string {
  const view = options.view ?? 'all';
  const locale = resolveFormatLocale(diff.current, options);
  const lines = [...reportHeaderLines(diff.current)];
  switch (view) {
    case 'facts':
      lines.push(...renderDiffFactsMarkdown(diff));
      break;
    case 'summary':
      lines.push(...renderDiffSummaryMarkdown(diff));
      break;
    case 'actions':
      lines.push(...renderDiffActionsMarkdown(diff, locale));
      break;
    case 'all':
      lines.push(...renderDiffAllMarkdown(diff, locale));
      break;
  }
  return `${lines.join('\n')}\n`;
}

export function formatReport(
  report: DiagnosisReport,
  format: 'json' | 'markdown' | 'console',
  options: FormatReportOptions = {},
): string {
  switch (format) {
    case 'json':
      return formatJsonReport(report);
    case 'markdown':
      return formatMarkdownReport(report, options);
    case 'console':
      return formatConsoleReport(report, options);
  }
}

export function formatDiffReport(
  diff: DiffReport,
  format: 'json' | 'markdown' | 'console',
  options: FormatReportOptions = {},
): string {
  switch (format) {
    case 'json':
      return formatDiffJsonReport(diff);
    case 'markdown':
      return formatDiffMarkdownReport(diff, options);
    case 'console':
      return formatDiffConsoleReport(diff, options);
  }
}

// Backward-compatible exports used by assessment output tests.
export { formatAxisScoreLabel };

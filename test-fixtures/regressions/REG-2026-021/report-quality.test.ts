import { describe, expect, it } from 'vitest';

import {
  formatJsonReport,
  formatMarkdownReport,
} from '../../../src/reporting/format.js';
import type { DiagnosisReport } from '../../../src/schema/report.v1.js';
import type { ReportView } from '../../../src/reporting/view-model.js';
import { buildDecisionReportFixture } from '../../../tests/fixtures/reporting/decision-report.fixture.js';

// REG-2026-021

const VIEW_LINE_LIMITS: Record<ReportView, number> = {
  facts: 180,
  summary: 100,
  actions: 120,
  all: 300,
};

const ALL_VIEW_CHAPTERS = [
  '## Diagnosis summary',
  '## Improvement points',
  '## Current state',
] as const;

type ReportQualityCheck = {
  name: string;
  passed: boolean;
};

function lineCount(markdown: string): number {
  return markdown.split('\n').length;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let position = 0;
  while ((position = haystack.indexOf(needle, position)) !== -1) {
    count += 1;
    position += needle.length;
  }
  return count;
}

function formatOldMarkdownMutant(report: DiagnosisReport): string {
  const lines = [
    '# r3-doctor Diagnosis Report',
    '',
    `- Regression Risk Score: ${report.repository.regressionRiskScore}`,
    '',
    '## Clusters',
    '',
  ];

  for (const cluster of report.clusters) {
    lines.push(`### ${cluster.title}`);
    lines.push(`- Score: ${cluster.score}`);
    lines.push(`- Mechanism: ${cluster.failureMechanism}`);
    for (const evidenceId of cluster.evidenceIds) {
      const item = report.evidence.find((entry) => entry.evidenceId === evidenceId);
      if (!item) {
        continue;
      }
      lines.push(`- \`${item.evidenceId}\` [${item.severity}] ${item.message}`);
    }
    lines.push('');
  }

  lines.push('## All evidence', '');
  for (const item of report.evidence) {
    lines.push(`- \`${item.evidenceId}\` [${item.severity}] ${item.message}`);
  }

  return `${lines.join('\n')}\n`;
}

function evaluateReportQuality(
  markdownByView: Record<ReportView, string>,
  report: DiagnosisReport,
  json: string,
): ReportQualityCheck[] {
  const parsed = JSON.parse(json) as DiagnosisReport;
  const allChapters = markdownByView.all.match(/^## (Diagnosis summary|Improvement points|Current state)$/gm) ?? [];

  return [
    {
      name: 'facts line limit (180)',
      passed: lineCount(markdownByView.facts) <= VIEW_LINE_LIMITS.facts,
    },
    {
      name: 'top actions present',
      passed:
        markdownByView.actions.includes('## Improvement points') &&
        /### 1\./.test(markdownByView.actions),
    },
    {
      name: 'calibration status shown',
      passed: /Calibration: (uncalibrated|provisional|validated)/.test(markdownByView.summary),
    },
    {
      name: 'four views selectable',
      passed: ['facts', 'summary', 'actions', 'all'].every((view) => markdownByView[view as ReportView].length > 0),
    },
    {
      name: 'all view has exactly three chapters once',
      passed:
        allChapters.length === 3 &&
        allChapters[0] === ALL_VIEW_CHAPTERS[0] &&
        allChapters[1] === ALL_VIEW_CHAPTERS[1] &&
        allChapters[2] === ALL_VIEW_CHAPTERS[2] &&
        countOccurrences(markdownByView.all, report.evidence[0]!.evidenceId) <= 1,
    },
    {
      name: 'JSON has all evidence IDs',
      passed: report.evidence.every((item) =>
        parsed.evidence.some((entry) => entry.evidenceId === item.evidenceId),
      ),
    },
  ];
}

function failingChecks(checks: ReportQualityCheck[]): ReportQualityCheck[] {
  return checks.filter((check) => !check.passed);
}

describe('REG-2026-021 report quality regression', () => {
  const report = buildDecisionReportFixture();

  it('old-format mutant fails the report quality contract', () => {
    const mutant = formatOldMarkdownMutant(report);
    const markdownByView: Record<ReportView, string> = {
      facts: mutant,
      summary: mutant,
      actions: mutant,
      all: mutant,
    };
    const failures = failingChecks(
      evaluateReportQuality(markdownByView, report, formatJsonReport(report)),
    );

    expect(failures.length).toBeGreaterThan(0);
    expect(
      failures.some((failure) =>
        ['facts line limit (180)', 'top actions present', 'calibration status shown'].includes(failure.name),
      ),
    ).toBe(true);
  });

  it('current implementation satisfies the report quality contract', () => {
    const markdownByView: Record<ReportView, string> = {
      facts: formatMarkdownReport(report, { view: 'facts' }),
      summary: formatMarkdownReport(report, { view: 'summary' }),
      actions: formatMarkdownReport(report, { view: 'actions' }),
      all: formatMarkdownReport(report, { view: 'all' }),
    };
    const failures = failingChecks(
      evaluateReportQuality(markdownByView, report, formatJsonReport(report)),
    );

    expect(failures).toEqual([]);
  });
});

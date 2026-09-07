import { describe, expect, it } from 'vitest';

// REG-2026-021

import {
  buildReportViewModel,
  DEFAULT_REPORT_VIEW_LIMITS,
} from '../src/reporting/view-model.js';
import {
  formatConsoleReport,
  formatJsonReport,
  formatMarkdownReport,
  formatReport,
} from '../src/reporting/format.js';
import { buildDecisionReportFixture } from './fixtures/reporting/decision-report.fixture.js';

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let position = 0;
  while ((position = haystack.indexOf(needle, position)) !== -1) {
    count += 1;
    position += needle.length;
  }
  return count;
}

describe('reporting views', () => {
  const report = buildDecisionReportFixture();

  it('builds a single view model with grouped facts, summary, and actions projections', () => {
    const model = buildReportViewModel(report, DEFAULT_REPORT_VIEW_LIMITS);

    expect(model.facts.totalEvidenceCount).toBe(70);
    expect(model.facts.factGroups).toHaveLength(1);
    expect(model.facts.factGroups[0]?.evidence).toHaveLength(5);
    expect(model.facts.factGroups[0]?.remainingEvidenceCount).toBe(65);
    expect(model.summary.clusters).toHaveLength(5);
    expect(model.summary.remainingClusterCount).toBe(2);
    expect(model.actions.items).toHaveLength(5);
    expect(model.actions.remainingActionCount).toBe(1);
    expect(model.summary.calibrationStatus).toBe('uncalibrated');
  });

  it('limits action evidence to the linked clusters', () => {
    const model = buildReportViewModel(report, DEFAULT_REPORT_VIEW_LIMITS);

    for (const action of model.actions.items) {
      const clusterEvidenceIds = new Set(
        action.linkedClusters.flatMap((cluster) => cluster.evidenceIds),
      );
      expect(action.linkedEvidence.length).toBeGreaterThan(0);
      expect(action.linkedEvidence.every((item) => clusterEvidenceIds.has(item.evidenceId))).toBe(true);
    }
  });

  it('includes raw metrics and strength in facts views', () => {
    const markdown = formatMarkdownReport(report, { view: 'facts' });
    const consoleOut = formatConsoleReport(report, { view: 'facts' });

    expect(markdown).toContain('strength=90');
    expect(markdown).toContain('metrics=cycleLength=2');
    expect(consoleOut).toContain('strength=90');
    expect(consoleOut).toContain('metrics=cycleLength=2');
  });

  it('REG-2026-021 renders bounded actionable views with calibration status', () => {
    const facts = formatMarkdownReport(report, { view: 'facts' });
    const summary = formatMarkdownReport(report, { view: 'summary' });
    const actions = formatMarkdownReport(report, { view: 'actions' });
    const all = formatMarkdownReport(report, { view: 'all' });

    expect(facts).toContain('## Current state');
    expect(facts).not.toContain('## Improvement points');
    expect(facts).not.toContain('Regression Risk Score');
    expect(facts).toContain('他 65 evidence');

    expect(summary).toContain('## Assessment summary');
    expect(summary).not.toContain('## Improvement points');
    expect(summary).not.toContain('## Evidence');
    expect(summary).toContain('Calibration: uncalibrated');
    expect(summary).toContain('## Top risk clusters');

    expect(actions).toContain('## Improvement points');
    expect(actions).not.toContain('## Current state');
    expect(actions).not.toContain('| Axis | Score |');
    expect(actions).toMatch(/Linked clusters: cluster:/);
    expect(actions).toMatch(/Linked evidence: evidence:/);

    expect(all.match(/^## (Diagnosis summary|Improvement points|Current state)$/gm))
      .toEqual(['## Diagnosis summary', '## Improvement points', '## Current state']);
    expect(countOccurrences(all, report.evidence[0]!.evidenceId)).toBeLessThanOrEqual(1);
  });

  it('returns full JSON regardless of view selection', () => {
    const json = formatReport(report, 'json', { view: 'facts' });
    const parsed = JSON.parse(json) as typeof report;

    expect(parsed.evidence).toHaveLength(70);
    expect(parsed.evidence.map((item) => item.evidenceId)).toContain(report.evidence[0]!.evidenceId);
    expect(parsed.interventions).toHaveLength(6);
    expect(formatJsonReport(report)).toBe(json);
  });

  it('documents the fixture contract in decision-report.md', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const fixtureDoc = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'reporting', 'decision-report.md'),
      'utf8',
    );

    expect(fixtureDoc).toContain('70 `Evidence` items');
    expect(fixtureDoc).toContain('6 interventions');
    expect(fixtureDoc).toContain('`all`');
  });
});

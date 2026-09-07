import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createRepositorySnapshot } from '../src/intake/snapshot.js';
import { runDiagnosis } from '../src/pipeline/diagnose.js';
import { diagnosisReportSchema } from '../src/schema/report.v1.js';
import { extractDeterministicEvidence } from '../src/evidence/deterministic.js';
import { buildInterventions } from '../src/recommendation/rules.js';
import { formatMarkdownReport, formatConsoleReport } from '../src/reporting/format.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.join(root, 'fixtures');

describe('scan pipeline', () => {
  it('produces valid report for stable fixture', async () => {
    const snapshot = await createRepositorySnapshot(path.join(fixturesRoot, 'stable-cart'));
    const report = await runDiagnosis(snapshot);
    expect(diagnosisReportSchema.safeParse(report).success).toBe(true);
    expect(report.repository.regressionRiskScore).toBeLessThanOrEqual(35);
    expect(report.repository.disclaimer).toContain('確率');
  });

  it('detects fragile patterns', async () => {
    const snapshot = await createRepositorySnapshot(path.join(fixturesRoot, 'fragile-cart'));
    const report = await runDiagnosis(snapshot);
    const signalIds = new Set(report.evidence.map((e) => e.signalId));
    expect(signalIds.has('dep-cycle')).toBe(true);
    expect(signalIds.has('missing-test-pair')).toBe(true);
    expect(report.clusters.length).toBeGreaterThanOrEqual(1);
    expect(report.interventions.length).toBeGreaterThan(0);
  });

  it('is deterministic for same input', async () => {
    const fixturePath = path.join(fixturesRoot, 'fragile-cart');
    const first = await runDiagnosis(await createRepositorySnapshot(fixturePath));
    const second = await runDiagnosis(await createRepositorySnapshot(fixturePath));
    expect(first.evidence).toEqual(second.evidence);
    expect(first.repository.regressionRiskScore).toBe(second.repository.regressionRiskScore);
  });

  it('does not include fixture dep-cycle when scanning repository root', async () => {
    const repoRoot = path.join(root, '..');
    const snapshot = await createRepositorySnapshot(repoRoot);
    const report = await runDiagnosis(snapshot);
    expect(report.evidence.some((item) => item.path?.includes('fragile-cart'))).toBe(false);
    expect(report.evidence.some((item) => item.path?.includes('tests/fixtures'))).toBe(false);
    expect(report.evidence.some((item) => item.path?.includes('test-fixtures'))).toBe(false);
  });

  it('links interventions to signals', async () => {
    const snapshot = await createRepositorySnapshot(path.join(fixturesRoot, 'fragile-cart'));
    const evidence = await extractDeterministicEvidence(snapshot);
    const report = await runDiagnosis(snapshot);
    const interventions = buildInterventions(evidence, report.clusters);
    for (const intervention of interventions) {
      expect(intervention.linkedSignalIds.length).toBeGreaterThan(0);
      expect(intervention.verification.length).toBeGreaterThan(0);
    }
  });

  it('renders markdown report', async () => {
    const snapshot = await createRepositorySnapshot(path.join(fixturesRoot, 'stable-cart'));
    const report = await runDiagnosis(snapshot);
    const markdown = formatMarkdownReport(report, { view: 'all' });
    expect(markdown).toContain('# r3-doctor Diagnosis Report');
    expect(markdown).toContain('## Diagnosis summary');
    expect(markdown).toContain('Regression Risk Score');
    expect(markdown).toContain('## Current state');
  });

  it('renders independent evidence sections in console output', async () => {
    const snapshot = await createRepositorySnapshot(path.join(fixturesRoot, 'fragile-cart'));
    const report = await runDiagnosis(snapshot);
    const consoleOut = formatConsoleReport(report, { view: 'all' });
    expect(consoleOut).toContain('Current state');
    expect(consoleOut).toContain('Grouped evidence');
    expect(consoleOut).toContain('semantic-ambiguity: LLM provider not configured');
  });
});

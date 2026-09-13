import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCalibration } from '../src/calibration/dataset.js';
import { resolveCalibrationQuality } from '../src/calibration/quality.js';
import { createRepositorySnapshot } from '../src/intake/snapshot.js';
import { runDiagnosis } from '../src/pipeline/diagnose.js';
import { formatMarkdownReport, formatDiffMarkdownReport } from '../src/reporting/format.js';
import { defaultLlmConfig } from '../src/shared/config.js';
import { buildDecisionReportFixture } from './fixtures/reporting/decision-report.fixture.js';
import type { DiffReport } from '../src/schema/report.v1.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
async function tempRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'r3-review-'));
  roots.push(root);
  await mkdir(path.join(root, '.r3-doctor'));
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function cli(args: string[]) {
  return execFileAsync(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), ...args], { maxBuffer: 4 * 1024 * 1024 });
}

describe('REG-2026-031 calibration read boundary', () => {
  it('rejects calibration symlinks without disclosing their target content', async () => {
    const root = await tempRepo();
    const outside = await tempRepo();
    await writeFile(path.join(outside, 'secret'), 'SECRET-CALIBRATION-CONTENT');
    await symlink(path.join(outside, 'secret'), path.join(root, '.r3-doctor/calibration.json'));
    const error = await loadCalibration(root, false, []).catch(error => error);
    expect(error.message).toContain('symbolic link');
    expect(error.message).not.toContain('SECRET-CALIBRATION-CONTENT');
  });
  it('bounds calibration JSON before parsing', async () => {
    const root = await tempRepo();
    await writeFile(path.join(root, '.r3-doctor/calibration.json'), ' '.repeat(2 * 1024 * 1024) + '{}');
    await expect(loadCalibration(root, false, [])).rejects.toThrow(/byte limit/);
  });
  it('does not echo malformed JSON or invalid enum values', async () => {
    const root = await tempRepo();
    const file = path.join(root, '.r3-doctor/calibration.json');
    for (const contents of ['SECRET-CALIBRATION-CONTENT', JSON.stringify({ schemaVersion: 1, records: [{scoreBand: 'SECRET-CALIBRATION-CONTENT'}], gateConditions: [], satisfiedConditions: [] })]) {
      await writeFile(file, contents);
      const error = await loadCalibration(root, false, []).catch(error => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toContain('SECRET-CALIBRATION-CONTENT');
    }
  });
  it('uses the standard policy path when omitted', async () => {
    const root = await tempRepo();
    await writeFile(path.join(root, '.r3-doctor/policy.json'), 'broken policy');
    await expect(resolveCalibrationQuality(root)).rejects.toThrow(/policy/);
  });
});

describe('REG-2026-032 CLI output and validation boundary', () => {
  it('emits exactly one setup JSON value when running the initial scan', async () => {
    const root = await tempRepo();
    await writeFile(path.join(root, 'a.ts'), 'export const a = 1;');
    const { stdout } = await cli(['setup', root, '--yes', '--json', '--scan', '--skip-llm']);
    expect(JSON.parse(stdout)).toMatchObject({ schemaVersion: 1, scanRan: true, errors: [] });
  }, 60_000);
  it.each([['--format', 'jsn', /invalid format/], ['--view', 'bogus', /expected one of/]] as const)('rejects %s before repository intake or semantic analysis', async (flag, value, message) => {
    const root = await tempRepo();
    await writeFile(path.join(root, 'r3-doctor.config.json'), 'invalid config should never be read');
    const error = await cli(['diff', root, '--base', 'HEAD', flag, value]).catch(error => error);
    expect(error.code).toBe(2);
    expect(error.stderr).toMatch(message);
    expect(error.stderr).not.toContain('config error');
  }, 60_000);
});

describe('REG-2026-033 semantic eligibility', () => {
  it('does not reduce risk when every returned finding is ineligible for scoring', async () => {
    const snapshot = await createRepositorySnapshot(path.resolve('tests/fixtures/fragile-cart'), undefined, { ...defaultLlmConfig, enabled: true, provider: 'codex', sendScope: 'all' });
    const diagnose = (findings: unknown[]) => runDiagnosis(snapshot, { skipCalibrationResolution: true, semanticProviderFactory: { create: () => ({ status: 'available', provider: { name: 'test', implementationVersion: '1', analyze: async () => findings } }) } });
    const empty = await diagnose([]);
    const noise = await diagnose([{ axisId: 'semantic-ambiguity', path: 'src/cart.ts', summary: 'Ungrounded observation', relatedEvidenceIds: [], confidence: 0.9 }]);
    expect(noise.semanticFindings).toHaveLength(1);
    expect(noise.axes.find(axis => axis.axisId === 'semantic-ambiguity')?.unevaluated).toBe(true);
    expect(noise.repository.regressionRiskScore).toBe(empty.repository.regressionRiskScore);
  });
});

describe('REG-2026-034 Markdown output boundary', () => {
  const attack = 'evil|![image](https://example.invalid/pixel)`\n# injected <img src=x>';
  it.each(['facts', 'summary', 'actions', 'all'] as const)('escapes repository text in %s without mutating report data', view => {
    const report = buildDecisionReportFixture();
    for (const item of report.evidence) { item.path = attack; item.message = attack; item.rationale = attack; item.metrics = { detail: attack }; }
    for (const cluster of report.clusters) { cluster.title = attack; cluster.paths = [attack]; cluster.triggerChanges = [attack]; }
    for (const item of report.interventions) { item.targetPaths = [attack]; item.title = attack; item.firstStep = attack; item.rationale = attack; item.verification = attack; }
    const before = JSON.stringify(report);
    const output = formatMarkdownReport(report, { view });
    expect(output).not.toContain('![image](');
    expect(output).not.toContain('<img');
    expect(output).not.toContain('\n# injected');
    expect(output).not.toContain('evil|');
    expect(JSON.stringify(report)).toBe(before);
  });
  it('escapes diff reasons, changed paths, signal messages and blast radius', () => {
    const diff: DiffReport = { schemaVersion: 3, current: buildDecisionReportFixture(), comparison: { compatible: false, reason: attack, changedFiles: [attack], blastRadius: [{ changedFile: attack, directDependents: [attack], directDependencies: [], transitiveDependents: [], transitiveDependencies: [], paths: [{ from: attack, to: attack }] }], newSignals: [], worsenedSignals: [], improvedSignals: [] } };
    const output = formatDiffMarkdownReport(diff, { view: 'all' });
    expect(output).not.toContain('![image](');
    expect(output).not.toContain('<img');
    expect(output).not.toContain('\n# injected');
    expect(output).not.toContain('evil|');
  });
});

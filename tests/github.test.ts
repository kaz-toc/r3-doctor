import { describe, expect, it } from 'vitest';

import { diffReportSchema } from '../src/schema/report.v1.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { formatGitHubAnnotations, writeGitHubSummaryFile } from '../src/reporting/github.js';

describe('github annotations', () => {
  it('emits workflow annotation lines for new and worsened signals', () => {
    const diff = diffReportSchema.parse({
      schemaVersion: 2,
      current: {
        metadata: {
          schemaVersion: 1,
          assessmentContractVersion: 3,
          generatedAt: '2026-01-01T00:00:00.000Z',
          inputId: 'c',
          repositoryPath: '/tmp',
          analyzers: [],
          truncated: false,
          unevaluatedAreas: [],
        },
        repository: { regressionRiskScore: 80, confidence: 0.9, disclaimer: 'd' },
        axes: [],
        clusters: [],
        evidence: [{
          evidenceId: 'evidence:dep-cycle:src/a.ts',
          signalId: 'dep-cycle',
          axisId: 'structural-fragility',
          path: 'src/a.ts',
          severity: 'high',
          message: 'cycle detected',
          source: 'deterministic',
        }],
        semanticFindings: [],
        interventions: [],
        capabilities: [],
      },
      base: {
        metadata: {
          schemaVersion: 1,
          assessmentContractVersion: 3,
          generatedAt: '2026-01-01T00:00:00.000Z',
          inputId: 'b',
          repositoryPath: '/tmp',
          analyzers: [],
          truncated: false,
          unevaluatedAreas: [],
        },
        repository: { regressionRiskScore: 50, confidence: 0.9, disclaimer: 'd' },
        axes: [],
        clusters: [],
        evidence: [],
        semanticFindings: [],
        interventions: [],
        capabilities: [],
      },
      comparison: {
        compatible: true,
        riskDelta: 30,
        baselineId: 'b',
        changedFiles: ['src/a.ts'],
        blastRadius: [],
        newSignals: [{
          evidenceId: 'evidence:dep-cycle:src/a.ts',
          signalId: 'dep-cycle',
          path: 'src/a.ts',
          currentSeverity: 'high',
          message: 'cycle detected',
        }],
        worsenedSignals: [],
        improvedSignals: [],
      },
    });

    const annotations = formatGitHubAnnotations(diff);
    expect(annotations).toBe('::error file=src/a.ts,line=1::r3-doctor: cycle detected (dep-cycle)\n');
  });

  it('emits a notice when comparison is incompatible', () => {
    const diff = diffReportSchema.parse({
      schemaVersion: 2,
      current: {
        metadata: {
          schemaVersion: 1,
          assessmentContractVersion: 3,
          generatedAt: '2026-01-01T00:00:00.000Z',
          inputId: 'c',
          repositoryPath: '/tmp',
          analyzers: [],
          truncated: false,
          unevaluatedAreas: [],
        },
        repository: { regressionRiskScore: 10, confidence: 1, disclaimer: 'd' },
        axes: [],
        clusters: [],
        evidence: [],
        semanticFindings: [],
        interventions: [],
        capabilities: [],
      },
      comparison: {
        compatible: false,
        reason: 'assessment contract mismatch',
        changedFiles: ['src/a.ts'],
        blastRadius: [],
        newSignals: [],
        worsenedSignals: [],
        improvedSignals: [],
      },
    });

    expect(formatGitHubAnnotations(diff)).toContain('::notice title=r3-doctor::assessment contract mismatch');
  });

  it('REG-2026-013 escapes untrusted workflow command data and properties onto one line', () => {
    const current = {
      metadata: {
        schemaVersion: 1,
        assessmentContractVersion: 3,
        generatedAt: '2026-01-01T00:00:00.000Z',
        inputId: 'c',
        repositoryPath: '/tmp',
        analyzers: [],
        truncated: false,
        unevaluatedAreas: [],
      },
      repository: { regressionRiskScore: 50, confidence: 0.9, disclaimer: 'd' },
      axes: [], clusters: [], semanticFindings: [], interventions: [], capabilities: [],
      evidence: [{
        evidenceId: 'evidence:dep-cycle:unsafe',
        signalId: 'dep-cycle',
        axisId: 'structural-fragility',
        severity: 'high',
        path: 'src/a:%\n::add-mask::TOKEN,\r.ts',
        message: 'bad %\n::error::forged\r',
        source: 'deterministic',
      }],
    };
    const base = {
      ...current,
      metadata: { ...current.metadata, inputId: 'b' },
      evidence: [],
    };
    const diff = diffReportSchema.parse({
      schemaVersion: 2,
      current,
      base,
      comparison: {
        compatible: true,
        baselineId: 'b',
        riskDelta: 0,
        changedFiles: [], blastRadius: [], worsenedSignals: [], improvedSignals: [],
        newSignals: [{
          evidenceId: 'evidence:dep-cycle:unsafe',
          signalId: 'dep-cycle',
          path: 'src/a:%\n::add-mask::TOKEN,\r.ts',
          currentSeverity: 'high',
          message: 'bad %\n::error::forged\r',
        }],
      },
    });

    expect(formatGitHubAnnotations(diff)).toBe(
      '::error file=src/a%3A%25%0A%3A%3Aadd-mask%3A%3ATOKEN%2C%0D.ts,line=1::r3-doctor: bad %25%0A::error::forged%0D (dep-cycle)\n',
    );
  });

  it('keeps untrusted CLI output off the Actions command channel', async () => {
    const workflow = await readFile(path.join(process.cwd(), '.github', 'workflows', 'r3-doctor-advisory.yml'), 'utf8');

    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).not.toContain('pull-requests: write');
    expect(workflow).toContain('timeout-minutes: 10');
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(2);
    expect(workflow).toContain('ref: ${{ github.event.pull_request.base.sha }}');
    expect(workflow).toContain('path: .r3-doctor-tool');
    expect(workflow).toContain('path: target');
    expect(workflow).toContain('npm ci --ignore-scripts');
    expect(workflow).not.toContain('npm run r3-doctor');
    expect(workflow).toContain('BASE_REF: ${{ github.event.pull_request.base.sha }}');
    expect(workflow).toContain('--base "$BASE_REF"');
    expect(workflow).toMatch(/--github-annotations[^\n]*\n\s*> "\$RUNNER_TEMP\/r3-doctor-report\.md" 2> "\$RUNNER_TEMP\/r3-doctor-diagnostics\.txt"/);
  });

  it('renders untrusted summary values as escaped single-line Markdown', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-github-summary-'));
    try {
      const output = path.join(dir, 'summary.md');
      const diff = diffReportSchema.parse({
        schemaVersion: 2,
        current: {
          metadata: {
            schemaVersion: 1,
            assessmentContractVersion: 3,
            generatedAt: '2026-01-01T00:00:00.000Z',
            inputId: 'c',
            repositoryPath: '/tmp',
            analyzers: [], truncated: false, unevaluatedAreas: [],
          },
          repository: { regressionRiskScore: 10, confidence: 1, disclaimer: 'd' },
          axes: [], clusters: [], evidence: [], semanticFindings: [], interventions: [], capabilities: [],
        },
        comparison: {
          compatible: false,
          reason: 'mismatch\n# forged <script>',
          changedFiles: ['safe\n# forged <script>[x](url)|.ts'],
          blastRadius: [], newSignals: [], worsenedSignals: [], improvedSignals: [],
        },
      });

      await writeGitHubSummaryFile(diff, output);
      const summary = await readFile(output, 'utf8');

      expect(summary).not.toContain('\n# forged');
      expect(summary).not.toContain('<script>');
      expect(summary).toContain('mismatch\\n\\# forged &lt;script&gt;');
      expect(summary).toContain('safe\\n\\# forged &lt;script&gt;\\[x\\]\\(url\\)\\|\\.ts');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

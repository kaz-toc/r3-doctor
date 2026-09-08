import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { runLlmInspect } from '../../src/commands/llm-inspect.js';
import { runSetup } from '../../src/setup/run.js';
import { checkReportSchema, setupReportSchema } from '../../src/setup/schema.js';
import { createGitRepository } from '../helpers/git-repository.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(root, '..', '..');
const execFileAsync = promisify(execFile);

function runCli(args: string[], options: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  const cliPath = path.join(repoRoot, 'src', 'cli.ts');
  const tsxPath = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return execFileAsync(process.execPath, [tsxPath, cliPath, ...args], {
    cwd: options.cwd,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function runCliWithExit(args: string[], options: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const cliPath = path.join(repoRoot, 'src', 'cli.ts');
  const tsxPath = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxPath, cliPath, ...args], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode,
      });
    });
  });
}

describe('llm inspect extraction', () => {
  it('returns structured stderr and exit code from runLlmInspect', async () => {
    const result = await runLlmInspect({ provider: 'codex', path: repoRoot });
    expect(result.stderr).toMatch(/^provider=codex status=(available|unavailable)/m);
    expect([0, 1, 2]).toContain(result.exitCode);
  });

  it('preserves CLI stderr shape for llm inspect', async () => {
    const { stderr, exitCode } = await runCliWithExit(['llm', 'inspect', '--provider', 'codex', '--path', repoRoot]);
    expect(stderr).toMatch(/^provider=codex status=(available|unavailable)/m);
    expect(exitCode).toBeGreaterThanOrEqual(0);
    expect(exitCode).toBeLessThanOrEqual(2);
  });
});

describe('check command', () => {
  it('emits JSON readiness report', async () => {
    const fixture = path.join(root, '..', 'fixtures', 'fragile-cart');
    const { stdout } = await runCli(['check', fixture, '--json', '--locale', 'en']);
    const report = checkReportSchema.parse(JSON.parse(stdout));
    expect(report.schemaVersion).toBe(1);
    expect(report.checks.node.ok).toBe(true);
    expect(report.locale).toBe('en');
  });

  it('check --json reports invalid config instead of crashing without --locale', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-check-bad-'));
    try {
      await writeFile(
        path.join(tempDir, 'r3-doctor.config.json'),
        JSON.stringify({ schemaVersion: 1, llm: { enabled: true } }),
        'utf8',
      );
      const { stdout } = await runCliWithExit(['check', tempDir, '--json']);
      const report = checkReportSchema.parse(JSON.parse(stdout));
      expect(report.checks.config.ok).toBe(false);
      expect(report.errors.length).toBeGreaterThan(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('REG-2026-023: check dirty warning includes the resolved baseline command', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      await repo.write('src/a.ts', 'export const a = 2;\n');
      const { stdout } = await runCli(['check', repo.path, '--json', '--locale', 'en']);
      const report = checkReportSchema.parse(JSON.parse(stdout));
      const dirtyWarning = report.warnings.find((warning) => warning.includes('uncommitted changes'));

      expect(dirtyWarning).toContain(`r3-doctor scan ${repo.path} --save-baseline`);
      expect(dirtyWarning).not.toContain('<path>');
    } finally {
      await repo.cleanup();
    }
  });
});

describe('setup command', () => {
  it('REG-2026-022: setup JSON omits forbidden llm keys and writes locale', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-setup-'));
    try {
      await writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'demo' }), 'utf8');
      const { stdout } = await runCli(['setup', tempDir, '--yes', '--json', '--locale', 'ja']);
      const report = setupReportSchema.parse(JSON.parse(stdout));
      expect(report.locale).toBe('ja');
      expect(report.configWritten).toBe(true);
      expect(report).not.toHaveProperty('llm');

      const config = JSON.parse(await readFile(path.join(tempDir, 'r3-doctor.config.json'), 'utf8')) as Record<string, unknown>;
      expect(config.locale).toBe('ja');
      expect(config).not.toHaveProperty('llm');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('prints Japanese human output with --locale ja', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-setup-ja-'));
    try {
      const { stdout } = await runCli(['setup', tempDir, '--yes', '--locale', 'ja']);
      expect(stdout).toContain('セットアップ');
      expect(stdout).toContain('次のステップ');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('dry-run does not write config', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-setup-dry-'));
    try {
      const { stdout } = await runCli(['setup', tempDir, '--yes', '--dry-run', '--locale', 'en']);
      const { stdout: jsonStdout } = await runCli(['setup', tempDir, '--yes', '--dry-run', '--json', '--locale', 'en']);
      const report = setupReportSchema.parse(JSON.parse(jsonStdout));
      expect(report.configWritten).toBe(false);
      expect(stdout).toContain('dry-run');
      await expect(readFile(path.join(tempDir, 'r3-doctor.config.json'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects setup --save-baseline without --scan', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-setup-scan-'));
    try {
      await expect(runCli(['setup', tempDir, '--yes', '--save-baseline'])).rejects.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('defaults --yes --json without --locale to en', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-setup-en-'));
    try {
      const { stdout } = await runCli(['setup', tempDir, '--yes', '--json']);
      const report = setupReportSchema.parse(JSON.parse(stdout));
      expect(report.locale).toBe('en');
      expect(report.scanRan).toBe(false);
      expect(report.baselineSaved).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('defers baseline save when setup writes config and completes scan without error', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const { stdout } = await runCli(['setup', repo.path, '--yes', '--scan', '--save-baseline', '--locale', 'en']);
      expect(stdout).toContain('scan completed');
      expect(stdout).not.toContain('error:');
      expect(stdout).toContain('baseline cannot be saved in this run');
      expect(stdout).toContain('--save-baseline');
    } finally {
      await repo.cleanup();
    }
  });

  it('marks baselineSaved false when baseline is deferred during setup run', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const report = await runSetup({
        repositoryPath: repo.path,
        locale: 'en',
        yes: true,
        dryRun: false,
        force: false,
        runScan: true,
        saveBaseline: true,
      });
      expect(report.scanRan).toBe(true);
      expect(report.baselineSaved).toBe(false);
      expect(report.warnings.some((warning) => warning.includes('baseline cannot be saved'))).toBe(true);
      expect(report.errors).toHaveLength(0);
    } finally {
      await repo.cleanup();
    }
  });
});

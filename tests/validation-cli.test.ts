import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { createGitRepository } from './helpers/git-repository.js';

const execFileAsync = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'src', 'cli.ts');
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function runCli(args: string[]) {
  return execFileAsync(process.execPath, [tsx, cli, ...args], { maxBuffer: 16 * 1024 * 1024 });
}

describe('validation CLI', () => {
  it('REG-2026-028 persists validation with a baseline and permits repeated recording without validation ignores', async () => {
    const repo = await createGitRepository({
      '.gitignore': '.r3-doctor/baselines/\n.r3-doctor/trends/\n',
      'src/a.ts': 'export const a = 1;\n',
    });
    try {
      const recorded = await runCli(['scan', repo.path, '--record-validation', '--save-baseline', '--format', 'json']);
      expect(JSON.parse(recorded.stdout).metadata.assessmentContractVersion).toBe(4);
      const sampleId = recorded.stderr.match(/^validation sample=([a-f0-9]{64}) status=created/m)?.[1];
      expect(sampleId).toMatch(/^[a-f0-9]{64}$/);
      expect(recorded.stderr).toContain('baseline saved:');

      const repeated = await runCli(['scan', repo.path, '--record-validation', '--format', 'json']);
      expect(JSON.parse(repeated.stdout).metadata.assessmentContractVersion).toBe(4);
      expect(repeated.stderr).toContain(`validation sample=${sampleId} status=unchanged`);
    } finally {
      await repo.cleanup();
    }
  }, 120_000);

  it('keeps plain scans read-only and records only when opted in', async () => {
    const repo = await createGitRepository({
      '.gitignore': '.r3-doctor/baselines/\n.r3-doctor/trends/\n.r3-doctor/validation/\n',
      'src/a.ts': 'export const a = 1;\n',
    });
    try {
      const plain = await runCli(['scan', repo.path, '--format', 'json']);
      expect(JSON.parse(plain.stdout).metadata.assessmentContractVersion).toBe(4);
      await expect(lstat(path.join(repo.path, '.r3-doctor', 'validation'))).rejects.toMatchObject({ code: 'ENOENT' });
      const recorded = await runCli(['scan', repo.path, '--record-validation', '--format', 'json']);
      expect(JSON.parse(recorded.stdout).metadata.assessmentContractVersion).toBe(4);
      expect(recorded.stderr).toMatch(/^validation sample=[a-f0-9]{64} status=created/m);
    } finally {
      await repo.cleanup();
    }
  }, 120_000);

  it('requires recording when a validation horizon is specified', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      await expect(runCli(['scan', repo.path, '--validation-horizon-days', '30'])).rejects.toThrow(/requires --record-validation/);
    } finally {
      await repo.cleanup();
    }
  });
});

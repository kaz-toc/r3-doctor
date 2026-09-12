import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('package build artifacts', () => {
  it(
    'cleans removed modules during prepack and emits the current runtime manifest',
    async () => {
    const stalePath = path.join(projectRoot, 'dist', 'shared', 'storage-paths.js');
    const cachePath = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-pack-cache-'));
    await mkdir(path.dirname(stalePath), { recursive: true });
    await writeFile(stalePath, 'export const stale = true;\n');
    const npmCli = process.env.npm_execpath;
    if (!npmCli) {
      throw new Error('npm_execpath is required to exercise the package build');
    }

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [npmCli, 'pack', '--dry-run', '--json', '--silent', '--cache', cachePath],
        { cwd: projectRoot, maxBuffer: 10 * 1024 * 1024 },
      );
      const manifest = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
      const packedPaths = manifest[0]?.files.map((file) => file.path) ?? [];
      const packageManifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as {
        bin?: Record<string, string>;
        dependencies?: Record<string, string>;
        private?: boolean;
        files?: string[];
      };

      await expect(lstat(stalePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(packedPaths).toContain('dist/cli.js');
      expect(packedPaths).toContain('dist/intake/analysis-context.js');
      expect(packedPaths).toContain('dist/validation/shadow-score.js');
      expect(packedPaths).not.toContain('dist/shared/storage-paths.js');
      expect(packedPaths).toContain('LICENSE');
      expect(packedPaths).toContain('README.md');
      expect(packedPaths).not.toContain('src/cli.ts');
      expect(packedPaths).toContain('tests/fixtures/golden/assessments.json');
      expect(packedPaths).toContain('tests/fixtures/stable-cart/src/cart.ts');
      expect(packedPaths.some((entry) => entry.startsWith('tests/') && !entry.startsWith('tests/fixtures/'))).toBe(false);
      expect(packedPaths.some((entry) => entry.startsWith('harness/'))).toBe(false);
      expect(packedPaths.some((entry) => entry.startsWith('scripts/'))).toBe(false);
      expect(packageManifest.bin?.['r3-doctor']).toBe('./dist/cli.js');
      expect(packageManifest.dependencies?.typescript).toBe('^5.7.3');
      expect(packageManifest.private).toBeUndefined();
      expect(packageManifest.files).toEqual(['dist', 'tests/fixtures', 'README.md', 'LICENSE']);
    } finally {
      await rm(cachePath, { recursive: true, force: true });
    }
  },
    60_000,
  );

  it(
    'REG-2026-001 runs golden calibration and policy evaluation from the packed artifact',
    async () => {
      const packageDir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-packed-runtime-'));
      const cachePath = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-pack-cache-'));
      const npmCli = process.env.npm_execpath;
      if (!npmCli) {
        throw new Error('npm_execpath is required to exercise the package build');
      }

      try {
        const { stdout } = await execFileAsync(
          process.execPath,
          [npmCli, 'pack', '--json', '--silent', '--pack-destination', packageDir, '--cache', cachePath],
          { cwd: projectRoot, maxBuffer: 10 * 1024 * 1024 },
        );
        const packed = JSON.parse(stdout) as Array<{ filename: string }>;
        const archivePath = path.join(packageDir, packed[0]?.filename ?? '');
        await execFileAsync('tar', ['-xzf', archivePath, '-C', packageDir]);
        const extractedRoot = path.join(packageDir, 'package');
        await symlink(path.join(projectRoot, 'node_modules'), path.join(extractedRoot, 'node_modules'), 'dir');
        const cliPath = path.join(extractedRoot, 'dist', 'cli.js');

        const golden = await execFileAsync(process.execPath, [cliPath, 'calibration', extractedRoot, '--golden']);
        const policy = await execFileAsync(process.execPath, [cliPath, 'policy', extractedRoot, '--evaluate']);
        const validationHelp = await execFileAsync(process.execPath, [cliPath, 'validation', '--help']);

        expect(JSON.parse(golden.stdout).passed).toBe(true);
        expect(JSON.parse(policy.stdout)).toHaveProperty('gateWouldFail');
        expect(validationHelp.stdout).toContain('status');
      } finally {
        await rm(packageDir, { recursive: true, force: true });
        await rm(cachePath, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

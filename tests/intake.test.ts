import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { computeInputId, createRepositorySnapshot, isExcluded, loadConfig } from '../src/intake/snapshot.js';
import { ConfigError, IntakeError } from '../src/shared/errors.js';
import { defaultConfig, defaultLlmConfig } from '../src/shared/config.js';

const execFileAsync = promisify(execFile);

describe('intake contract', () => {
  it('computes input ID from content hash and ignores clone path', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-intake-'));
    await writeFile(path.join(dir, 'a.ts'), 'export const x = 1;\n');
    const snapshotA = await createRepositorySnapshot(dir);
    const snapshotB = await createRepositorySnapshot(path.resolve(dir));
    expect(snapshotA.inputId).toBe(snapshotB.inputId);

    await writeFile(path.join(dir, 'a.ts'), 'export const x = 2;\n');
    const changed = await createRepositorySnapshot(dir);
    expect(changed.inputId).not.toBe(snapshotA.inputId);
    await rm(dir, { recursive: true, force: true });
  });

  it('uses segment and glob exclude rules', () => {
    expect(isExcluded('node_modules/pkg/index.ts', ['node_modules'])).toBe(true);
    expect(isExcluded('src/generated/foo.ts', ['generated'])).toBe(true);
    expect(isExcluded('src/generated/foo.ts', ['**/generated/**'])).toBe(true);
    expect(isExcluded('src/index.ts', ['node_modules'])).toBe(false);
  });

  it('treats regular-expression metacharacters as glob literals', () => {
    expect(isExcluded('src/file.ts', ['(src|lib)/*.ts'])).toBe(false);
    expect(isExcluded('(src|lib)/file.ts', ['(src|lib)/*.ts'])).toBe(true);
  });

  it('evaluates adversarial glob input within a bounded time', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        "import { isExcluded } from './src/intake/snapshot.ts'; isExcluded('a'.repeat(30) + 'XY', ['(a+)+?Z']); console.log('done');",
      ],
      { cwd: process.cwd(), timeout: 2_000 },
    );
    expect(stdout.trim()).toBe('done');
  });

  it('throws config error for invalid JSON config', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-config-'));
    await writeFile(path.join(dir, 'r3-doctor.config.json'), '{invalid');
    await expect(loadConfig(dir)).rejects.toBeInstanceOf(ConfigError);
    await rm(dir, { recursive: true, force: true });
  });

  it('uses defaults when config file is missing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-config-'));
    const config = await loadConfig(dir);
    expect(config).toEqual(defaultConfig);
    await rm(dir, { recursive: true, force: true });
  });

  it('applies operator-owned LLM policy when repository config is missing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-config-'));
    const operatorPolicy = {
      ...defaultLlmConfig,
      enabled: true,
      provider: 'codex' as const,
      sendScope: 'all' as const,
    };

    const config = await loadConfig(dir, operatorPolicy);

    expect(config.llm).toEqual(operatorPolicy);
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects LLM execution settings owned by the target repository', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-untrusted-llm-config-'));
    await writeFile(path.join(dir, 'r3-doctor.config.json'), JSON.stringify({
      schemaVersion: 1,
      llm: {
        enabled: true,
        provider: 'codex',
        executablePath: './tools/owned-by-repository.sh',
      },
    }));

    await expect(loadConfig(dir)).rejects.toBeInstanceOf(ConfigError);
    await rm(dir, { recursive: true, force: true });
  });

  it('bounds repository-controlled scan limits and glob sizes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-config-bounds-'));
    await writeFile(path.join(dir, 'r3-doctor.config.json'), JSON.stringify({
      schemaVersion: 1,
      exclude: ['x'.repeat(257)],
      maxFiles: 50_001,
    }));

    await expect(loadConfig(dir)).rejects.toBeInstanceOf(ConfigError);
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects unit roots that escape repository', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-unit-'));
    await writeFile(path.join(dir, 'r3-doctor.config.json'), JSON.stringify({
      schemaVersion: 1,
      units: [{ id: 'bad', roots: ['../outside'] }],
    }));
    await expect(createRepositorySnapshot(dir, 'bad')).rejects.toBeInstanceOf(IntakeError);
    await rm(dir, { recursive: true, force: true });
  });

  it('does not follow symbolic links', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-symlink-'));
    const srcDir = path.join(dir, 'src');
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, 'real.ts'), 'export const ok = true;\n');
    await symlink(path.join(srcDir, 'real.ts'), path.join(srcDir, 'linked.ts'));
    const snapshot = await createRepositorySnapshot(dir);
    expect(snapshot.files.some((file) => file.relativePath.endsWith('linked.ts'))).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it('reports unreadable files without failing scan collection', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-read-'));
    const srcDir = path.join(dir, 'src');
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, 'ok.ts'), 'export const ok = 1;\n');
    const snapshot = await createRepositorySnapshot(dir);
    expect(snapshot.files.length).toBeGreaterThan(0);
    expect(snapshot.inputId).toBe(computeInputId(undefined, snapshot.files, snapshot.config));
    await rm(dir, { recursive: true, force: true });
  });
});

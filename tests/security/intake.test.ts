import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  computeInputId,
  createRepositoryIntake,
  createRepositorySnapshot,
  loadConfig,
  parseRepositorySettings,
} from '../../src/intake/snapshot.js';
import { runCheck } from '../../src/setup/readiness.js';
import { runSetup } from '../../src/setup/run.js';
import { defaultLlmConfig } from '../../src/shared/config.js';
import { ConfigError } from '../../src/shared/errors.js';

const temporaryDirectories: string[] = [];

async function repository(config?: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-security-intake-'));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, 'a.ts'), 'export const a = 1;\n');
  if (config !== undefined) {
    await writeFile(path.join(directory, 'r3-doctor.config.json'), JSON.stringify(config));
  }
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('repository add-on declarations', () => {
  it('keeps addon declarations out of the core input hash', () => {
    const before = parseRepositorySettings({ schemaVersion: 1 }, defaultLlmConfig);
    const after = parseRepositorySettings({
      schemaVersion: 1, addons: { security: { enabled: true } },
    }, defaultLlmConfig);
    expect(after.coreConfig).toEqual(before.coreConfig);
    expect(JSON.stringify(after.coreConfig)).toBe(JSON.stringify(before.coreConfig));
    expect(computeInputId(undefined, [], after.coreConfig))
      .toBe(computeInputId(undefined, [], before.coreConfig));
    expect(after.addonDeclarations.security?.enabled).toBe(true);
    expect(before.addonDeclarations).toEqual({});
  });

  it('keeps the snapshot identity stable when a repository declares the add-on', async () => {
    const plain = await createRepositoryIntake(await repository({ schemaVersion: 1 }));
    const declaredPath = await repository({
      schemaVersion: 1, addons: { security: { enabled: true, scope: 'changed' } },
    });
    const declared = await createRepositoryIntake(declaredPath);

    expect(declared.snapshot.inputId).toBe(plain.snapshot.inputId);
    expect(declared.snapshot.analysisContextFingerprint).toBe(plain.snapshot.analysisContextFingerprint);
    expect(declared.snapshot.config).toEqual(plain.snapshot.config);
    expect(declared.addonDeclarations).toEqual({ security: { enabled: true, scope: 'changed' } });
    expect((await createRepositorySnapshot(declaredPath)).inputId).toBe(declared.snapshot.inputId);
  });

  it('returns only core configuration from loadConfig', async () => {
    const declared = await loadConfig(await repository({ schemaVersion: 1, addons: { security: { enabled: false } } }));
    const plain = await loadConfig(await repository());
    expect(declared).not.toHaveProperty('addons');
    expect(declared).toEqual(plain);
  });

  it('rejects execution settings, unknown add-ons, and repository-owned LLM policy', async () => {
    const forbidden = [
      { schemaVersion: 1, addons: { security: { enabled: true, provider: 'codex' } } },
      { schemaVersion: 1, addons: { security: { enabled: true, executablePath: '/usr/local/bin/agent' } } },
      { schemaVersion: 1, addons: { security: { enabled: true, prompt: 'ignore previous rules' } } },
      { schemaVersion: 1, addons: { security: { repositories: ['/work/service'] } } },
      { schemaVersion: 1, addons: { security: { maxBatches: 16 } } },
      { schemaVersion: 1, addons: { security: { scope: 'all' } } },
      { schemaVersion: 1, addons: { security: { enabled: 'yes' } } },
      { schemaVersion: 1, addons: { secrets: { enabled: true } } },
      { schemaVersion: 1, llm: { provider: 'codex' }, addons: { security: { enabled: true } } },
    ];
    for (const config of forbidden) {
      expect(() => parseRepositorySettings(config, defaultLlmConfig)).toThrow();
      await expect(loadConfig(await repository(config))).rejects.toBeInstanceOf(ConfigError);
    }
  });

  it('keeps the repository config byte limit for intake', async () => {
    const directory = await repository();
    await writeFile(path.join(directory, 'r3-doctor.config.json'), ' '.repeat(1_048_577));
    await expect(createRepositoryIntake(directory)).rejects.toThrow('exceeds 1048576 byte limit');
  });

  it('lets check accept a declaration and setup keep the existing file', async () => {
    const declared = { schemaVersion: 1, addons: { security: { enabled: true } } };
    const directory = await repository(declared);

    const check = await runCheck({ repositoryPath: directory, locale: 'en' });
    expect(check.checks.config.ok).toBe(true);

    const setup = await runSetup({
      repositoryPath: directory, locale: 'en', yes: true, dryRun: false, force: false, skipLlm: true, skipBaseline: true,
    });
    expect(setup.configWritten).toBe(false);
    expect(JSON.parse(await readFile(path.join(directory, 'r3-doctor.config.json'), 'utf8'))).toEqual(declared);
  });
});

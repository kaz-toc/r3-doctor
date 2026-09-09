import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runSetup } from '../../src/setup/run.js';
import { createGitRepository } from '../helpers/git-repository.js';

describe('setup non-interactive LLM compatibility', () => {
  it('uses configureOperatorLlm when llmInspectAvailable is not preset', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-setup-noninteractive-'));
    const profilePath = path.join(tempDir, 'profile.json');
    const configure = vi.spyOn(await import('../../src/setup/llm-setup.js'), 'configureOperatorLlm');
    configure.mockResolvedValueOnce({
      attempted: true,
      provider: 'codex',
      inspectAvailable: true,
      inspectDetail: '',
      profileWritten: false,
    });

    try {
      await runSetup({
        repositoryPath: tempDir,
        locale: 'en',
        yes: true,
        dryRun: true,
        force: false,
        configureLlm: true,
        llmProvider: 'codex',
        llmModel: 'gpt-5',
        profilePath,
        saveOperatorProfile: false,
      });
      expect(configure).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'codex',
        model: 'gpt-5',
        profilePath,
      }));
    } finally {
      configure.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('REG-2026-026: writes operator defaults to the requested profile path', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-setup-profile-'));
    const profilePath = path.join(tempDir, 'profiles', 'operator.json');
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'default-config');
    try {
      const report = await runSetup({
        repositoryPath: tempDir,
        locale: 'en',
        yes: true,
        dryRun: true,
        force: false,
        configureLlm: true,
        llmProvider: 'codex',
        llmModel: 'gpt-5',
        saveOperatorProfile: true,
        llmInspectAvailable: true,
        profilePath,
      });

      expect(report.operatorProfile?.profilePath).toBe(profilePath);
      expect(JSON.parse(await readFile(profilePath, 'utf8'))).toMatchObject({
        llm: { provider: 'codex', model: 'gpt-5' },
      });
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('REG-2026-026: uses the selected provider for the scan started by setup', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    const output: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const previousPath = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin';
    try {
      const setup = await runSetup({
        repositoryPath: repo.path,
        locale: 'en',
        yes: true,
        dryRun: false,
        force: false,
        runScan: true,
        configureLlm: true,
        llmProvider: 'codex',
        llmModel: 'gpt-5',
        saveOperatorProfile: false,
        llmInspectAvailable: true,
      });
      const scanReport = JSON.parse(output.join('')) as {
        metadata: { llmProvider?: string; semanticProviderStatus: string };
      };

      expect(setup.scanRan).toBe(true);
      expect(scanReport.metadata.llmProvider).toBe('codex');
      expect(scanReport.metadata.semanticProviderStatus).not.toBe('not-configured');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      stdout.mockRestore();
      await repo.cleanup();
    }
  });
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { configureOperatorLlm, saveSetupLlmProfile } from '../../src/setup/llm-setup.js';

describe('setup LLM profile', () => {
  it('saves provider defaults to operator profile without repository config', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-llm-setup-'));
    const profilePath = path.join(tempDir, 'profile.json');
    try {
      await saveSetupLlmProfile('codex', { profilePath });
      const profile = JSON.parse(await readFile(profilePath, 'utf8')) as Record<string, unknown>;
      expect(profile).toEqual({
        schemaVersion: 1,
        llm: {
          provider: 'codex',
          sendScope: 'changed',
        },
      });
      expect(profile).not.toHaveProperty('executablePath');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('writes profile only when inspect succeeds and saveProfile is true', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-llm-inspect-'));
    const profilePath = path.join(tempDir, 'profile.json');
    const inspect = vi.spyOn(await import('../../src/semantic/llm/inspect.js'), 'runLlmInspect');
    inspect.mockResolvedValueOnce({
      exitCode: 0,
      stderr: 'provider=codex status=available\n',
    });

    try {
      const report = await configureOperatorLlm({
        locale: 'en',
        repositoryPath: tempDir,
        provider: 'codex',
        saveProfile: true,
        profilePath,
      });
      expect(report.inspectAvailable).toBe(true);
      expect(report.profileWritten).toBe(true);
      expect(JSON.parse(await readFile(profilePath, 'utf8'))).toMatchObject({
        schemaVersion: 1,
        llm: { provider: 'codex', sendScope: 'changed' },
      });
    } finally {
      inspect.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('saves selected model and clears stale model on provider default', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-llm-model-'));
    const profilePath = path.join(tempDir, 'profile.json');
    try {
      await saveSetupLlmProfile('codex', { model: 'gpt-4.1', profilePath });
      expect(JSON.parse(await readFile(profilePath, 'utf8'))).toMatchObject({
        llm: { provider: 'codex', model: 'gpt-4.1', sendScope: 'changed' },
      });

      await saveSetupLlmProfile('claude', { profilePath });
      const profile = JSON.parse(await readFile(profilePath, 'utf8')) as Record<string, unknown> & {
        llm?: Record<string, unknown>;
      };
      expect(profile.llm?.provider).toBe('claude');
      expect(profile.llm).not.toHaveProperty('model');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not write profile when inspect fails', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-llm-fail-'));
    const profilePath = path.join(tempDir, 'profile.json');
    const inspect = vi.spyOn(await import('../../src/semantic/llm/inspect.js'), 'runLlmInspect');
    inspect.mockResolvedValueOnce({
      exitCode: 1,
      stderr: 'provider=codex status=unavailable reason=executable_missing\n',
    });

    try {
      const report = await configureOperatorLlm({
        locale: 'en',
        repositoryPath: tempDir,
        provider: 'codex',
        saveProfile: true,
        profilePath,
      });
      expect(report.inspectAvailable).toBe(false);
      expect(report.profileWritten).toBe(false);
      await expect(readFile(profilePath, 'utf8')).rejects.toThrow();
    } finally {
      inspect.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

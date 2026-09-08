import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { defaultOperatorProfilePath, loadOperatorProfile, operatorProfileSchema } from '../../src/operator/profile.js';
import { parseLlmExecutionPolicy } from '../../src/semantic/execution-policy.js';
import { resolveSetupLocale } from '../../src/setup/locale.js';

describe('operator profile', () => {
  it('loads profile JSON from a custom path', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-profile-'));
    const profilePath = path.join(tempDir, 'profile.json');
    try {
      await writeFile(profilePath, JSON.stringify({
        schemaVersion: 1,
        llm: { provider: 'codex', sendScope: 'changed' },
      }), 'utf8');
      const profile = await loadOperatorProfile(profilePath);
      expect(profile).toEqual(operatorProfileSchema.parse({
        schemaVersion: 1,
        llm: { provider: 'codex', sendScope: 'changed' },
      }));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns null when profile is missing', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-profile-missing-'));
    try {
      expect(await loadOperatorProfile(path.join(tempDir, 'missing.json'))).toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('defaultOperatorProfilePath resolves under XDG config home', () => {
    expect(defaultOperatorProfilePath()).toContain(`${path.sep}r3-doctor${path.sep}profile.json`);
  });
});

describe('parseLlmExecutionPolicy with operator profile', () => {
  it('merges profile defaults when CLI omits provider-specific flags', () => {
    const policy = parseLlmExecutionPolicy({}, false, {
      schemaVersion: 1,
      llm: { provider: 'codex', sendScope: 'changed', maxFiles: 5 },
    });
    expect(policy).toMatchObject({
      enabled: true,
      provider: 'codex',
      sendScope: 'changed',
      maxFiles: 5,
    });
  });

  it('CLI overrides profile defaults', () => {
    const policy = parseLlmExecutionPolicy({ llmProvider: 'claude' }, false, {
      schemaVersion: 1,
      llm: { provider: 'codex' },
    });
    expect(policy.provider).toBe('claude');
  });
});

describe('setup locale defaults', () => {
  it('defaults non-interactive setup to en without --locale', () => {
    const previous = process.env.LANG;
    process.env.LANG = 'ja_JP.UTF-8';
    try {
      expect(resolveSetupLocale({ nonInteractive: true })).toBe('en');
    } finally {
      process.env.LANG = previous;
    }
  });
});

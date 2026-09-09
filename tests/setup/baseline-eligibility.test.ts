import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BaselineSaveError } from '../../src/shared/errors.js';
import { baselineDirtyWorktreeMessage } from '../../src/persistence/baseline-messages.js';
import { assessBaselineSaveEligibility } from '../../src/setup/baseline-eligibility.js';
import { createGitRepository } from '../helpers/git-repository.js';

describe('assessBaselineSaveEligibility', () => {
  it('blocks baseline when setup will write config', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const result = await assessBaselineSaveEligibility(repo.path, { willWriteConfig: true });
      expect(result).toEqual({ eligible: false, reason: 'willWriteConfig' });
    } finally {
      await repo.cleanup();
    }
  });

  it('blocks baseline when worktree is dirty', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      await repo.write('src/a.ts', 'export const a = 2;\n');
      const result = await assessBaselineSaveEligibility(repo.path, { willWriteConfig: false });
      expect(result).toEqual({ eligible: false, reason: 'dirtyWorktree' });
    } finally {
      await repo.cleanup();
    }
  });

  it('allows baseline on clean git repository without config write', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export const a = 1;\n' });
    try {
      const result = await assessBaselineSaveEligibility(repo.path, { willWriteConfig: false });
      expect(result).toEqual({ eligible: true, reason: null });
    } finally {
      await repo.cleanup();
    }
  });

  it('REG-2026-023: preserves baseline support for repositories without Git', async () => {
    const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-non-git-'));
    try {
      const result = await assessBaselineSaveEligibility(repositoryPath, { willWriteConfig: false });
      expect(result).toEqual({ eligible: true, reason: null });
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});

describe('baseline save errors', () => {
  it('explains dirty worktree rejection with remediation', () => {
    expect(baselineDirtyWorktreeMessage('/tmp/repository')).toContain('uncommitted changes');
    expect(baselineDirtyWorktreeMessage('/tmp/repository')).toContain('--save-baseline');
  });

  it('uses BaselineSaveError instead of config error prefix', () => {
    const error = new BaselineSaveError(baselineDirtyWorktreeMessage('/tmp/repository'));
    expect(error.message).not.toContain('config error at');
    expect(error.message).toContain('scan may have completed');
  });
});

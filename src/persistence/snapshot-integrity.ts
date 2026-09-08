import { realpath } from 'node:fs/promises';

import { DefaultGitProvider } from '../adapters/git-provider.js';
import type { RepositorySnapshot } from '../intake/snapshot.js';
import type { DiagnosisReport } from '../schema/report.v1.js';
import { baselineDirtyWorktreeMessage, baselineWorktreeChangedMessage } from './baseline-messages.js';
import { BaselineSaveError, ConfigError } from '../shared/errors.js';

export async function assertSnapshotPersistenceIntegrity(
  snapshot: RepositorySnapshot,
  report: DiagnosisReport,
  options: { requireClean: boolean },
): Promise<string | undefined> {
  if (
    report.metadata.inputId !== snapshot.inputId ||
    report.metadata.repositoryPath !== snapshot.repositoryPath ||
    report.metadata.unitId !== snapshot.unitId
  ) {
    throw new ConfigError(snapshot.repositoryPath, 'diagnosis report does not match the repository snapshot');
  }

  if (!snapshot.gitAvailable) {
    const currentGit = await new DefaultGitProvider().inspectRepository(snapshot.repositoryPath);
    if (currentGit) {
      throw new ConfigError(snapshot.repositoryPath, 'Git repository state changed after repository intake');
    }
    return undefined;
  }
  if (!snapshot.sourceCommitSha) {
    throw new ConfigError(snapshot.repositoryPath, 'Git commit identity was not captured during intake');
  }
  if (options.requireClean && snapshot.gitDirty) {
    throw new BaselineSaveError(baselineDirtyWorktreeMessage());
  }

  const currentGit = await new DefaultGitProvider().inspectRepository(snapshot.repositoryPath);
  if (!currentGit) {
    throw new ConfigError(snapshot.repositoryPath, 'Git repository became unavailable after repository intake');
  }
  if (currentGit.rootPath !== await realpath(snapshot.repositoryPath)) {
    throw new ConfigError(snapshot.repositoryPath, 'Git repository root changed after repository intake');
  }
  if (currentGit.headSha !== snapshot.sourceCommitSha) {
    throw new ConfigError(snapshot.repositoryPath, 'Git HEAD changed after repository intake');
  }
  if (currentGit.statusFingerprint !== snapshot.gitStatusFingerprint) {
    throw new ConfigError(snapshot.repositoryPath, 'Git worktree state changed after repository intake');
  }
  if (options.requireClean && currentGit.dirty) {
    throw new BaselineSaveError(baselineWorktreeChangedMessage());
  }
  return snapshot.sourceCommitSha;
}

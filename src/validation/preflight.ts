import type { RepositorySnapshot } from '../intake/snapshot.js';
import type { DiagnosisReport } from '../schema/report.v1.js';
import { ConfigError } from '../shared/errors.js';
import { assertSnapshotPersistenceIntegrity } from '../persistence/snapshot-integrity.js';

export async function assertValidationRecordingAllowed(
  snapshot: RepositorySnapshot,
  report: DiagnosisReport,
): Promise<string> {
  if (!snapshot.gitAvailable) {
    throw new ConfigError(snapshot.repositoryPath, 'validation recording requires a Git repository');
  }
  if (!snapshot.sourceCommitSha) {
    throw new ConfigError(snapshot.repositoryPath, 'validation recording requires a Git commit SHA');
  }
  return (await assertSnapshotPersistenceIntegrity(snapshot, report, { requireClean: true })) ?? snapshot.sourceCommitSha;
}

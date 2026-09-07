import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import { DefaultGitProvider } from '../adapters/git-provider.js';
import type { RepositorySnapshot } from '../intake/snapshot.js';
import { loadPolicy } from '../operations/policy.js';
import type { DiagnosisReport, TrendEntry } from '../schema/report.v1.js';
import { trendEntrySchema } from '../schema/report.v1.js';
import { atomicAppendLine } from '../shared/atomic-write.js';
import { R3DoctorError } from '../shared/errors.js';
import { redactReport, redactStringList } from '../shared/redaction.js';
import type { PersistenceResult } from './retention.js';
import { retainTrendEntries } from './retention.js';
import { assertSnapshotPersistenceIntegrity } from './snapshot-integrity.js';
import { assertSafeStorageDir, resolveSafeStorageDir } from './storage-boundary.js';

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export async function loadTrendHistory(trendPath: string): Promise<TrendEntry[]> {
  let raw: string;
  try {
    const historyStat = await lstat(trendPath);
    if (historyStat.isSymbolicLink()) {
      throw new R3DoctorError(`refusing to read trend history through symbolic link: ${trendPath}`);
    }
    raw = await readFile(trendPath, 'utf8');
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }

  const entries: TrendEntry[] = [];
  const lines = raw.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    try {
      entries.push(trendEntrySchema.parse(JSON.parse(line)));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new R3DoctorError(`trend history parse error at line ${index + 1}: ${reason}`);
    }
  }
  return entries;
}

export async function appendTrend(snapshot: RepositorySnapshot, report: DiagnosisReport): Promise<PersistenceResult> {
  const commitSha = await assertSnapshotPersistenceIntegrity(snapshot, report, { requireClean: false });
  const policy = await loadPolicy(snapshot.repositoryPath, snapshot.config.policyFile);
  const cutoff = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000);
  const trendDir = await resolveSafeStorageDir(snapshot.repositoryPath, snapshot.config.trendDir, 'trendDir', true);
  const trendPath = path.join(trendDir.path, 'history.jsonl');
  const retention = [await retainTrendEntries(trendDir, cutoff)];
  const git = new DefaultGitProvider();
  const previousEntry = (await loadTrendHistory(trendPath)).at(-1);
  const changedFiles =
    snapshot.gitAvailable && previousEntry?.commitSha
      ? await git.listChangedFiles(snapshot.repositoryPath, previousEntry.commitSha)
      : [];

  const redacted = redactReport(report, policy.redactPaths);
  const entry = trendEntrySchema.parse({
    schemaVersion: 1,
    generatedAt: redacted.metadata.generatedAt,
    inputId: redacted.metadata.inputId,
    score: redacted.repository.regressionRiskScore,
    confidence: redacted.repository.confidence,
    contractVersion: redacted.metadata.assessmentContractVersion,
    commitSha,
    changedFiles: redactStringList(changedFiles, policy.redactPaths),
    topClusters: redacted.clusters.slice(0, 5).map((cluster) => ({
      clusterId: cluster.clusterId,
      score: cluster.score,
    })),
  });

  await atomicAppendLine(trendPath, JSON.stringify(entry), () => assertSafeStorageDir(trendDir));
  return { path: trendPath, retention };
}

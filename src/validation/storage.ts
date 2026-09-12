import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { RepositorySnapshot } from '../intake/snapshot.js';
import type { DiagnosisReport } from '../schema/report.v1.js';
import { atomicWriteFile } from '../shared/atomic-write.js';
import { readFileWithinByteLimit } from '../shared/bounded-file.js';
import { ConfigError } from '../shared/errors.js';
import { assertSnapshotPersistenceIntegrity } from '../persistence/snapshot-integrity.js';
import { assertSafeStorageDir, resolveSafeStorageDir, type SafeStorageDirectory } from '../persistence/storage-boundary.js';
import type { ShadowScore } from './shadow-score.js';
import { repositoryIdSchema, validationSnapshotV1Schema, type ValidationSnapshotV1 } from './schema.js';
import { buildValidationSnapshot } from './snapshot.js';

export const VALIDATION_DIRECTORY = '.r3-doctor/validation';
export const VALIDATION_FILE_MAX_BYTES = 256 * 1024;

export type SaveValidationSnapshotResult = {
  status: 'created' | 'unchanged';
  sample: ValidationSnapshotV1;
};

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function artifactPath(directory: SafeStorageDirectory, sampleId: string): string {
  return path.join(directory.path, `${sampleId}.json`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function withoutRecordTimes(sample: ValidationSnapshotV1): Record<string, unknown> {
  const { recordedAt: _recordedAt, dueAt: _dueAt, ...rest } = sample;
  return rest;
}

async function readStrictJson(
  filePath: string,
  displayName: string,
  schema: typeof validationSnapshotV1Schema,
): Promise<ValidationSnapshotV1> {
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new ConfigError(displayName, 'validation artifact must be a regular file');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFileWithinByteLimit(filePath, VALIDATION_FILE_MAX_BYTES, 'validation artifact'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(displayName, `malformed validation JSON: ${reason}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(displayName, `validation schema failed: ${result.error.message}`);
  }
  return result.data;
}

async function resolveSnapshots(repositoryPath: string, create: boolean): Promise<SafeStorageDirectory> {
  return resolveSafeStorageDir(repositoryPath, `${VALIDATION_DIRECTORY}/snapshots`, 'validation snapshots', create);
}

async function loadRepositoryId(validation: SafeStorageDirectory, create: boolean): Promise<string | null> {
  const identityPath = path.join(validation.path, 'repository-id');
  const identityStat = await lstat(identityPath).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (identityStat) {
    if (!identityStat.isFile() || identityStat.isSymbolicLink()) {
      throw new ConfigError('repository-id', 'repository identity must be a regular file');
    }
    const value = (await readFileWithinByteLimit(identityPath, 256, 'repository identity')).trim();
    const parsed = repositoryIdSchema.safeParse(value);
    if (!parsed.success) throw new ConfigError('repository-id', 'repository identity is malformed');
    return parsed.data;
  }
  if (!create) return null;
  const repositoryId = randomUUID();
  await atomicWriteFile(identityPath, `${repositoryId}\n`, () => assertSafeStorageDir(validation));
  return repositoryId;
}

export async function saveValidationSnapshot(input: {
  snapshot: RepositorySnapshot;
  report: DiagnosisReport;
  shadow: ShadowScore[];
  policyThresholds: { advisory: number; gate: number };
  horizonDays: number;
  recordedAt?: Date;
}): Promise<SaveValidationSnapshotResult> {
  await assertSnapshotPersistenceIntegrity(input.snapshot, input.report, { requireClean: true });
  const validation = await resolveSafeStorageDir(input.snapshot.repositoryPath, VALIDATION_DIRECTORY, 'validation', true);
  const repositoryId = await loadRepositoryId(validation, true);
  if (!repositoryId) throw new ConfigError('repository-id', 'repository identity could not be created');
  const sample = buildValidationSnapshot({
    ...input,
    repositoryId,
    recordedAt: input.recordedAt ?? new Date(),
  });
  const snapshots = await resolveSnapshots(input.snapshot.repositoryPath, true);
  await assertSafeStorageDir(validation);
  await assertSafeStorageDir(snapshots);
  const targetPath = artifactPath(snapshots, sample.sampleId);
  const existing = await lstat(targetPath).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (existing) {
    const stored = await readStrictJson(targetPath, `snapshots/${path.basename(targetPath)}`, validationSnapshotV1Schema);
    if (stored.sampleId !== sample.sampleId) {
      throw new ConfigError(`snapshots/${path.basename(targetPath)}`, 'snapshot filename does not match sample ID');
    }
    if (canonicalJson(withoutRecordTimes(stored)) !== canonicalJson(withoutRecordTimes(sample))) {
      throw new ConfigError(`snapshots/${path.basename(targetPath)}`, 'duplicate sample ID has different content');
    }
    return { status: 'unchanged', sample: stored };
  }
  await atomicWriteFile(targetPath, `${canonicalJson(sample)}\n`, async () => {
    await assertSafeStorageDir(validation);
    await assertSafeStorageDir(snapshots);
  });
  return { status: 'created', sample };
}

export async function loadValidationSnapshots(repositoryPath: string): Promise<ValidationSnapshotV1[]> {
  let snapshots: SafeStorageDirectory;
  try {
    snapshots = await resolveSnapshots(repositoryPath, false);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  await assertSafeStorageDir(snapshots);
  const names = (await readdir(snapshots.path)).sort();
  const values: ValidationSnapshotV1[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) {
      throw new ConfigError(`snapshots/${name}`, 'validation snapshots must use .json filenames');
    }
    const value = await readStrictJson(path.join(snapshots.path, name), `snapshots/${name}`, validationSnapshotV1Schema);
    if (name !== `${value.sampleId}.json`) {
      throw new ConfigError(`snapshots/${name}`, 'snapshot filename does not match sample ID');
    }
    values.push(value);
  }
  return values.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.sampleId.localeCompare(right.sampleId));
}

import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile } from '../shared/atomic-write.js';
import { readFileWithinByteLimit } from '../shared/bounded-file.js';
import { ConfigError } from '../shared/errors.js';
import { assertSafeStorageDir, resolveSafeStorageDir, type SafeStorageDirectory } from '../persistence/storage-boundary.js';
import { VALIDATION_DIRECTORY, VALIDATION_FILE_MAX_BYTES, loadValidationSnapshots } from './storage.js';
import {
  validationOutcomeV1Schema,
  type ValidationOutcomeKind,
  type ValidationOutcomeV1,
} from './schema.js';

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function withoutObservedAt(outcome: ValidationOutcomeV1): Record<string, unknown> {
  const { observedAt: _observedAt, ...rest } = outcome;
  return rest;
}

async function resolveOutcomes(repositoryPath: string, create: boolean): Promise<SafeStorageDirectory> {
  return resolveSafeStorageDir(repositoryPath, `${VALIDATION_DIRECTORY}/outcomes`, 'validation outcomes', create);
}

async function readOutcome(filePath: string, name: string): Promise<ValidationOutcomeV1> {
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new ConfigError(`outcomes/${name}`, 'validation outcome must be a regular file');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFileWithinByteLimit(filePath, VALIDATION_FILE_MAX_BYTES, 'validation outcome'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`outcomes/${name}`, `malformed validation JSON: ${reason}`);
  }
  const result = validationOutcomeV1Schema.safeParse(parsed);
  if (!result.success) throw new ConfigError(`outcomes/${name}`, `validation schema failed: ${result.error.message}`);
  if (name !== `${result.data.sampleId}.json`) {
    throw new ConfigError(`outcomes/${name}`, 'outcome filename does not match sample ID');
  }
  return result.data;
}

export async function saveValidationOutcome(
  repositoryPath: string,
  input: {
    sampleId: string;
    outcome: ValidationOutcomeKind;
    occurredAt?: string;
    incidentId?: string;
    observedAt?: Date;
  },
): Promise<{ status: 'created' | 'unchanged'; outcome: ValidationOutcomeV1 }> {
  const samples = await loadValidationSnapshots(repositoryPath);
  const sample = samples.find((entry) => entry.sampleId === input.sampleId);
  if (!sample) throw new ConfigError(`snapshots/${input.sampleId}.json`, 'validation sample does not exist');
  const observedAt = input.observedAt ?? new Date();
  const outcome = validationOutcomeV1Schema.parse({
    schemaVersion: 1,
    sampleId: input.sampleId,
    observedAt: observedAt.toISOString(),
    outcome: input.outcome,
    occurredAt: input.occurredAt,
    incidentId: input.incidentId,
  });
  const recorded = new Date(sample.recordedAt).getTime();
  const due = new Date(sample.dueAt).getTime();
  if (outcome.outcome === 'no-regression') {
    if (observedAt.getTime() < due) {
      throw new ConfigError(`outcomes/${input.sampleId}.json`, 'no-regression cannot be recorded before dueAt');
    }
  } else {
    const occurred = new Date(outcome.occurredAt!).getTime();
    if (occurred < recorded || occurred > due) {
      throw new ConfigError(`outcomes/${input.sampleId}.json`, 'occurredAt must be within the observation horizon');
    }
  }
  const outcomes = await resolveOutcomes(repositoryPath, true);
  const targetPath = path.join(outcomes.path, `${input.sampleId}.json`);
  const existing = await lstat(targetPath).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (existing) {
    const stored = await readOutcome(targetPath, path.basename(targetPath));
    const same = input.observedAt === undefined
      ? canonicalJson(withoutObservedAt(stored)) === canonicalJson(withoutObservedAt(outcome))
      : canonicalJson(stored) === canonicalJson(outcome);
    if (!same) {
      throw new ConfigError(`outcomes/${path.basename(targetPath)}`, 'validation outcome already exists with different content');
    }
    return { status: 'unchanged', outcome: stored };
  }
  await atomicWriteFile(targetPath, `${canonicalJson(outcome)}\n`, () => assertSafeStorageDir(outcomes));
  return { status: 'created', outcome };
}

export async function loadValidationOutcomes(repositoryPath: string): Promise<ValidationOutcomeV1[]> {
  let outcomes: SafeStorageDirectory;
  try {
    outcomes = await resolveOutcomes(repositoryPath, false);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  await assertSafeStorageDir(outcomes);
  const names = (await readdir(outcomes.path)).sort();
  const values: ValidationOutcomeV1[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) throw new ConfigError(`outcomes/${name}`, 'validation outcomes must use .json filenames');
    values.push(await readOutcome(path.join(outcomes.path, name), name));
  }
  return values.sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.sampleId.localeCompare(right.sampleId));
}

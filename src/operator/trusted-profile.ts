import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { readHandleWithinByteLimit } from '../shared/bounded-file.js';
import { R3DoctorError } from '../shared/errors.js';

import { defaultOperatorProfilePath, operatorProfileSchema, type OperatorProfile } from './profile.js';

export const OPERATOR_PROFILE_MAX_BYTES = 1_048_576;

export type TrustedProfileStat = {
  isFile: boolean;
  size: number;
  uid: number;
  mode: number;
};

/**
 * Returns why a profile cannot be trusted, or null. Ownership and mode are checked only when a POSIX
 * user ID is available; on Windows the operator-owned ACL is a documented trust assumption.
 */
export function trustedProfileStatIssue(
  stat: TrustedProfileStat,
  options: { currentUid: number | undefined; maxBytes: number },
): string | null {
  if (!stat.isFile) return 'must be a regular file';
  if (stat.size > options.maxBytes) return `exceeds ${options.maxBytes} byte limit`;
  if (options.currentUid === undefined) return null;
  if (stat.uid !== options.currentUid) return 'must not be owned by another user';
  if ((stat.mode & 0o022) !== 0) return 'must not be group- or world-writable';
  return null;
}

function currentPosixUid(): number | undefined {
  return process.platform === 'win32' ? undefined : process.getuid?.();
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown';
}

function isWithinOrSame(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function untrusted(profilePath: string, reason: string): never {
  throw new R3DoctorError(`untrusted operator profile at ${profilePath}: ${reason}`);
}

async function canonicalRepositoryRoots(roots: readonly string[]): Promise<string[]> {
  const canonical = await Promise.all(roots.map((root) => realpath(root).catch(() => undefined)));
  return [...new Set(canonical.filter((root): root is string => root !== undefined))];
}

async function readVerifiedProfile(handle: FileHandle, profilePath: string, leaf: { dev: number; ino: number }): Promise<string> {
  const before = await handle.stat();
  if (before.dev !== leaf.dev || before.ino !== leaf.ino) {
    untrusted(profilePath, 'changed while loading');
  }
  const issue = trustedProfileStatIssue(
    { isFile: before.isFile(), size: before.size, uid: before.uid, mode: before.mode },
    { currentUid: currentPosixUid(), maxBytes: OPERATOR_PROFILE_MAX_BYTES },
  );
  if (issue) {
    untrusted(profilePath, issue);
  }
  const raw = await readHandleWithinByteLimit(handle, OPERATOR_PROFILE_MAX_BYTES, 'operator profile');
  const after = await handle.stat();
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    untrusted(profilePath, 'changed while loading');
  }
  return raw;
}

/**
 * Loads the operator profile for a specific analyzed repository. The same checks apply to the default,
 * XDG, and explicit `--profile` paths: the profile must be a bounded regular file outside the analyzed
 * repository, reached without a leaf symlink. Only a missing default profile resolves to null.
 */
export async function loadTrustedOperatorProfile(input: {
  repositoryRoot: string;
  profilePath?: string;
}): Promise<OperatorProfile | null> {
  const explicit = input.profilePath !== undefined;
  const requested = path.resolve(input.profilePath ?? defaultOperatorProfilePath());

  let leaf: Awaited<ReturnType<typeof lstat>>;
  try {
    leaf = await lstat(requested);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') untrusted(requested, `cannot inspect profile (${errorCode(error)})`);
    if (explicit) throw new R3DoctorError(`operator profile not found at ${requested}`);
    return null;
  }
  if (leaf.isSymbolicLink()) {
    untrusted(requested, 'must not be a symbolic link');
  }
  if (!leaf.isFile()) {
    untrusted(requested, 'must be a regular file');
  }

  let canonicalProfile: string;
  let canonicalRoot: string;
  try {
    [canonicalProfile, canonicalRoot] = await Promise.all([realpath(requested), realpath(input.repositoryRoot)]);
  } catch (error) {
    untrusted(requested, `cannot resolve canonical path (${errorCode(error)})`);
  }
  if (isWithinOrSame(canonicalRoot, canonicalProfile)) {
    untrusted(requested, 'must not reside inside the analyzed repository');
  }

  let handle: FileHandle;
  try {
    // Do not wait for a FIFO writer if the leaf is replaced after lstat.
    handle = await open(canonicalProfile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    untrusted(requested, `cannot open profile (${errorCode(error)})`);
  }

  let raw: string;
  try {
    raw = await readVerifiedProfile(handle, requested, { dev: Number(leaf.dev), ino: Number(leaf.ino) });
  } catch (error) {
    if (error instanceof R3DoctorError) throw error;
    untrusted(requested, error instanceof Error ? error.message : String(error));
  } finally {
    await handle.close();
  }

  let profile: OperatorProfile;
  try {
    profile = operatorProfileSchema.parse(JSON.parse(raw));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new R3DoctorError(`invalid operator profile at ${requested}: ${reason}`);
  }

  const security = profile.addons?.security;
  if (!security) {
    return profile;
  }
  return {
    ...profile,
    addons: { ...profile.addons, security: { ...security, repositories: await canonicalRepositoryRoots(security.repositories) } },
  };
}

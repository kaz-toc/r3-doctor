import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { R3DoctorError } from './errors.js';

function canonicalPath(value: string): string {
  let candidate = path.resolve(value);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return path.join(realpathSync.native(candidate), ...missingSegments);
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return path.resolve(value);
      missingSegments.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

function isWithinOrSame(parent: string, candidate: string): boolean {
  const relative = path.relative(canonicalPath(parent), canonicalPath(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isWithinAny(untrustedDirectories: readonly string[], candidate: string): boolean {
  return untrustedDirectories.some((directory) => isWithinOrSame(directory, candidate));
}

export function sanitizeExecutableSearchPath(
  searchPath: string | undefined,
  untrustedDirectories: readonly string[],
): string | undefined {
  if (searchPath === undefined) return undefined;
  const safeEntries = searchPath
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry) && !isWithinAny(untrustedDirectories, entry));
  if (safeEntries.length === 0) {
    throw new R3DoctorError('executable search path contains no trusted absolute directory');
  }
  return safeEntries.join(path.delimiter);
}

export function validateExecutableCommand(command: string, untrustedDirectories: readonly string[]): string {
  if (path.isAbsolute(command)) {
    if (isWithinAny(untrustedDirectories, command)) {
      throw new R3DoctorError('provider executable must not resolve inside the analyzed repository');
    }
    return command;
  }
  if (command.includes('/') || command.includes('\\')) {
    throw new R3DoctorError('provider executable must be an absolute path or a bare command name');
  }
  return command;
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function searchCandidates(command: string, searchPath: string | undefined): string[] {
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  return (searchPath ?? '')
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry))
    .flatMap((entry) => extensions.map((extension) => path.join(entry, `${command}${extension}`)));
}

/**
 * Resolves a provider executable the way process spawning would, then rejects it when its canonical
 * target (after following symlinks) lies inside any untrusted directory. Returns undefined when no
 * executable file is found.
 */
export function resolveTrustedExecutable(
  command: string,
  searchPath: string | undefined,
  untrustedDirectories: readonly string[],
): string | undefined {
  const validated = validateExecutableCommand(command, untrustedDirectories);
  const candidates = path.isAbsolute(validated) ? [validated] : searchCandidates(validated, searchPath);
  const resolved = candidates.find(isExecutableFile);
  if (resolved && isWithinAny(untrustedDirectories, resolved)) {
    throw new R3DoctorError('provider executable must not resolve inside the analyzed repository');
  }
  return resolved;
}

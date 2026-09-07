import { realpathSync } from 'node:fs';
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

export function sanitizeExecutableSearchPath(
  searchPath: string | undefined,
  untrustedDirectory: string,
): string | undefined {
  if (searchPath === undefined) return undefined;
  const safeEntries = searchPath
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry) && !isWithinOrSame(untrustedDirectory, entry));
  if (safeEntries.length === 0) {
    throw new R3DoctorError('executable search path contains no trusted absolute directory');
  }
  return safeEntries.join(path.delimiter);
}

export function validateExecutableCommand(command: string, untrustedDirectory: string): string {
  if (path.isAbsolute(command)) {
    if (isWithinOrSame(untrustedDirectory, command)) {
      throw new R3DoctorError('provider executable must not resolve inside the analyzed repository');
    }
    return command;
  }
  if (command.includes('/') || command.includes('\\')) {
    throw new R3DoctorError('provider executable must be an absolute path or a bare command name');
  }
  return command;
}

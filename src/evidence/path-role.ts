import type { PathRole } from '../schema/report.v1.js';
import { isTestFile } from './diagnostic-paths.js';

const GENERATED_PREFIXES = ['dist/', 'build/', 'coverage/', 'out/', '.next/'];

export function classifyPathRole(relativePath: string, diagnosticSkipRoots: string[] = []): PathRole {
  const normalized = relativePath.replace(/\\/g, '/');

  if (isTestFile(normalized)) {
    return 'test';
  }

  if (normalized === 'vitest.config.ts') {
    return 'tooling';
  }

  if (normalized.startsWith('tests/fixtures/') || normalized === 'tests/fixtures') {
    return 'fixture';
  }

  if (normalized.startsWith('tests/') || normalized === 'tests') {
    return 'test';
  }

  for (const root of ['harness', 'scripts', ...diagnosticSkipRoots]) {
    if (normalized === root || normalized.startsWith(`${root}/`)) {
      return root === 'tests/fixtures' || root.startsWith('tests/fixtures') ? 'fixture' : 'tooling';
    }
  }

  if (GENERATED_PREFIXES.some((prefix) => normalized.startsWith(prefix)) || normalized.includes('/generated/')) {
    return 'generated';
  }

  return 'product';
}

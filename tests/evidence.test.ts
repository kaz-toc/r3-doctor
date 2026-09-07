import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createRepositorySnapshot } from '../src/intake/snapshot.js';
import { buildImportGraph, extractDeterministicEvidence, findImportCycles } from '../src/evidence/deterministic.js';

const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('deterministic evidence', () => {
  it('REG-2026-003 parses executable CommonJS and dynamic imports without matching comments or strings', () => {
    const sourceFile = (relativePath: string, content: string) => ({
      relativePath,
      absolutePath: path.join('/repo', relativePath),
      extension: path.extname(relativePath),
      content,
      contentHash: relativePath,
      nonBlankLines: 1,
    });
    const snapshot = {
      repositoryPath: '/repo',
      files: [
        sourceFile('src/main.ts', [
          "// import commented from './commented.js';",
          "const example = \"require('./string-only.js')\";",
          "const common = require('./common.js');",
          "const lazy = import('./lazy.js');",
        ].join('\n')),
        sourceFile('src/common.ts', 'export const common = true;'),
        sourceFile('src/lazy.ts', 'export const lazy = true;'),
      ],
    } as never;

    const edges = buildImportGraph(snapshot);

    expect(edges).toEqual([
      { from: 'src/main.ts', to: 'src/common.ts', kind: 'relative' },
      { from: 'src/main.ts', to: 'src/lazy.ts', kind: 'relative' },
    ]);
  });

  it.each(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'])('resolves directory index.%s imports', (extension) => {
    const snapshot = {
      repositoryPath: '/repo',
      files: [
        {
          relativePath: 'src/main.ts',
          absolutePath: '/repo/src/main.ts',
          extension: '.ts',
          content: "import './feature';",
          contentHash: 'main',
          nonBlankLines: 1,
        },
        {
          relativePath: `src/feature/index.${extension}`,
          absolutePath: `/repo/src/feature/index.${extension}`,
          extension: `.${extension}`,
          content: 'export const feature = true;',
          contentHash: extension,
          nonBlankLines: 1,
        },
      ],
    } as never;

    expect(buildImportGraph(snapshot)).toContainEqual({
      from: 'src/main.ts',
      to: `src/feature/index.${extension}`,
      kind: 'relative',
    });
  });

  it('finds simple two-node cycle', () => {
    const cycles = findImportCycles([
      { from: 'a.ts', to: 'b.ts', kind: 'relative' },
      { from: 'b.ts', to: 'a.ts', kind: 'relative' },
    ]);
    expect(cycles.length).toBeGreaterThan(0);
  });

  it('detects dependency cycle in fragile fixture', async () => {
    const snapshot = await createRepositorySnapshot(path.join(fixturesRoot, 'fragile-cart'));
    const edges = buildImportGraph(snapshot);
    expect(edges.some((edge) => edge.from.includes('pricing') && edge.to.includes('index'))).toBe(true);
    expect(edges.some((edge) => edge.from.includes('index') && edge.to.includes('pricing'))).toBe(true);
    const cycles = findImportCycles(edges);
    expect(cycles.length).toBeGreaterThan(0);
    const evidence = await extractDeterministicEvidence(snapshot);
    expect(evidence.some((item) => item.signalId === 'dep-cycle')).toBe(true);
  });

  it('does not flag missing-test-pair for src/intake/snapshot.ts in this repository', async () => {
    const snapshot = await createRepositorySnapshot(repoRoot);
    const evidence = await extractDeterministicEvidence(snapshot);
    expect(
      evidence.some((item) => item.signalId === 'missing-test-pair' && item.path === 'src/intake/snapshot.ts'),
    ).toBe(false);
  });

  it('does not emit unresolved-import from test files', async () => {
    const snapshot = await createRepositorySnapshot(repoRoot);
    const evidence = await extractDeterministicEvidence(snapshot);
    expect(
      evidence.some((item) => item.signalId === 'unresolved-import' && item.path === 'tests/diff.test.ts'),
    ).toBe(false);
  });
});

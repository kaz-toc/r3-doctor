import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createRepositorySnapshot } from '../src/intake/snapshot.js';
import { buildImportGraph, extractDeterministicEvidence, findImportCycles } from '../src/evidence/deterministic.js';
import { classifyPathRole } from '../src/evidence/path-role.js';
import {
  BINARY_SIGNAL_STRENGTH,
  buildNumericRationale,
  normalizeAboveThreshold,
  severityForStrength,
} from '../src/evidence/strength.js';

const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('strength normalization', () => {
  it('maps threshold onward values with v4-log2 monotonicity', () => {
    expect([5, 6, 8, 10, 15].map((value) => normalizeAboveThreshold(value, 5))).toEqual([25, 38, 59, 75, 100]);
  });

  it('returns zero below onset', () => {
    expect(normalizeAboveThreshold(4, 5)).toBe(0);
  });

  it.each([
    ['fan-out', 8],
    ['fan-in', 8],
    ['git-churn', 5],
  ] as const)('keeps %s strength monotonic as value increases', (_label, onset) => {
    const strengths = [onset, onset + 1, onset + 3, onset + 5, onset + 10].map((value) =>
      normalizeAboveThreshold(value, onset),
    );
    for (let index = 1; index < strengths.length; index += 1) {
      expect(strengths[index]).toBeGreaterThanOrEqual(strengths[index - 1]!);
    }
  });

  it('yields at least four distinct strengths across five onset-tier values', () => {
    const strengths = new Set([5, 6, 8, 10, 15].map((value) => normalizeAboveThreshold(value, 5)));
    expect(strengths.size).toBeGreaterThanOrEqual(4);
  });

  it('derives severity bands from strength', () => {
    expect(severityForStrength(90)).toBe('high');
    expect(severityForStrength(50)).toBe('medium');
    expect(severityForStrength(25)).toBe('low');
  });

  it('formats numeric rationale for audit replay', () => {
    expect(buildNumericRationale(10, 5)).toBe('value=10, onset=5, formula=v4-log2');
  });

  it('centralizes binary signal strengths', () => {
    expect(BINARY_SIGNAL_STRENGTH['dep-cycle']).toBe(90);
    expect(BINARY_SIGNAL_STRENGTH['unresolved-import']).toBe(65);
    expect(BINARY_SIGNAL_STRENGTH['missing-test-pair']).toBe(50);
    expect(BINARY_SIGNAL_STRENGTH['barrel-reexport']).toBe(30);
  });
});

describe('path role classification', () => {
  it('classifies product, test, and generated paths', () => {
    expect(classifyPathRole('src/cart.ts')).toBe('product');
    expect(classifyPathRole('tests/cart.test.ts')).toBe('test');
    expect(classifyPathRole('dist/cli.js')).toBe('generated');
  });
});

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

  it('stores import graph neighbors in relatedPaths', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-related-'));
    try {
      await mkdir(path.join(dir, 'src'), { recursive: true });
      await writeFile(
        path.join(dir, 'src', 'hub.ts'),
        `${Array.from({ length: 9 }, (_, index) => `import './m${index}.js';`).join('\n')}\nexport const hub = true;\n`,
      );
      for (let index = 0; index < 9; index += 1) {
        await writeFile(path.join(dir, 'src', `m${index}.ts`), `export const m${index} = ${index};\n`);
      }

      const snapshot = await createRepositorySnapshot(dir);
      const evidence = await extractDeterministicEvidence(snapshot);
      const fanOut = evidence.find((item) => item.signalId === 'high-fan-out' && item.path === 'src/hub.ts');

      expect(fanOut?.relatedPaths).toEqual([
        'src/m0.ts',
        'src/m1.ts',
        'src/m2.ts',
        'src/m3.ts',
        'src/m4.ts',
        'src/m5.ts',
        'src/m6.ts',
        'src/m7.ts',
        'src/m8.ts',
      ]);
      expect(fanOut?.rationale).toMatch(/formula=v4-log2/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('marks test path evidence with pathRole test', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-test-role-'));
    try {
      await mkdir(path.join(dir, 'tests'), { recursive: true });
      await writeFile(
        path.join(dir, 'tests', 'hub.test.ts'),
        Array.from({ length: 9 }, (_, index) => `import '../src/m${index}.js';`).join('\n'),
      );
      for (let index = 0; index < 9; index += 1) {
        await mkdir(path.join(dir, 'src'), { recursive: true });
        await writeFile(path.join(dir, 'src', `m${index}.ts`), `export const m${index} = ${index};\n`);
      }

      const snapshot = await createRepositorySnapshot(dir);
      const evidence = await extractDeterministicEvidence(snapshot);
      const testFanOut = evidence.find((item) => item.path === 'tests/hub.test.ts');

      expect(testFanOut?.pathRole).toBe('test');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records direct test coverage and skips missing-test-pair', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-direct-coverage-'));
    try {
      await mkdir(path.join(dir, 'src'), { recursive: true });
      await mkdir(path.join(dir, 'tests'), { recursive: true });
      await writeFile(path.join(dir, 'src', 'widget.ts'), 'export const widget = 1;\n');
      await writeFile(
        path.join(dir, 'tests', 'widget.test.ts'),
        "import { widget } from '../src/widget.js';\nexport const tested = widget;\n",
      );

      const snapshot = await createRepositorySnapshot(dir);
      const evidence = await extractDeterministicEvidence(snapshot);

      expect(evidence.some((item) => item.signalId === 'missing-test-pair' && item.path === 'src/widget.ts')).toBe(
        false,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records transitive test coverage with related test paths', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-transitive-coverage-'));
    try {
      await mkdir(path.join(dir, 'src'), { recursive: true });
      await mkdir(path.join(dir, 'tests'), { recursive: true });
      await writeFile(path.join(dir, 'src', 'widget.ts'), 'export const widget = 1;\n');
      await writeFile(path.join(dir, 'src', 'helper.ts'), "import { widget } from './widget.js';\nexport const helper = widget;\n");
      await writeFile(
        path.join(dir, 'tests', 'helper.test.ts'),
        "import { helper } from '../src/helper.js';\nexport const tested = helper;\n",
      );

      const snapshot = await createRepositorySnapshot(dir);
      const evidence = await extractDeterministicEvidence(snapshot);

      expect(evidence.some((item) => item.signalId === 'missing-test-pair' && item.path === 'src/widget.ts')).toBe(
        false,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('flags missing-test-pair only when direct and transitive coverage are absent', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-missing-coverage-'));
    try {
      await mkdir(path.join(dir, 'src'), { recursive: true });
      await writeFile(path.join(dir, 'src', 'orphan.ts'), 'export const orphan = 1;\n');

      const snapshot = await createRepositorySnapshot(dir);
      const evidence = await extractDeterministicEvidence(snapshot);
      const missing = evidence.find((item) => item.signalId === 'missing-test-pair' && item.path === 'src/orphan.ts');

      expect(missing).toMatchObject({
        strength: BINARY_SIGNAL_STRENGTH['missing-test-pair'],
        pathRole: 'product',
        rationale: expect.stringContaining('missing-test-pair'),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

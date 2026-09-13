import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { DefaultGitProvider } from '../src/adapters/git-provider.js';
import { buildImportGraph, extractDeterministicEvidence, findImportCycles, type ImportEdge } from '../src/evidence/deterministic.js';
import { createRepositorySnapshot } from '../src/intake/snapshot.js';
import { createGitRepository } from './helpers/git-repository.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

describe('REG-2026-029 bounded and faithful repository evidence', () => {
  it('finishes a dense acyclic import graph without enumerating every path', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval',
      `import { findImportCycles } from './src/evidence/deterministic.ts';
       const edges = [];
       for (let from = 0; from < 32; from += 1) {
         for (let to = from + 1; to < 32; to += 1) {
           edges.push({ from: String(from), to: String(to), kind: 'relative' });
         }
       }
       console.log(JSON.stringify(findImportCycles(edges)));`,
    ], { cwd: repositoryRoot, timeout: 10_000 });
    expect(JSON.parse(stdout)).toEqual([]);
  });

  it('reports one deterministic component for overlapping cycles and preserves self cycles', () => {
    const edges: ImportEdge[] = [
      { from: 'a.ts', to: 'b.ts', kind: 'relative' },
      { from: 'b.ts', to: 'a.ts', kind: 'relative' },
      { from: 'b.ts', to: 'c.ts', kind: 'relative' },
      { from: 'c.ts', to: 'b.ts', kind: 'relative' },
      { from: 'self.ts', to: 'self.ts', kind: 'relative' },
      { from: 'outside.ts', to: 'a.ts', kind: 'relative' },
      { from: 'a.ts', to: 'outside.ts', kind: 'package' },
    ];
    expect(findImportCycles(edges)).toEqual([['a.ts', 'b.ts', 'c.ts'], ['self.ts']]);
    expect(findImportCycles([...edges].reverse())).toEqual([['a.ts', 'b.ts', 'c.ts'], ['self.ts']]);
  });

  it('handles a deep import cycle without exhausting the JavaScript stack', () => {
    const edges: ImportEdge[] = Array.from({ length: 20_000 }, (_, index) => ({
      from: `${index}.ts`, to: `${(index + 1) % 20_000}.ts`, kind: 'relative',
    }));
    const cycles = findImportCycles(edges);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(20_000);
    expect(cycles[0]).toContain('19999.ts');
  });

  it.each(['link', 'link/src'])('rejects symlink unit root %s before collecting outside source', async (root) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-unit-boundary-'));
    const repository = path.join(directory, 'repository');
    const outside = path.join(directory, 'outside');
    try {
      await mkdir(repository);
      await mkdir(path.join(outside, 'src'), { recursive: true });
      await writeFile(path.join(outside, 'src', 'secret.ts'), 'export const privateSource = true;');
      await symlink(outside, path.join(repository, 'link'));
      await writeFile(path.join(repository, 'r3-doctor.config.json'), JSON.stringify({
        schemaVersion: 1, units: [{ id: 'unit', roots: [root] }],
      }));
      await expect(createRepositorySnapshot(repository, 'unit')).rejects.toThrow(/unit root.*symbolic link/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts an ordinary unit directory beginning with two dots', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-dot-unit-'));
    try {
      await mkdir(path.join(directory, '..sources'));
      await writeFile(path.join(directory, '..sources', 'a.ts'), 'export {};');
      await writeFile(path.join(directory, 'r3-doctor.config.json'), JSON.stringify({
        schemaVersion: 1, units: [{ id: 'unit', roots: ['..sources'] }],
      }));
      const snapshot = await createRepositorySnapshot(directory, 'unit');
      expect(snapshot.files.map((file) => file.relativePath)).toEqual(['..sources/a.ts']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('counts unique dependency modules for fan-out and fan-in', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-unique-imports-'));
    try {
      await writeFile(path.join(directory, 'r3-doctor.config.json'), JSON.stringify({
        schemaVersion: 1, fanOutThreshold: 1, fanInThreshold: 1,
      }));
      await writeFile(path.join(directory, 'a.ts'), [
        "import type { B } from './b';", "import { b } from './b.js';", "export { b } from './b';",
      ].join('\n'));
      await writeFile(path.join(directory, 'b.ts'), 'export type B = number; export const b = 1;');
      const snapshot = await createRepositorySnapshot(directory);
      expect(buildImportGraph(snapshot)).toEqual([{ from: 'a.ts', to: 'b.ts', kind: 'relative' }]);
      const evidence = await extractDeterministicEvidence(snapshot);
      expect(evidence.find((item) => item.signalId === 'high-fan-out')?.metrics).toEqual({ fanOut: 1 });
      expect(evidence.find((item) => item.signalId === 'high-fan-in')?.metrics).toEqual({ fanIn: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves Unicode, spaces, tabs, and newlines through Git churn evidence', async () => {
    const paths = ['src/with space.ts', 'src/日本語.ts', 'src/ tab\tname.ts', 'src/line\nname.ts'];
    const repository = await createGitRepository(Object.fromEntries(paths.map((file) => [file, 'export const n = 0;'])));
    try {
      for (let revision = 1; revision <= 4; revision += 1) {
        for (const file of paths) await repository.write(file, `export const n = ${revision};`);
        await repository.commit(`revision ${revision}`);
      }
      const churn = await new DefaultGitProvider().collectFileChurn(repository.path, 90);
      for (const file of paths) expect(churn.get(file)).toBe(5);
      const snapshot = await createRepositorySnapshot(repository.path);
      const evidence = await extractDeterministicEvidence(snapshot);
      for (const file of paths) {
        expect(evidence.find((item) => item.signalId === 'git-churn' && item.path === file)?.metrics)
          .toEqual({ churn: 5, days: 90 });
      }
    } finally {
      await repository.cleanup();
    }
  });

  it('skips oversized source with a visible intake issue and keeps ordinary source', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-source-limit-'));
    try {
      await writeFile(path.join(directory, 'oversized.js'), ' '.repeat(1_048_577));
      await writeFile(path.join(directory, 'ok.ts'), 'export {};');
      const snapshot = await createRepositorySnapshot(directory);
      expect(snapshot.files.map((file) => file.relativePath)).toEqual(['ok.ts']);
      expect(snapshot.intakeIssues).toContainEqual({
        kind: 'unreadable-file', path: 'oversized.js', message: 'source file exceeds 1048576 byte limit',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects source collection beyond the aggregate byte budget', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-source-total-limit-'));
    try {
      const content = ' '.repeat(1_048_576);
      for (let index = 0; index < 65; index += 1) {
        await writeFile(path.join(directory, `${index}.js`), content);
      }
      const result = await createRepositorySnapshot(directory)
        .then(() => 'collected beyond budget', (error: Error) => error.message);
      expect(result).toContain('source collection exceeded 67108864 byte limit');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

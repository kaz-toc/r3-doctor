import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HarnessConfigError,
  loadConfig,
  validateConfig,
} from '../config.mjs';
import {
  resolveRepositoryPath,
  toRepositoryPath,
  walkFiles,
} from '../paths.mjs';

const validConfig = {
  schemaVersion: 1,
  sourceRoots: ['src'],
  sourceExtensions: ['.ts', '.py'],
  excludeSegments: ['test', 'dist'],
  maxNonBlankLines: 800,
  regressionRoot: 'test-fixtures/regressions',
  requiredDocuments: ['AGENTS.md', 'ARCHITECTURE.md'],
  projectChecks: [],
};

async function temporaryRoot() {
  return mkdtemp(join(tmpdir(), 'harness-fixture-config-'));
}

test('loadConfig accepts a missing source root', async () => {
  const root = await temporaryRoot();
  await writeFile(join(root, 'harness.config.json'), JSON.stringify(validConfig));
  const config = await loadConfig(root);
  assert.deepEqual(config.sourceRoots, ['src']);
});

test('validateConfig rejects unsupported schema versions', async () => {
  const root = await temporaryRoot();
  assert.throws(
    () => validateConfig({ ...validConfig, schemaVersion: 2 }, root),
    (error) => error instanceof HarnessConfigError && /schemaVersion/.test(error.message),
  );
});

test('validateConfig rejects unsafe repository paths', async () => {
  const root = await temporaryRoot();
  for (const sourceRoot of ['/tmp/source', '../source']) {
    assert.throws(
      () => validateConfig({ ...validConfig, sourceRoots: [sourceRoot] }, root),
      HarnessConfigError,
    );
  }
});

test('validateConfig rejects duplicate entries', async () => {
  const root = await temporaryRoot();
  assert.throws(
    () => validateConfig({ ...validConfig, sourceExtensions: ['.ts', '.ts'] }, root),
    (error) => error instanceof HarnessConfigError && /duplicate/.test(error.message),
  );
});

test('validateConfig rejects invalid extensions and limits', async () => {
  const root = await temporaryRoot();
  assert.throws(
    () => validateConfig({ ...validConfig, sourceExtensions: ['ts'] }, root),
    HarnessConfigError,
  );
  assert.throws(
    () => validateConfig({ ...validConfig, maxNonBlankLines: 0 }, root),
    HarnessConfigError,
  );
});

test('loadConfig reports malformed JSON as a configuration error', async () => {
  const root = await temporaryRoot();
  await writeFile(join(root, 'harness.config.json'), '{');
  await assert.rejects(() => loadConfig(root), HarnessConfigError);
});

test('resolveRepositoryPath rejects traversal and maps safe paths', async () => {
  const root = await temporaryRoot();
  assert.equal(resolveRepositoryPath(root, 'src/a.ts'), join(root, 'src/a.ts'));
  assert.throws(() => resolveRepositoryPath(root, '../a.ts'), HarnessConfigError);
  assert.equal(toRepositoryPath(root, join(root, 'src/a.ts')), 'src/a.ts');
  assert.throws(() => toRepositoryPath(root, join(root, '..', 'a.ts')), HarnessConfigError);
});

test('walkFiles is lexical and does not follow symbolic links', async (t) => {
  const root = await temporaryRoot();
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await writeFile(join(root, 'src', 'z.ts'), '');
  await writeFile(join(root, 'src', 'a.ts'), '');
  await writeFile(join(root, 'src', 'nested', 'b.ts'), '');
  await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'outside', 'secret.ts'), '');
  try {
    await symlink(join(root, 'outside'), join(root, 'src', 'linked'));
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('symbolic links are unavailable');
      return;
    }
    throw error;
  }

  const files = await walkFiles(join(root, 'src'), { excludeSegments: ['nested'] });
  assert.deepEqual(files, [join(root, 'src', 'a.ts'), join(root, 'src', 'z.ts')]);
});


test('REG-2026-035 config errors identify invalid fields and paths and reject single backslashes', async () => {
  const root = await temporaryRoot();
  assert.throws(() => validateConfig({ ...validConfig, sourceRoots: [42] }, root), /sourceRoots must be/);
  assert.throws(() => validateConfig({ ...validConfig, sourceExtensions: ['.ts', '.ts'] }, root), /sourceExtensions contains a duplicate/);
  assert.throws(() => resolveRepositoryPath(root, '/private/source'), /\/private\/source/);
  assert.throws(() => resolveRepositoryPath(root, '../source'), /\.\.\/source/);
  assert.throws(() => validateConfig({ ...validConfig, excludeSegments: ['a\\b'] }, root), /path segments/);
});

import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { DefaultGitProvider } from '../src/adapters/git-provider.js';
import { createGitRepository } from './helpers/git-repository.js';

const execFileAsync = promisify(execFile);

const originalPath = process.env.PATH;
const originalArgsLog = process.env.R3_DOCTOR_TEST_GIT_ARGS;
const originalOpenAiKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalArgsLog === undefined) {
    delete process.env.R3_DOCTOR_TEST_GIT_ARGS;
  } else {
    process.env.R3_DOCTOR_TEST_GIT_ARGS = originalArgsLog;
  }
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
});

async function installFakeGit(output: string): Promise<{
  directory: string;
  repository: string;
  argsLog: string;
  envLog: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-fake-git-'));
  const binDirectory = path.join(directory, 'bin');
  const repository = path.join(directory, 'repository');
  await Promise.all([mkdir(binDirectory), mkdir(repository)]);
  const executable = path.join(binDirectory, 'git');
  const argsLog = path.join(directory, 'args.log');
  const envLog = path.join(directory, 'env.log');
  const outputFile = path.join(directory, 'output');
  await writeFile(outputFile, output);
  await writeFile(
    executable,
    `#!/bin/sh\nprintf '%s\\n' \"$@\" > '${argsLog}'\nprintf '%s\\n' \"\${OPENAI_API_KEY-}\" > '${envLog}'\ncat '${outputFile}'\n`,
  );
  await chmod(executable, 0o755);
  process.env.PATH = `${binDirectory}:${originalPath ?? ''}`;
  process.env.R3_DOCTOR_TEST_GIT_ARGS = argsLog;
  return { directory, repository, argsLog, envLog };
}

describe('git provider boundaries', () => {
  it('REG-2026-015 terminates rev-parse options before a caller-controlled ref', async () => {
    const fake = await installFakeGit('a'.repeat(40));
    try {
      await new DefaultGitProvider().resolveRef(fake.repository, 'main');
      const args = (await readFile(fake.argsLog, 'utf8')).trim().split('\n');
      expect(args).toEqual([
        '-c',
        'core.fsmonitor=false',
        'rev-parse',
        '--verify',
        '--end-of-options',
        'main^{commit}',
      ]);
    } finally {
      await rm(fake.directory, { recursive: true, force: true });
    }
  });

  it('rejects a leading-dash ref before invoking Git', async () => {
    await expect(new DefaultGitProvider().resolveRef(process.cwd(), '--quiet')).rejects.toThrow(
      'must not start with a dash',
    );
  });

  it('rejects non-object output from Git', async () => {
    const fake = await installFakeGit('not-an-object-id');
    try {
      await expect(new DefaultGitProvider().resolveRef(fake.repository, 'main')).rejects.toThrow(
        'full commit object ID',
      );
    } finally {
      await rm(fake.directory, { recursive: true, force: true });
    }
  });

  it('REG-2026-020 does not pass provider credentials to Git subprocesses', async () => {
    const fake = await installFakeGit('a'.repeat(40));
    process.env.OPENAI_API_KEY = 'must-not-reach-git';
    try {
      await new DefaultGitProvider().resolveRef(fake.repository, 'main');
      expect((await readFile(fake.envLog, 'utf8')).trim()).toBe('');
    } finally {
      await rm(fake.directory, { recursive: true, force: true });
    }
  });

  it('routes churn collection through the same sanitized Git boundary', async () => {
    const fake = await installFakeGit('src/a.ts\0\0src/a.ts\0src/b.ts\0');
    process.env.OPENAI_API_KEY = 'must-not-reach-git';
    try {
      const churn = await new DefaultGitProvider().collectFileChurn(fake.repository, 90);
      expect(churn).toEqual(new Map([['src/a.ts', 2], ['src/b.ts', 1]]));
      expect((await readFile(fake.envLog, 'utf8')).trim()).toBe('');
    } finally {
      await rm(fake.directory, { recursive: true, force: true });
    }
  });

  it('disables a repository-configured fsmonitor command', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export {};\n' });
    const marker = path.join(repo.path, 'fsmonitor-ran');
    const hook = path.join(repo.path, 'fsmonitor-hook');
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(hook, 0o755);
    await execFileAsync('git', ['config', 'core.fsmonitor', hook], { cwd: repo.path });
    try {
      await new DefaultGitProvider().inspectRepository(repo.path);
      const markerExists = await access(marker).then(() => true).catch(() => false);
      expect(markerExists).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  it('REG-2026-029 ignores only known untracked validation artifacts when checking repository integrity', async () => {
    const repo = await createGitRepository({ 'src/a.ts': 'export {};\n' });
    try {
      const provider = new DefaultGitProvider();
      const before = await provider.inspectRepository(repo.path);
      await repo.write('.r3-doctor/validation/repository-id', 'repository identity');
      await repo.write(`.r3-doctor/validation/snapshots/${'a'.repeat(64)}.json`, '{}');
      await repo.write(`.r3-doctor/validation/outcomes/${'b'.repeat(64)}.json`, '{}');
      const after = await provider.inspectRepository(repo.path);
      expect(before?.dirty).toBe(false);
      expect(after?.dirty).toBe(false);
      expect(after?.statusFingerprint).toBe(before?.statusFingerprint);
    } finally {
      await repo.cleanup();
    }
  });

  it.each([
    '.r3-doctor/validation/notes.json',
    '.r3-doctor/validation/snapshots/not-a-sample.json',
    '.r3-doctor/validation/src/feature.ts',
    'src/line\nname.ts',
  ])('REG-2026-029 preserves dirty status for unrelated untracked path %s', async (relativePath) => {
    const repo = await createGitRepository();
    try {
      await repo.write(relativePath, 'export {};');
      expect((await new DefaultGitProvider().inspectRepository(repo.path))?.dirty).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('REG-2026-029 retains modified tracked validation artifacts and staged rename records', async () => {
    const artifact = `.r3-doctor/validation/snapshots/${'a'.repeat(64)}.json`;
    const repo = await createGitRepository({ [artifact]: '{}', 'src/a.ts': 'export {};\n' });
    try {
      const provider = new DefaultGitProvider();
      await repo.write(artifact, '{"changed":true}');
      expect((await provider.inspectRepository(repo.path))?.dirty).toBe(true);
      await repo.commit('track validation change');
      const before = await provider.inspectRepository(repo.path);
      await execFileAsync('git', ['mv', 'src/a.ts', 'src/renamed.ts'], { cwd: repo.path });
      const after = await provider.inspectRepository(repo.path);
      expect(after?.dirty).toBe(true);
      expect(after?.statusFingerprint).not.toBe(before?.statusFingerprint);
    } finally {
      await repo.cleanup();
    }
  });

  it.each(['untracked', 'tracked'])('REG-2026-030 preserves %s changed paths with Unicode and leading whitespace', async (state) => {
    const repo = await createGitRepository();
    try {
      await repo.write('日本語.ts', 'export const n = 1;');
      await repo.write(' leading.ts', 'export const n = 1;');
      if (state === 'tracked') {
        await repo.commit('add unusual source paths');
        await repo.write('日本語.ts', 'export const n = 2;');
        await repo.write(' leading.ts', 'export const n = 2;');
      }
      expect(await new DefaultGitProvider().listChangedFiles(repo.path, repo.headSha))
        .toEqual([' leading.ts', '日本語.ts']);
    } finally {
      await repo.cleanup();
    }
  });
});

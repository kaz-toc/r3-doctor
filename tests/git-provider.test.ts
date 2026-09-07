import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DefaultGitProvider } from '../src/adapters/git-provider.js';

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
  await writeFile(
    executable,
    `#!/bin/sh\nprintf '%s\\n' \"$@\" > '${argsLog}'\nprintf '%s\\n' \"\${OPENAI_API_KEY-}\" > '${envLog}'\nprintf '%s\\n' '${output}'\n`,
  );
  await chmod(executable, 0o755);
  process.env.PATH = `${binDirectory}:${originalPath ?? ''}`;
  process.env.R3_DOCTOR_TEST_GIT_ARGS = argsLog;
  return { directory, repository, argsLog, envLog };
}

describe('git provider boundaries', () => {
  it('REG-2026-004 terminates rev-parse options before a caller-controlled ref', async () => {
    const fake = await installFakeGit('a'.repeat(40));
    try {
      await new DefaultGitProvider().resolveRef(fake.repository, 'main');
      const args = (await readFile(fake.argsLog, 'utf8')).trim().split('\n');
      expect(args).toEqual(['rev-parse', '--verify', '--end-of-options', 'main^{commit}']);
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

  it('REG-2026-009 does not pass provider credentials to Git subprocesses', async () => {
    const fake = await installFakeGit('a'.repeat(40));
    process.env.OPENAI_API_KEY = 'must-not-reach-git';
    try {
      await new DefaultGitProvider().resolveRef(fake.repository, 'main');
      expect((await readFile(fake.envLog, 'utf8')).trim()).toBe('');
    } finally {
      await rm(fake.directory, { recursive: true, force: true });
    }
  });
});

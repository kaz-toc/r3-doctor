import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DefaultGitProvider } from '../src/adapters/git-provider.js';

const originalPath = process.env.PATH;
const originalArgsLog = process.env.R3_DOCTOR_TEST_GIT_ARGS;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalArgsLog === undefined) {
    delete process.env.R3_DOCTOR_TEST_GIT_ARGS;
  } else {
    process.env.R3_DOCTOR_TEST_GIT_ARGS = originalArgsLog;
  }
});

async function installFakeGit(output: string): Promise<{ directory: string; argsLog: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-fake-git-'));
  const executable = path.join(directory, 'git');
  const argsLog = path.join(directory, 'args.log');
  await writeFile(
    executable,
    `#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$R3_DOCTOR_TEST_GIT_ARGS\"\nprintf '%s\\n' '${output}'\n`,
  );
  await chmod(executable, 0o755);
  process.env.PATH = `${directory}:${originalPath ?? ''}`;
  process.env.R3_DOCTOR_TEST_GIT_ARGS = argsLog;
  return { directory, argsLog };
}

describe('git provider boundaries', () => {
  it('terminates rev-parse options before a caller-controlled ref', async () => {
    const fake = await installFakeGit('a'.repeat(40));
    try {
      await new DefaultGitProvider().resolveRef(fake.directory, '--quiet');
      const args = (await readFile(fake.argsLog, 'utf8')).trim().split('\n');
      expect(args).toEqual(['rev-parse', '--verify', '--end-of-options', '--quiet^{commit}']);
    } finally {
      await rm(fake.directory, { recursive: true, force: true });
    }
  });

  it('rejects non-object output from Git', async () => {
    const fake = await installFakeGit('not-an-object-id');
    try {
      await expect(new DefaultGitProvider().resolveRef(fake.directory, 'main')).rejects.toThrow(
        'full commit object ID',
      );
    } finally {
      await rm(fake.directory, { recursive: true, force: true });
    }
  });
});

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadOperatorProfile, saveOperatorProfile } from '../../src/operator/profile.js';
import { loadTrustedOperatorProfile, trustedProfileStatIssue } from '../../src/operator/trusted-profile.js';
import { saveSetupLlmProfile } from '../../src/setup/llm-setup.js';

const posix = process.platform !== 'win32';
const runsAsRoot = posix && process.getuid?.() === 0;
const execFileAsync = promisify(execFile);

let rawBase: string;
let base: string;
let previousXdg: string | undefined;

beforeEach(async () => {
  rawBase = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-trusted-profile-'));
  base = await realpath(rawBase);
  previousXdg = process.env.XDG_CONFIG_HOME;
});

afterEach(async () => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  await chmod(path.join(base, 'locked'), 0o700).catch(() => undefined);
  await rm(base, { recursive: true, force: true });
});

async function layout(profile: unknown = { schemaVersion: 1 }) {
  const repositoryRoot = path.join(base, 'repo');
  const operatorDirectory = path.join(base, 'operator');
  await mkdir(repositoryRoot, { recursive: true });
  await mkdir(operatorDirectory, { recursive: true });
  const profilePath = path.join(operatorDirectory, 'profile.json');
  await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
  await chmod(profilePath, 0o600);
  return { repositoryRoot, operatorDirectory, profilePath };
}

describe('trusted operator profile loading', () => {
  it('loads a profile and keeps only canonical, existing allowed roots', async () => {
    const { repositoryRoot, profilePath } = await layout();
    const alias = path.join(base, 'alias');
    await symlink(base, alias);
    await writeFile(profilePath, JSON.stringify({
      schemaVersion: 1,
      llm: { provider: 'codex' },
      addons: {
        security: {
          enabled: true,
          repositories: [path.join(alias, 'repo'), path.join(base, 'missing'), repositoryRoot],
        },
      },
    }));

    const profile = await loadTrustedOperatorProfile({ repositoryRoot, profilePath });

    expect(profile?.llm?.provider).toBe('codex');
    expect(profile?.addons?.security?.repositories).toEqual([repositoryRoot]);
  });

  it('canonicalizes operating-system parent symlinks instead of rejecting them', async () => {
    await layout();
    const profile = await loadTrustedOperatorProfile({
      repositoryRoot: path.join(rawBase, 'repo'),
      profilePath: path.join(rawBase, 'operator', 'profile.json'),
    });
    expect(profile).toEqual({ schemaVersion: 1 });
  });

  it('returns null only when the default profile is missing', async () => {
    const { repositoryRoot } = await layout();
    process.env.XDG_CONFIG_HOME = path.join(base, 'xdg-missing');
    await expect(loadTrustedOperatorProfile({ repositoryRoot })).resolves.toBeNull();
    await expect(loadTrustedOperatorProfile({ repositoryRoot, profilePath: path.join(base, 'missing.json') }))
      .rejects.toThrow(/not found/);
  });

  it('rejects profiles inside the analyzed repository, directly or through a parent symlink', async () => {
    const { repositoryRoot } = await layout();
    await writeFile(path.join(repositoryRoot, 'profile.json'), JSON.stringify({ schemaVersion: 1 }), { mode: 0o600 });
    await chmod(path.join(repositoryRoot, 'profile.json'), 0o600);
    await symlink(repositoryRoot, path.join(base, 'repo-link'));

    for (const profilePath of [path.join(repositoryRoot, 'profile.json'), path.join(base, 'repo-link', 'profile.json')]) {
      await expect(loadTrustedOperatorProfile({ repositoryRoot, profilePath }))
        .rejects.toThrow(/inside the analyzed repository/);
    }
    process.env.XDG_CONFIG_HOME = repositoryRoot;
    await mkdir(path.join(repositoryRoot, 'r3-doctor'));
    await writeFile(path.join(repositoryRoot, 'r3-doctor', 'profile.json'), JSON.stringify({ schemaVersion: 1 }));
    await expect(loadTrustedOperatorProfile({ repositoryRoot })).rejects.toThrow(/inside the analyzed repository/);
  });

  it('rejects a leaf symlink even when it points outside the repository', async () => {
    const { repositoryRoot, operatorDirectory, profilePath } = await layout();
    const linkPath = path.join(operatorDirectory, 'link.json');
    await symlink(profilePath, linkPath);
    await expect(loadTrustedOperatorProfile({ repositoryRoot, profilePath: linkPath })).rejects.toThrow(/symbolic link/);
  });

  it('rejects non-regular files, oversized files, and invalid schemas', async () => {
    const { repositoryRoot, operatorDirectory, profilePath } = await layout();
    await expect(loadTrustedOperatorProfile({ repositoryRoot, profilePath: operatorDirectory })).rejects.toThrow(/regular file/);

    await writeFile(profilePath, JSON.stringify({ schemaVersion: 1, addons: { security: { repositories: ['relative'] } } }));
    await expect(loadTrustedOperatorProfile({ repositoryRoot, profilePath })).rejects.toThrow(/invalid operator profile/);

    await writeFile(profilePath, ' '.repeat(1_048_577));
    await expect(loadTrustedOperatorProfile({ repositoryRoot, profilePath })).rejects.toThrow(/byte limit/);
  });

  it.runIf(posix).each([
    { scenario: 'already a FIFO', replaceBeforeOpen: false, reason: 'regular file' },
    { scenario: 'replaced with a FIFO after lstat', replaceBeforeOpen: true, reason: 'changed while loading' },
  ])('REG-2026-028: rejects a profile $scenario without waiting for a writer', async ({ replaceBeforeOpen, reason }) => {
    const { repositoryRoot, profilePath } = await layout();
    if (!replaceBeforeOpen) {
      await rm(profilePath);
      await execFileAsync('mkfifo', [profilePath]);
    }

    // A separate process lets the regression fail on timeout without leaving a blocked filesystem worker.
    const script = `
      import fs from 'node:fs/promises';
      import { execFileSync } from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const input = ${JSON.stringify({ repositoryRoot, profilePath })};
      if (${replaceBeforeOpen}) {
        const realpath = fs.realpath;
        fs.realpath = async (...args) => {
          const resolved = await realpath(...args);
          if (args[0] === input.profilePath) {
            // Simulate replacement at the real filesystem boundary between lstat and open.
            await fs.rename(input.profilePath, input.profilePath + '.original');
            execFileSync('mkfifo', [input.profilePath]);
          }
          return resolved;
        };
        syncBuiltinESMExports();
      }
      const { loadTrustedOperatorProfile } = await import(${JSON.stringify(new URL('../../src/operator/trusted-profile.ts', import.meta.url).href)});
      try {
        await loadTrustedOperatorProfile(input);
        process.exitCode = 1;
      } catch (error) {
        process.stdout.write(error.message);
      }
    `;
    const result = await execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    expect(result.stdout).toContain(reason);
    expect(result.stderr).toBe('');
  });

  it.runIf(posix)('rejects group- or world-writable profiles', async () => {
    const { repositoryRoot, profilePath } = await layout();
    for (const mode of [0o620, 0o602]) {
      await chmod(profilePath, mode);
      await expect(loadTrustedOperatorProfile({ repositoryRoot, profilePath })).rejects.toThrow(/writable/);
    }
  });

  it.runIf(posix && !runsAsRoot)('does not turn permission errors into a missing profile', async () => {
    const { repositoryRoot } = await layout();
    const locked = path.join(base, 'locked');
    await mkdir(path.join(locked, 'r3-doctor'), { recursive: true });
    await writeFile(path.join(locked, 'r3-doctor', 'profile.json'), JSON.stringify({ schemaVersion: 1 }));
    await chmod(locked, 0o000);
    process.env.XDG_CONFIG_HOME = locked;
    await expect(loadTrustedOperatorProfile({ repositoryRoot })).rejects.toThrow(/operator profile/);
  });
});

describe('trusted profile stat policy', () => {
  const regular = { isFile: true, size: 10, uid: 501, mode: 0o100600 };

  it('rejects another owner on POSIX and accepts the current owner', () => {
    expect(trustedProfileStatIssue(regular, { currentUid: 501, maxBytes: 1_048_576 })).toBeNull();
    expect(trustedProfileStatIssue({ ...regular, uid: 502 }, { currentUid: 501, maxBytes: 1_048_576 }))
      .toMatch(/owned by another user/);
  });

  it('skips ownership and mode checks when the platform cannot prove them', () => {
    expect(trustedProfileStatIssue({ ...regular, uid: 0, mode: 0o100666 }, { currentUid: undefined, maxBytes: 1_048_576 }))
      .toBeNull();
  });
});

describe('operator profile schema compatibility', () => {
  it('round-trips security settings through the existing loader and writer', async () => {
    const profilePath = path.join(base, 'profile.json');
    const profile = {
      schemaVersion: 1 as const,
      llm: { provider: 'codex' as const },
      addons: { security: { enabled: true, repositories: ['/work/service'], scope: 'changed' as const, maxBatches: 2 } },
    };
    await saveOperatorProfile(profile, profilePath);
    expect(await loadOperatorProfile(profilePath)).toEqual(profile);
  });

  it('keeps security settings when setup rewrites the provider default', async () => {
    const profilePath = path.join(base, 'profile.json');
    const security = { enabled: true, repositories: ['/work/service'] };
    await saveOperatorProfile({ schemaVersion: 1, llm: { provider: 'claude' }, addons: { security } }, profilePath);

    await saveSetupLlmProfile('codex', { profilePath });

    expect(await loadOperatorProfile(profilePath)).toMatchObject({ llm: { provider: 'codex' }, addons: { security } });
  });
});

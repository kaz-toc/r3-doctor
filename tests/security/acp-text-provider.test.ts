import { readdirSync } from 'node:fs';
import { mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as acp from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSecurityTextProvider } from '../../src/llm/acp-text-provider.js';
import { isSecurityConfinementVerified, SECURITY_CONFINEMENT_SUPPORT } from '../../src/llm/security-capabilities.js';
import type { LlmTextRequest } from '../../src/llm/text-provider.js';
import { LLM_ACP_CLIENT_CAPABILITIES } from '../../src/semantic/acp/acp-client.js';
import type { LlmProcess, LlmSpawn } from '../../src/semantic/acp/process-port.js';
import { buildLlmLaunchSpec } from '../../src/semantic/acp/provider-registry.js';
import { defaultLlmConfig, type LlmConfig } from '../../src/shared/config.js';
import { resolveTrustedExecutable } from '../../src/shared/executable-path.js';
import { fakeAcpAgent, type FakeAcpAgentScript } from '../helpers/fake-acp-agent.js';

const posix = process.platform !== 'win32';
const codex: LlmConfig = { ...defaultLlmConfig, enabled: true, provider: 'codex' };
const initialize: FakeAcpAgentScript['initialize'] = {
  protocolVersion: acp.PROTOCOL_VERSION,
  agentInfo: { name: 'fake-agent', version: '9.9.9' },
  agentCapabilities: {},
  authMethods: [],
};
const readOnlyModes: NonNullable<FakeAcpAgentScript['sessionModes']> = {
  currentModeId: 'read-only',
  availableModes: [{ id: 'read-only', name: 'Read only' }],
};

let repositoryRoot: string;
let outside: string;

beforeEach(async () => {
  repositoryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-security-repo-')));
  outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-security-bin-')));
});

afterEach(async () => {
  await rm(repositoryRoot, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function request(overrides: Partial<LlmTextRequest> = {}): LlmTextRequest {
  return {
    prompt: 'security batch',
    outputMaxBytes: 256 * 1024,
    deadlineAt: Date.now() + 10_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function provider(script: FakeAcpAgentScript, overrides: Partial<Parameters<typeof createSecurityTextProvider>[0]> = {}) {
  const agent = fakeAcpAgent({ sessionModes: readOnlyModes, ...script });
  const launches: Array<{ cwd: string; cwdEntries: string[] }> = [];
  const spawn: LlmSpawn = (command, args, options) => {
    launches.push({ cwd: options.cwd, cwdEntries: readdirSync(options.cwd) });
    return agent.spawn(command, args, options);
  };
  const port = createSecurityTextProvider({
    llm: codex,
    repositoryRoot,
    spawn,
    resolveExecutable: () => '/usr/local/bin/codex-acp',
    verifyConfinement: () => true,
    ...overrides,
  });
  return { agent, port, launches };
}

describe('security provider launch boundary', () => {
  it('checks the untrusted root independently from cwd', () => {
    expect(() => buildLlmLaunchSpec('codex', {
      executablePath: '/untrusted/repo/agent', modelIdentifier: '',
      cwd: '/trusted/empty', untrustedRepositoryRoots: ['/untrusted/repo'],
      inheritedEnv: { PATH: '/usr/bin' },
    })).toThrow(/repository/);

    const spec = buildLlmLaunchSpec('codex', {
      executablePath: 'codex-acp', modelIdentifier: '',
      cwd: '/trusted/empty', untrustedRepositoryRoots: ['/untrusted/repo', '/untrusted/other'],
      inheritedEnv: { PATH: ['/untrusted/repo/node_modules/.bin', '/untrusted/other/bin', '/usr/bin'].join(path.delimiter) },
    });
    expect(spec.cwd).toBe('/trusted/empty');
    expect(spec.env.PATH).toBe('/usr/bin');
  });

  it.runIf(posix)('resolves bare commands only to executables outside every untrusted root', async () => {
    const insideTarget = path.join(repositoryRoot, 'agent');
    await writeFile(insideTarget, '#!/bin/sh\n', { mode: 0o755 });
    await symlink(insideTarget, path.join(outside, 'codex-acp'));
    const safe = path.join(outside, 'safe-agent');
    await writeFile(safe, '#!/bin/sh\n', { mode: 0o755 });

    expect(() => resolveTrustedExecutable('codex-acp', outside, [repositoryRoot])).toThrow(/repository/);
    expect(() => resolveTrustedExecutable(path.join(outside, 'codex-acp'), outside, [repositoryRoot])).toThrow(/repository/);
    expect(() => resolveTrustedExecutable(insideTarget, outside, [repositoryRoot])).toThrow(/repository/);
    expect(resolveTrustedExecutable('safe-agent', outside, [repositoryRoot])).toBe(safe);
    expect(resolveTrustedExecutable('missing-agent', outside, [repositoryRoot])).toBeUndefined();
  });

  it('registers no provider as security-confined until a version is verified', () => {
    expect(SECURITY_CONFINEMENT_SUPPORT).toEqual([]);
    expect(isSecurityConfinementVerified({ providerId: 'copilot', agentInfo: { name: 'copilot', version: '1.0.83' } }))
      .toBe(false);
  });
});

describe('security text provider', () => {
  it('runs one prompt from an empty temporary cwd outside the repository and removes it', async () => {
    const { agent, port, launches } = provider({
      initialize,
      promptChunks: ['{"ok":true}'],
      promptUsage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    });

    const result = await port.complete(request());

    expect(result).toEqual({
      ok: true, text: '{"ok":true}', agentVersion: '9.9.9', resolvedModel: null, inputTokens: 12, outputTokens: 3,
    });
    expect(agent.spawnCount).toBe(1);
    expect(agent.promptRequests).toHaveLength(1);
    const cwd = launches[0]!.cwd;
    expect(launches[0]!.cwdEntries).toEqual([]);
    expect(path.relative(repositoryRoot, cwd).startsWith(`..${path.sep}`)).toBe(true);
    expect(agent.sessionNewRequests).toEqual([{ cwd, mcpServers: [] }]);
    expect(agent.initializeRequests[0]?.clientCapabilities).toEqual(LLM_ACP_CLIENT_CAPABILITIES);
    expect(agent.killCount).toBeGreaterThanOrEqual(1);
    await expect(stat(cwd)).rejects.toThrow();
  });

  it('reports null token usage when the provider omits it', async () => {
    const { port } = provider({ initialize, promptChunks: ['{}'] });
    expect(await port.complete(request())).toMatchObject({ ok: true, inputTokens: null, outputTokens: null });
  });

  it('stops before creating a session when confinement is not verified', async () => {
    const verified = provider({ initialize, promptChunks: ['x'] }, { verifyConfinement: () => false });
    expect(await verified.port.complete(request())).toEqual({ ok: false, reason: 'confinement-unsupported' });
    expect(verified.agent.sessionNewRequests).toHaveLength(0);
    expect(verified.agent.promptRequests).toHaveLength(0);

    const defaults = provider({ initialize, promptChunks: ['x'] }, { verifyConfinement: undefined });
    expect(await defaults.port.complete(request())).toEqual({ ok: false, reason: 'confinement-unsupported' });
    expect(defaults.agent.promptRequests).toHaveLength(0);
  });

  it('does not spawn without a provider, a remaining deadline, a trusted executable, or when cancelled', async () => {
    const none = provider({ initialize }, { llm: defaultLlmConfig });
    expect(await none.port.complete(request())).toEqual({ ok: false, reason: 'provider-not-configured' });

    const late = provider({ initialize });
    expect(await late.port.complete(request({ deadlineAt: Date.now() + 500 }))).toEqual({ ok: false, reason: 'deadline-exceeded' });

    const missing = provider({ initialize }, { resolveExecutable: () => undefined });
    expect(await missing.port.complete(request())).toEqual({ ok: false, reason: 'executable-missing' });

    const controller = new AbortController();
    controller.abort();
    const cancelled = provider({ initialize });
    expect(await cancelled.port.complete(request({ signal: controller.signal }))).toEqual({ ok: false, reason: 'cancelled' });

    for (const { agent } of [none, late, missing, cancelled]) {
      expect(agent.spawnCount).toBe(0);
    }
  });

  it('bounds a hanging initialize by the shared deadline and cleans up', async () => {
    const { agent, port, launches } = provider({ initialize, hangInitialize: true }, { cleanupReserveMs: 50 });
    const started = Date.now();

    const result = await port.complete(request({ deadlineAt: Date.now() + 300 }));

    expect(result).toEqual({ ok: false, reason: 'deadline-exceeded' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(agent.killCount).toBeGreaterThanOrEqual(1);
    await expect(stat(launches[0]!.cwd)).rejects.toThrow();
  });

  it('aborts on the first tool call', async () => {
    const { port } = provider({ initialize, promptToolCall: true, promptChunks: ['x'] });
    expect(await port.complete(request())).toEqual({ ok: false, reason: 'tool-use-limit' });
  });

  it('refuses to prompt when the provider does not offer its safe mode', async () => {
    const { agent, port } = provider({ initialize, promptChunks: ['x'], sessionModes: undefined });
    expect(await port.complete(request())).toEqual({ ok: false, reason: 'safe-mode-unavailable' });
    expect(agent.promptRequests).toHaveLength(0);
  });

  it('escalates to SIGKILL when the provider ignores termination', async () => {
    const agent = fakeAcpAgent({ initialize, promptChunks: ['done'], sessionModes: readOnlyModes });
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const stubborn: LlmSpawn = (command, args, options) => {
      const child = agent.spawn(command, args, options);
      const wrapper: LlmProcess = {
        stdin: child.stdin,
        stdout: child.stdout,
        kill: (signal?: NodeJS.Signals | number) => {
          signals.push(signal);
          return signal === 'SIGKILL' ? child.kill(signal) : true;
        },
        once(event, listener) {
          child.once(event as 'exit', listener as (code: number | null, signal: NodeJS.Signals | null) => void);
          return wrapper;
        },
      };
      return wrapper;
    };
    const port = createSecurityTextProvider({
      llm: codex,
      repositoryRoot,
      spawn: stubborn,
      resolveExecutable: () => '/usr/local/bin/codex-acp',
      verifyConfinement: () => true,
      cleanupReserveMs: 50,
    });

    expect(await port.complete(request())).toMatchObject({ ok: true, text: 'done' });
    expect(signals[0]).not.toBe('SIGKILL');
    expect(signals).toContain('SIGKILL');
  });
});

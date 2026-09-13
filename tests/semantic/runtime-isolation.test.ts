import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRepositorySnapshot } from '../../src/intake/snapshot.js';
import * as processPort from '../../src/semantic/acp/process-port.js';
import { buildLlmLaunchSpec } from '../../src/semantic/acp/provider-registry.js';
import { buildLlmCatalog } from '../../src/semantic/llm/catalog.js';
import { discoverLlmModels } from '../../src/semantic/llm/discover.js';
import { inspectLlmProvider } from '../../src/semantic/llm/inspect.js';
import { AcpSemanticProvider } from '../../src/semantic/providers/acp-semantic-provider.js';
import { runCheck } from '../../src/setup/readiness.js';
import { defaultLlmConfig } from '../../src/shared/config.js';
import { fakeAcpAgent } from '../helpers/fake-acp-agent.js';

describe('REG-2026-030 provider runtime isolation', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['semantic', 'inspect', 'catalog', 'check', 'discover'] as const)(
    '%s uses a fresh empty cwd, keeps repository PATH exclusion, and cleans up', async (entry) => {
      const repositoryPath = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-untrusted-'));
      await writeFile(path.join(repositoryPath, 'AGENTS.md'), 'untrusted startup instructions');
      const agent = fakeAcpAgent({
        initialize: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] },
        promptChunks: ['[]'],
      });
      const runtimes: string[] = [];
      const runtimeContents: string[][] = [];
      const searchPaths: string[][] = [];
      const originalPath = process.env.PATH;
      process.env.PATH = [repositoryPath, '.', originalPath].join(path.delimiter);
      vi.spyOn(processPort, 'spawnLlmProcess').mockImplementation((spec) => {
        runtimes.push(spec.cwd);
        runtimeContents.push(readdirSync(spec.cwd));
        searchPaths.push(spec.env.PATH?.split(path.delimiter) ?? []);
        return agent.spawn(spec.command, spec.args, {
          cwd: spec.cwd, env: spec.env, shell: false, stdio: ['pipe', 'pipe', 'ignore'],
        });
      });
      try {
        for (let invocation = 0; invocation < 2; invocation += 1) {
          if (entry === 'semantic') {
            const config = { ...defaultLlmConfig, enabled: true, provider: 'copilot' as const };
            const snapshot = await createRepositorySnapshot(repositoryPath, undefined, config);
            await expect(new AcpSemanticProvider('copilot', config).analyze(snapshot, [])).resolves.toEqual([]);
          } else if (entry === 'inspect') {
            expect((await inspectLlmProvider({ provider: 'copilot', path: repositoryPath })).exitCode).toBe(0);
          } else if (entry === 'catalog') {
            const result = await buildLlmCatalog({ inspect: true, provider: 'copilot', path: repositoryPath });
            expect(result.providers[0]?.inspect.status).toBe('available');
          } else if (entry === 'check') {
            const result = await runCheck({ repositoryPath, locale: 'en', inspectLlm: true, llmProvider: 'copilot' });
            expect(result.checks.llm?.ok).toBe(true);
          } else {
            expect((await discoverLlmModels({ provider: 'copilot', path: repositoryPath })).ok).toBe(true);
          }
        }
        expect(runtimes).toHaveLength(2);
        expect(runtimes).not.toContain(repositoryPath);
        expect(runtimes).not.toContain(os.tmpdir());
        expect(runtimeContents).toEqual([[], []]);
        for (const searchPath of searchPaths) {
          expect(searchPath).not.toContain(repositoryPath);
          expect(searchPath).not.toContain('.');
        }
        expect(new Set(runtimes).size).toBe(2);
        expect(runtimes.every((runtime) => !existsSync(runtime))).toBe(true);
        if (entry === 'semantic' || entry === 'discover') {
          expect(agent.sessionDirectories).toEqual(runtimes);
        }
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        await rm(repositoryPath, { recursive: true, force: true });
      }
    },
  );

  it('rejects repository-owned executables after the cwd moves elsewhere', () => {
    expect(() => buildLlmLaunchSpec('copilot', {
      executablePath: '/untrusted/repo/provider', modelIdentifier: 'auto',
      runtimeDirectory: '/isolated/runtime', untrustedDirectory: '/untrusted/repo',
      inheritedEnv: { PATH: '/usr/bin' },
    })).toThrow('must not resolve inside the analyzed repository');
  });
});

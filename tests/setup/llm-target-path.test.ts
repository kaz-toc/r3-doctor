import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as processPort from '../../src/semantic/acp/process-port.js';
import type { LlmLaunchSpec } from '../../src/semantic/acp/provider-types.js';
import { runInteractiveSetupChoices } from '../../src/setup/interactive.js';
import { configureOperatorLlm } from '../../src/setup/llm-setup.js';
import * as prompts from '../../src/setup/prompts.js';
import { fakeAcpAgent } from '../helpers/fake-acp-agent.js';

describe('REG-2026-030 setup provider target boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(['configured provider', 'interactive catalog and models'] as const)(
    '%s retains operator-home executables while excluding the target repository', async (flow) => {
      const operatorDirectory = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-operator-'));
      const repositoryPath = path.join(operatorDirectory, 'projects', 'repository');
      const operatorBin = path.join(operatorDirectory, '.local', 'bin');
      const repositoryBin = path.join(repositoryPath, 'node_modules', '.bin');
      await mkdir(operatorBin, { recursive: true });
      await mkdir(repositoryBin, { recursive: true });
      vi.spyOn(process, 'cwd').mockReturnValue(operatorDirectory);
      vi.stubEnv('PATH', [repositoryBin, operatorBin, '/usr/bin'].join(path.delimiter));
      const launches: Array<{ spec: LlmLaunchSpec; contents: string[] }> = [];
      const agent = fakeAcpAgent({
        initialize: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] },
      });
      vi.spyOn(processPort, 'spawnLlmProcess').mockImplementation((spec) => {
        launches.push({ spec, contents: readdirSync(spec.cwd) });
        return agent.spawn(spec.command, spec.args, {
          cwd: spec.cwd, env: spec.env, shell: false, stdio: ['pipe', 'pipe', 'ignore'],
        });
      });
      try {
        if (flow === 'configured provider') {
          const result = await configureOperatorLlm({
            locale: 'en', repositoryPath, provider: 'copilot', saveProfile: false,
          });
          expect(result.inspectAvailable).toBe(true);
          expect(launches).toHaveLength(1);
        } else {
          vi.spyOn(prompts, 'createSetupPrompts').mockResolvedValue({
            selectLocale: async () => 'en',
            confirm: async (message) => message.includes('Configure LLM provider'),
            selectProvider: async () => 'copilot',
            selectModel: async () => 'auto',
            close: async () => undefined,
          });
          const choices = await runInteractiveSetupChoices(repositoryPath, { dryRun: true });
          expect(choices.llmInspectAvailable).toBe(true);
          expect(choices.llmModel).toBe('auto');
          expect(launches).toHaveLength(5);
          expect(agent.sessionDirectories).toEqual([launches[4]!.spec.cwd]);
        }
        for (const { spec, contents } of launches) {
          expect(spec.env.PATH?.split(path.delimiter)).toEqual([operatorBin, '/usr/bin']);
          expect(spec.cwd).not.toBe(repositoryPath);
          expect(spec.cwd).not.toBe(operatorDirectory);
          expect(contents).toEqual([]);
          expect(existsSync(spec.cwd)).toBe(false);
        }
        expect(new Set(launches.map(({ spec }) => spec.cwd)).size).toBe(launches.length);
      } finally {
        await rm(operatorDirectory, { recursive: true, force: true });
      }
    },
  );
});

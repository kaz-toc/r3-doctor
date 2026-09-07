import { describe, expect, it } from 'vitest';
import * as acp from '@agentclientprotocol/sdk';

import {
  createOneShotAcpClient,
  LLM_ACP_CLIENT_CAPABILITIES,
} from '../../src/semantic/acp/acp-client.js';
import { LLM_PROMPT_OUTPUT_MAX_BYTES } from '../../src/semantic/acp/constants.js';
import { getLlmProviderDefinition } from '../../src/semantic/acp/provider-registry.js';
import type { LlmLaunchSpec, LlmProviderId } from '../../src/semantic/acp/provider-types.js';
import type { LlmProcess, LlmSpawn } from '../../src/semantic/acp/process-port.js';
import { fakeAcpAgent } from '../helpers/fake-acp-agent.js';

const ISOLATED_CWD = '/isolated-runtime';

function launchSpec(
  providerId: LlmProviderId,
  overrides: Partial<LlmLaunchSpec> = {},
): LlmLaunchSpec {
  return getLlmProviderDefinition(providerId).buildLaunch({
    executablePath: getLlmProviderDefinition(providerId).defaultExecutablePath,
    modelIdentifier: providerId === 'copilot' ? 'auto' : '',
    runtimeDirectory: ISOLATED_CWD,
    inheritedEnv: { PATH: '/bin' },
    ...overrides,
  });
}

function missingExecutableSpawn(): LlmSpawn {
  return () => {
    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    const process: LlmProcess = {
      stdin: {} as LlmProcess['stdin'],
      stdout: {} as LlmProcess['stdout'],
      kill: () => true,
      once(event, listener) {
        if (event === 'error') {
          (listener as (error: Error & { code?: string }) => void)(enoent);
        }
        return process;
      },
    };
    return process;
  };
}

describe('createOneShotAcpClient', () => {
  it('REG-2026-009 times out and kills an agent that never answers initialize', async () => {
    const script = fakeAcpAgent({
      initialize: {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {},
        authMethods: [],
      },
      hangInitialize: true,
    });
    const client = createOneShotAcpClient({ spawn: script.spawn, setupTimeoutMs: 20 });

    const result = await client.inspect({ spec: launchSpec('copilot') });

    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(script.killCount).toBeGreaterThanOrEqual(1);
  });

  it('times out and kills an agent that never creates a session', async () => {
    const script = fakeAcpAgent({
      initialize: {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {},
        authMethods: [],
      },
      hangSessionSetup: true,
    });
    const client = createOneShotAcpClient({ spawn: script.spawn, setupTimeoutMs: 20 });

    const result = await client.oneShotPrompt({
      spec: launchSpec('copilot'),
      prompt: 'analyze semantic ambiguity',
      outputMaxBytes: LLM_PROMPT_OUTPUT_MAX_BYTES,
    });

    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(script.killCount).toBeGreaterThanOrEqual(1);
  });

  it('initializes with capability-minimal clientCapabilities', async () => {
    const script = fakeAcpAgent({
      initialize: {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {},
        authMethods: [],
      },
    });
    const client = createOneShotAcpClient({ spawn: script.spawn });

    const result = await client.inspect({ spec: launchSpec('copilot') });

    expect(result.ok).toBe(true);
    expect(script.initializeRequests[0]?.clientCapabilities).toEqual(LLM_ACP_CLIENT_CAPABILITIES);
  });

  it('returns protocol_incompatible when protocol versions mismatch', async () => {
    const script = fakeAcpAgent({
      initialize: {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {},
        authMethods: [],
      },
      protocolVersionMismatch: true,
    });
    const client = createOneShotAcpClient({ spawn: script.spawn });

    const result = await client.inspect({ spec: launchSpec('copilot') });

    expect(result).toEqual({ ok: false, reason: 'protocol_incompatible' });
  });

  it('returns executable_missing when spawn fails with ENOENT', async () => {
    const client = createOneShotAcpClient({ spawn: missingExecutableSpawn() });

    const result = await client.inspect({ spec: launchSpec('copilot') });

    expect(result).toEqual({ ok: false, reason: 'executable_missing' });
  });

  it('returns inspection metadata from initialize', async () => {
    const script = fakeAcpAgent({
      initialize: {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: { name: 'fake-agent', version: '1.0.0' },
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: 'cursor_login', name: 'Cursor Login' }],
      },
    });
    const client = createOneShotAcpClient({ spawn: script.spawn });

    const result = await client.inspect({ spec: launchSpec('cursor') });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.providerId).toBe('cursor');
      expect(result.value.agentInfo?.name).toBe('fake-agent');
    }
  });

  it('collects prompt text in oneShotPrompt', async () => {
    const script = fakeAcpAgent({
      initialize: {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {},
        authMethods: [],
      },
      promptChunks: ['[{"axisId":"semantic-ambiguity","summary":"test","confidence":0.8}]'],
    });
    const client = createOneShotAcpClient({ spawn: script.spawn });

    const result = await client.oneShotPrompt({
      spec: launchSpec('copilot'),
      prompt: 'analyze semantic ambiguity',
      outputMaxBytes: LLM_PROMPT_OUTPUT_MAX_BYTES,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toContain('semantic-ambiguity');
    }
    expect(script.promptRequests).toHaveLength(1);
    expect(script.killCount).toBeGreaterThanOrEqual(1);
  });

  it('builds copilot launch args with fixed tool-disabling flags', () => {
    const spec = launchSpec('copilot');
    expect(spec.args).toContain('--acp');
    expect(spec.args).toContain('--disable-builtin-mcps');
    expect(spec.args).toContain('--available-tools=');
  });

  it('forwards proxy environment variables into launch spec env', () => {
    const spec = getLlmProviderDefinition('codex').buildLaunch({
      executablePath: 'codex-acp',
      modelIdentifier: '',
      runtimeDirectory: ISOLATED_CWD,
      inheritedEnv: {
        PATH: '/bin',
        HTTPS_PROXY: 'http://proxy.example:8080',
        no_proxy: 'localhost',
        SECRET_TOKEN: 'must-not-leak',
      },
    });
    expect(spec.env.HTTPS_PROXY).toBe('http://proxy.example:8080');
    expect(spec.env.no_proxy).toBe('localhost');
    expect(spec.env.SECRET_TOKEN).toBeUndefined();
  });

  it('fails oneShotPrompt on the first tool_call', async () => {
    const script = fakeAcpAgent({
      initialize: {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {},
        authMethods: [],
      },
      promptToolCall: true,
    });
    const client = createOneShotAcpClient({ spawn: script.spawn });

    const result = await client.oneShotPrompt({
      spec: launchSpec('copilot'),
      prompt: 'analyze semantic ambiguity',
      outputMaxBytes: LLM_PROMPT_OUTPUT_MAX_BYTES,
    });

    expect(result).toEqual({ ok: false, reason: 'tool_use_limit' });
  });
});

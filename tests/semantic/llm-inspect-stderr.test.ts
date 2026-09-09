import { describe, expect, it } from 'vitest';

import { formatLlmInspectStderr } from '../../src/semantic/llm/format.js';
import type { LlmProviderInspectRow } from '../../src/semantic/llm/types.js';

describe('llm inspect stderr contract', () => {
  it('REG-2026-024: formats available provider stderr', () => {
    const row: LlmProviderInspectRow = {
      providerId: 'codex',
      status: 'available',
      agentInfo: { name: '@agentclientprotocol/codex-acp', version: '1.10.0' },
      authMethods: ['api-key', 'chat-gpt'],
      installHint: 'install codex-acp',
    };
    expect(formatLlmInspectStderr(row)).toBe(
      'provider=codex status=available\n'
        + 'agent=@agentclientprotocol/codex-acp@1.10.0\n'
        + 'authMethods=api-key,chat-gpt\n',
    );
  });

  it('REG-2026-024: formats unavailable provider stderr with executable_missing', () => {
    const row: LlmProviderInspectRow = {
      providerId: 'codex',
      status: 'unavailable',
      reason: 'executable_missing',
      authMethods: [],
      installHint: 'install codex-acp',
    };
    expect(formatLlmInspectStderr(row)).toBe(
      'provider=codex status=unavailable reason=executable_missing\n'
        + 'installHint=install codex-acp\n',
    );
  });

  it('REG-2026-024: formats unavailable provider stderr with authentication_required', () => {
    const row: LlmProviderInspectRow = {
      providerId: 'copilot',
      status: 'unavailable',
      reason: 'authentication_required',
      authMethods: [],
      installHint: 'install copilot',
    };
    expect(formatLlmInspectStderr(row)).toBe(
      'provider=copilot status=unavailable reason=authentication_required\n'
        + 'installHint=install copilot\n',
    );
  });
});

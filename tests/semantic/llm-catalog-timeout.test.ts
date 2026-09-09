import { describe, expect, it, vi } from 'vitest';

import { buildLlmCatalog } from '../../src/semantic/llm/catalog.js';

describe('llm catalog inspect timeout', () => {
  it('passes inspectTimeoutMs to inspectLlmProvider', async () => {
    const inspect = vi.spyOn(await import('../../src/semantic/llm/inspect.js'), 'inspectLlmProvider');
    inspect.mockResolvedValue({
      exitCode: 1,
      stderr: 'provider=codex status=unavailable reason=timeout\n',
      row: {
        providerId: 'codex',
        status: 'unavailable',
        reason: 'timeout',
        authMethods: [],
        installHint: 'hint',
      },
    });

    try {
      await buildLlmCatalog({
        inspect: true,
        provider: 'codex',
        path: '/tmp',
        inspectTimeoutMs: 15_000,
      });
      expect(inspect).toHaveBeenCalledWith({
        provider: 'codex',
        path: '/tmp',
        setupTimeoutMs: 15_000,
      });
    } finally {
      inspect.mockRestore();
    }
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildLlmCatalog } from '../../src/semantic/llm/catalog.js';
import { llmCatalogReportSchema } from '../../src/schema/llm-catalog.v1.js';
import * as inspectModule from '../../src/semantic/llm/inspect.js';

describe('llm list catalog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('REG-2026-024: lists four providers with aliases without spawning', async () => {
    const inspectSpy = vi.spyOn(inspectModule, 'inspectLlmProvider');
    const report = await buildLlmCatalog();
    expect(inspectSpy).not.toHaveBeenCalled();
    const parsed = llmCatalogReportSchema.parse(report);
    expect(parsed.providers.map((provider) => provider.id)).toEqual([
      'copilot',
      'cursor',
      'codex',
      'claude',
    ]);
    expect(parsed.providers.find((provider) => provider.id === 'codex')?.aliases).toEqual(['openai']);
    expect(parsed.providers.find((provider) => provider.id === 'claude')?.aliases).toEqual(['anthropic']);
    for (const provider of parsed.providers) {
      expect(provider.inspect.status).toBe('skipped');
    }
  });

  it('probes each provider sequentially when inspect is enabled', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-llm-list-'));
    const inspectSpy = vi.spyOn(inspectModule, 'inspectLlmProvider');
    inspectSpy.mockImplementation(async ({ provider }) => ({
      exitCode: 0,
      stderr: `provider=${provider} status=available\n`,
      row: {
        providerId: provider as 'codex',
        status: 'available',
        authMethods: [],
        installHint: 'hint',
      },
    }));

    try {
      const report = await buildLlmCatalog({ inspect: true, path: tempDir });
      expect(inspectSpy).toHaveBeenCalledTimes(4);
      expect(report.providers.every((provider) => provider.inspect.status === 'available')).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('limits inspect to one provider when provider filter is set', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-llm-list-one-'));
    const inspectSpy = vi.spyOn(inspectModule, 'inspectLlmProvider');
    inspectSpy.mockResolvedValue({
      exitCode: 1,
      stderr: 'provider=codex status=unavailable reason=executable_missing\ninstallHint=hint\n',
      row: {
        providerId: 'codex',
        status: 'unavailable',
        reason: 'executable_missing',
        authMethods: [],
        installHint: 'hint',
      },
    });

    try {
      const report = await buildLlmCatalog({ inspect: true, provider: 'openai', path: tempDir });
      expect(inspectSpy).toHaveBeenCalledTimes(1);
      expect(report.providers).toHaveLength(1);
      expect(report.providers[0]?.id).toBe('codex');
      expect(report.providers[0]?.inspect.status).toBe('unavailable');
      expect(report.providers[0]?.inspect.reason).toBe('executable_missing');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

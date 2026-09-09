import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runSetup } from '../../src/setup/run.js';

describe('setup non-interactive LLM compatibility', () => {
  it('uses configureOperatorLlm when llmInspectAvailable is not preset', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'r3-doctor-setup-noninteractive-'));
    const configure = vi.spyOn(await import('../../src/setup/llm-setup.js'), 'configureOperatorLlm');
    configure.mockResolvedValueOnce({
      attempted: true,
      provider: 'codex',
      inspectAvailable: true,
      inspectDetail: '',
      profileWritten: false,
    });

    try {
      await runSetup({
        repositoryPath: tempDir,
        locale: 'en',
        yes: true,
        dryRun: true,
        force: false,
        configureLlm: true,
        llmProvider: 'codex',
        saveOperatorProfile: false,
      });
      expect(configure).toHaveBeenCalledOnce();
    } finally {
      configure.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

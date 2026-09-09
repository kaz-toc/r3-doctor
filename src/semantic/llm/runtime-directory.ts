import os from 'node:os';

/** Setup / operator-side LLM probe runtime. Avoids untrusted repo cwd and homedir PATH stripping. */
export function resolveLlmRuntimeDirectory(): string {
  return os.tmpdir();
}

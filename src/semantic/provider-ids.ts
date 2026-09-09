import { z } from 'zod';

import { llmProviderIdSchema } from './acp/provider-types.js';

import { resolveProviderAlias } from './llm/aliases.js';

export function normalizeProviderId(
  provider: string,
): z.infer<typeof llmProviderIdSchema> | 'none' | null {
  if (provider === 'none') return 'none';
  const resolved = resolveProviderAlias(provider);
  const parsed = llmProviderIdSchema.safeParse(resolved);
  return parsed.success ? parsed.data : null;
}

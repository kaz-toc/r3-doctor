import { access, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { llmConfigSchema, reportLocaleSchema, type LlmConfig } from '../shared/config.js';
import { R3DoctorError } from '../shared/errors.js';

export const operatorProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    locale: reportLocaleSchema.optional(),
    llm: llmConfigSchema.partial().optional(),
  })
  .strict();

export type OperatorProfile = z.infer<typeof operatorProfileSchema>;

export function defaultOperatorProfilePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(configHome, 'r3-doctor', 'profile.json');
}

export async function loadOperatorProfile(profilePath = defaultOperatorProfilePath()): Promise<OperatorProfile | null> {
  const resolved = path.resolve(profilePath);
  try {
    await access(resolved);
  } catch {
    return null;
  }
  try {
    const raw = await readFile(resolved, 'utf8');
    return operatorProfileSchema.parse(JSON.parse(raw));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new R3DoctorError(`invalid operator profile at ${resolved}: ${reason}`);
  }
}

export async function saveOperatorProfile(
  profile: OperatorProfile,
  profilePath = defaultOperatorProfilePath(),
): Promise<string> {
  const parsed = operatorProfileSchema.parse(profile);
  const resolved = path.resolve(profilePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(resolved, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8'),
  );
  return resolved;
}

export function mergeOperatorLlmDefaults(profile: OperatorProfile | null | undefined): Partial<LlmConfig> | undefined {
  if (!profile?.llm) {
    return undefined;
  }
  return profile.llm;
}

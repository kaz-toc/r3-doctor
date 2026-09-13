import { z } from 'zod';

export function parseIsoTimestamp(value: string, fieldName = 'timestamp'): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${fieldName} must be a valid ISO-8601 timestamp`);
  }
  return date;
}

export function normalizeIsoTimestamp(value: string): string {
  return parseIsoTimestamp(value).toISOString();
}

export const isoTimestampSchema = z.string().transform((value, ctx) => {
  try {
    return normalizeIsoTimestamp(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be an ISO-8601 UTC timestamp' });
    return z.NEVER;
  }
});

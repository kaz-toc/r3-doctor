import { describe, expect, it } from 'vitest';

import { operatorSecuritySettingsSchema } from '../../src/addons/security/config.js';
import { resolveSecurityPolicy, SECURITY_POLICY_DEFAULTS } from '../../src/addons/security/policy.js';
import type { SecurityDecision } from '../../src/addons/security/types.js';
import { defaultLlmConfig, type LlmConfig } from '../../src/shared/config.js';

const ROOT = '/trusted/project';
const codex: LlmConfig = { ...defaultLlmConfig, enabled: true, provider: 'codex' };
const disabled: SecurityDecision = { kind: 'disabled', required: false };

function resolve(overrides: Partial<Parameters<typeof resolveSecurityPolicy>[0]>): SecurityDecision {
  return resolveSecurityPolicy({
    mode: 'scan', canonicalRoot: ROOT, cli: {}, repository: undefined, operator: undefined, llm: codex, ...overrides,
  });
}

function operator(settings: Record<string, unknown>) {
  return operatorSecuritySettingsSchema.parse({ repositories: [ROOT], ...settings });
}

function scopeOf(decision: SecurityDecision): string | undefined {
  return decision.kind === 'enabled' ? decision.policy.scope : undefined;
}

describe('security policy resolution', () => {
  it('does not treat repository enablement as consent', () => {
    expect(resolveSecurityPolicy({
      mode: 'scan', canonicalRoot: '/trusted/project', cli: {},
      repository: { enabled: true }, operator: undefined, llm: defaultLlmConfig,
    })).toEqual({ kind: 'blocked', required: false, reason: 'operator-consent-required' });
  });

  it('stays disabled when only an LLM provider is configured', () => {
    expect(resolve({})).toEqual(disabled);
  });

  it('enables from a root-matched operator entry without CLI flags', () => {
    expect(resolve({ operator: operator({ enabled: true, maxBatches: 2 }) })).toEqual({
      kind: 'enabled',
      required: false,
      policy: {
        mode: 'scan', scope: 'repository', required: false, llm: codex,
        maxBatches: 2, maxTotalPromptBytes: 240_000, timeoutMs: 180_000,
      },
    });
  });

  it('matches only the exact canonical root', () => {
    for (const repositories of [['/trusted'], ['/trusted/project/'], ['/trusted/proj'], ['/trusted/*']]) {
      expect(resolve({ operator: operatorSecuritySettingsSchema.parse({ enabled: true, repositories }) })).toEqual(disabled);
    }
    expect(resolve({ canonicalRoot: '/trusted/project/packages/api', operator: operator({ enabled: true }) }))
      .toEqual(disabled);
  });

  it('lets an operator opt-out override a repository request', () => {
    expect(resolve({ repository: { enabled: true }, operator: operator({ enabled: false }) })).toEqual(disabled);
  });

  it('blocks repository requests for roots outside the operator list', () => {
    expect(resolve({ canonicalRoot: '/other/project', repository: { enabled: true }, operator: operator({ enabled: true }) }))
      .toEqual({ kind: 'blocked', required: false, reason: 'operator-consent-required' });
  });

  it('lets explicit CLI flags override the profile in both directions', () => {
    expect(resolve({ cli: { security: false }, operator: operator({ enabled: true }) })).toEqual(disabled);
    expect(resolve({ cli: { security: true }, operator: operator({ enabled: false }) }).kind).toBe('enabled');
    expect(resolve({ canonicalRoot: '/ci/checkout', cli: { securityRequired: true } })).toMatchObject({
      kind: 'enabled',
      required: true,
      policy: { required: true, maxBatches: SECURITY_POLICY_DEFAULTS.maxBatches },
    });
  });

  it('does not apply a non-matching operator budget to a CLI-enabled run', () => {
    const decision = resolve({
      canonicalRoot: '/ci/checkout', cli: { security: true }, operator: operator({ enabled: true, timeoutMs: 5_000 }),
    });
    expect(decision.kind === 'enabled' ? decision.policy.timeoutMs : undefined).toBe(SECURITY_POLICY_DEFAULTS.timeoutMs);
  });

  it('rejects contradictory required and disable flags', () => {
    expect(() => resolve({ cli: { security: false, securityRequired: true } })).toThrow(/--security-required/);
  });

  it('resolves analysis scope by precedence and forces changed for diff', () => {
    const changedOperator = operator({ enabled: true, scope: 'changed' });
    expect(scopeOf(resolve({ operator: changedOperator }))).toBe('changed');
    expect(scopeOf(resolve({ operator: changedOperator, cli: { securityScope: 'repository' } }))).toBe('repository');
    expect(scopeOf(resolve({ operator: operator({ enabled: true }), repository: { scope: 'changed' } }))).toBe('changed');
    expect(scopeOf(resolve({ operator: operator({ enabled: true }) }))).toBe('repository');
    expect(scopeOf(resolve({ mode: 'diff', operator: operator({ enabled: true, scope: 'repository' }) }))).toBe('changed');
    expect(() => resolve({ mode: 'diff', cli: { security: true, securityScope: 'repository' } })).toThrow(/--security-scope/);
  });

  it('does not select a provider as a side effect', () => {
    const decision = resolve({ llm: defaultLlmConfig, operator: operator({ enabled: true }) });
    expect(decision.kind === 'enabled' ? decision.policy.llm.provider : undefined).toBe('none');
  });
});

describe('operator security settings schema', () => {
  const accepts = (value: Record<string, unknown>) =>
    operatorSecuritySettingsSchema.safeParse({ repositories: [ROOT], ...value }).success;

  it('bounds budgets without rounding', () => {
    expect(accepts({ maxBatches: 16, maxTotalPromptBytes: 2_000_000, timeoutMs: 600_000 })).toBe(true);
    expect(accepts({ maxBatches: 1, maxTotalPromptBytes: 1, timeoutMs: 1_000 })).toBe(true);
    for (const invalid of [
      { maxBatches: 0 }, { maxBatches: 17 }, { maxBatches: 1.5 },
      { maxTotalPromptBytes: 0 }, { maxTotalPromptBytes: 2_000_001 },
      { timeoutMs: 999 }, { timeoutMs: 600_001 },
    ]) {
      expect(accepts(invalid)).toBe(false);
    }
  });

  it('requires bounded absolute repository roots and rejects execution settings', () => {
    expect(accepts({ repositories: ['relative/project'] })).toBe(false);
    expect(accepts({ repositories: Array.from({ length: 129 }, (_, index) => `/r/${index}`) })).toBe(false);
    expect(accepts({ repositories: [`/${'a'.repeat(1_024)}`] })).toBe(false);
    expect(accepts({ provider: 'codex' })).toBe(false);
    expect(accepts({ executablePath: '/usr/bin/agent' })).toBe(false);
  });
});

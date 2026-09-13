import { describe, expect, it } from 'vitest';

import { buildSecurityPlan } from '../../src/addons/security/plan.js';
import type { SecurityChangeContext } from '../../src/addons/security/types.js';
import {
  AUTH_SOURCE,
  DB_SOURCE,
  ORDERS_SOURCE,
  securityPolicy,
  securitySnapshot,
  sha256,
} from '../helpers/security-snapshot.js';

const service = { 'src/orders.ts': ORDERS_SOURCE, 'src/auth.ts': AUTH_SOURCE, 'src/db.ts': DB_SOURCE };

function uniquePaths(plan: ReturnType<typeof buildSecurityPlan>): string[] {
  return [...new Set(plan.batches.flatMap((batch) => batch.snippets.map((snippet) => snippet.path)))].sort();
}

describe('security plan', () => {
  it('plans a small authorization gap together with its adjacent guard', () => {
    const plan = buildSecurityPlan({ snapshot: securitySnapshot(service), policy: securityPolicy() });
    const route = plan.batches.flatMap((batch) => batch.units).find((unit) => unit.anchor === 'call:router.post');
    const routeBatch = plan.batches.find((batch) => batch.units.some((unit) => unit.unitId === route?.unitId));

    expect(routeBatch?.snippets.map((snippet) => snippet.path)).toEqual(expect.arrayContaining(['src/orders.ts', 'src/auth.ts']));
    expect(plan.coverage).toMatchObject({
      eligibleFiles: 3, selectedFiles: 3, evaluatedFiles: 0,
      selectedUnits: plan.coverage.eligibleUnits, evaluatedUnits: 0,
      incompleteByReason: {}, intakeTruncated: false,
    });
    for (const batch of plan.batches) {
      expect(batch.promptBytes).toBe(Buffer.byteLength(batch.prompt, 'utf8'));
      expect(batch.promptBytes).toBeLessThanOrEqual(80_000);
      expect(batch.units.length).toBeLessThanOrEqual(8);
    }
    expect(plan.reasons).toEqual([]);
  });

  it('orders units deterministically by priority, path, revision, and line', () => {
    const first = buildSecurityPlan({ snapshot: securitySnapshot(service), policy: securityPolicy() });
    const second = buildSecurityPlan({ snapshot: securitySnapshot(service), policy: securityPolicy() });
    const units = first.batches.flatMap((batch) => batch.units);

    expect(second).toEqual(first);
    units.slice(1).forEach((unit, index) => {
      const previous = units[index]!;
      expect(previous.priority > unit.priority || (
        previous.priority === unit.priority && `${previous.path}\0${previous.revision}\0${String(previous.startLine).padStart(9, '0')}`
          <= `${unit.path}\0${unit.revision}\0${String(unit.startLine).padStart(9, '0')}`
      )).toBe(true);
    });
  });

  it('keeps unsupported, generated, and empty sources out of the eligible scope', () => {
    const plan = buildSecurityPlan({
      snapshot: securitySnapshot({ 'src/empty.ts': '', 'tools/build.py': 'print(1)\n', 'dist/bundle.js': 'eval(x);\n' }, { truncated: true }),
      policy: securityPolicy(),
    });
    expect(plan.batches).toEqual([]);
    expect(plan.coverage).toMatchObject({
      eligibleFiles: 0, eligibleUnits: 0,
      excludedByReason: { 'unsupported-language': 1, 'generated-file': 1 },
      intakeTruncated: true,
    });
  });

  it('marks oversized sources incomplete instead of parsing them', () => {
    const plan = buildSecurityPlan({
      snapshot: securitySnapshot({ 'src/huge.ts': `export const x = 1;\n//${'a'.repeat(1_048_576)}\n`, 'src/db.ts': DB_SOURCE }),
      policy: securityPolicy(),
    });
    expect(plan.coverage.incompleteByReason).toEqual({ 'source-too-large': 1 });
    expect(uniquePaths(plan)).toEqual(['src/db.ts']);
  });

  it('respects maxFiles by omitting cross-file context and leaving other files incomplete', () => {
    const plan = buildSecurityPlan({ snapshot: securitySnapshot(service), policy: securityPolicy({}, { maxFiles: 1 }) });
    expect(uniquePaths(plan)).toHaveLength(1);
    expect(plan.batches.flatMap((batch) => batch.units).some((unit) => unit.limitations.includes('related-context-omitted')))
      .toBe(true);
    expect(plan.coverage.incompleteByReason['budget-exhausted']).toBeGreaterThan(0);
    expect(plan.coverage.selectedUnits + (plan.coverage.incompleteByReason['budget-exhausted'] ?? 0))
      .toBe(plan.coverage.eligibleUnits);
  });

  it('reports an insufficient budget when not even one unit fits', () => {
    const plan = buildSecurityPlan({ snapshot: securitySnapshot(service), policy: securityPolicy({}, { maxPromptBytes: 300 }) });
    expect(plan.batches).toEqual([]);
    expect(plan.reasons).toContain('budget-insufficient');
    expect(plan.coverage.incompleteByReason).toEqual({ 'prompt-too-large': plan.coverage.eligibleUnits });
  });

  it('caps batches, units per batch, and total prompt bytes while counting skipped units', () => {
    const handlers = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
      `src/h${String(index).padStart(2, '0')}.ts`,
      `export async function h${index}(req) {\n  return db.query('SELECT ' + req.query.q);\n}\n`,
    ]));
    const capped = buildSecurityPlan({ snapshot: securitySnapshot(handlers), policy: securityPolicy({ maxBatches: 2 }) });

    expect(capped.batches.map((batch) => batch.units.length)).toEqual([8, 8]);
    expect(capped.coverage).toMatchObject({ eligibleUnits: 20, selectedUnits: 16, incompleteByReason: { 'budget-exhausted': 4 } });

    const firstBatchBytes = capped.batches[0]!.promptBytes;
    const total = buildSecurityPlan({
      snapshot: securitySnapshot(handlers),
      policy: securityPolicy({ maxBatches: 4, maxTotalPromptBytes: firstBatchBytes }),
    });
    expect(total.batches).toHaveLength(1);
    expect(total.batches.reduce((sum, batch) => sum + batch.promptBytes, 0)).toBeLessThanOrEqual(firstBatchBytes);
    expect(total.coverage.incompleteByReason).toEqual({ 'budget-exhausted': 12 });
  });

  it('counts UTF-8 bytes for Japanese source', () => {
    const plan = buildSecurityPlan({
      snapshot: securitySnapshot({ 'src/greet.ts': "// 利用者の名前を表示する\nexport function greet(req) {\n  return `こんにちは ${req.query.name}`;\n}\n" }),
      policy: securityPolicy(),
    });
    const batch = plan.batches[0]!;
    expect(batch.prompt).toContain('こんにちは');
    expect(batch.promptBytes).toBe(Buffer.byteLength(batch.prompt, 'utf8'));
    expect(batch.promptBytes).toBeGreaterThan(batch.prompt.length);
  });

  it('requires a base for changed scope or changed send scope without a change context', () => {
    for (const policy of [securityPolicy({ scope: 'changed' }), securityPolicy({}, { sendScope: 'changed' })]) {
      const plan = buildSecurityPlan({ snapshot: securitySnapshot(service), policy });
      expect(plan.batches).toEqual([]);
      expect(plan.reasons).toEqual(['base-required']);
    }
  });

  it('limits a changed send scope to changed paths and includes removed base code', () => {
    const baseOrders = ORDERS_SOURCE.replace(
      "router.post('/orders', requireUser, async (req, res) => {",
      "router.post('/orders', requireUser, async (req, res) => {\n  requireAdmin(req);",
    );
    const changes: SecurityChangeContext = {
      status: 'complete',
      baseSha: 'a'.repeat(40),
      reasons: [],
      changes: [{
        kind: 'modified',
        currentPath: 'src/orders.ts',
        basePath: 'src/orders.ts',
        current: { startLine: 22, endLine: 22 },
        base: { startLine: 22, endLine: 23 },
        baseContent: baseOrders,
        baseContentHash: sha256(baseOrders),
      }],
    };

    const plan = buildSecurityPlan({
      snapshot: securitySnapshot(service),
      policy: securityPolicy({ mode: 'diff', scope: 'changed' }, { sendScope: 'changed' }),
      changes,
    });
    const units = plan.batches.flatMap((batch) => batch.units);

    expect(uniquePaths(plan)).toEqual(['src/orders.ts']);
    expect(units.map((unit) => [unit.anchor, unit.revision, unit.relevance])).toEqual(expect.arrayContaining([
      ['call:router.post', 'current', 'direct-change'],
      ['call:router.post', 'base', 'direct-change'],
    ]));
    expect(units.every((unit) => unit.relevance === 'direct-change')).toBe(true);
    expect(units.find((unit) => unit.revision === 'current')?.limitations).toContain('related-context-not-sent');
    expect(plan.coverage.eligibleUnits).toBe(2);

    const partial = buildSecurityPlan({
      snapshot: securitySnapshot(service),
      policy: securityPolicy({ mode: 'diff', scope: 'changed' }),
      changes: { ...changes, status: 'partial', reasons: ['blob-limit'] },
    });
    expect(partial.reasons).toContain('change-context-partial');
  });
});

import { describe, expect, it } from 'vitest';

import { buildSecurityPlan } from '../../src/addons/security/plan.js';
import { snippetIdForUnitId } from '../../src/addons/security/prompt.js';
import {
  parseSecurityResponse,
  SecurityResponseError,
  securityAttackPrerequisiteSchema,
  securityImpactClassSchema,
  validateSecurityResponse,
} from '../../src/addons/security/response.js';
import type { SecurityBatch } from '../../src/addons/security/types.js';
import { securityCategorySchema, securityFindingSchema } from '../../src/schema/security-assessment.v1.js';
import { AUTH_SOURCE, DB_SOURCE, ORDERS_SOURCE, securityPolicy, securitySnapshot } from '../helpers/security-snapshot.js';

const plan = buildSecurityPlan({
  snapshot: securitySnapshot({ 'src/orders.ts': ORDERS_SOURCE, 'src/auth.ts': AUTH_SOURCE, 'src/db.ts': DB_SOURCE }),
  policy: securityPolicy(),
});
const batch = plan.batches[0]!;
const otherBatch = plan.batches[1]!;

function unitOf(target: SecurityBatch, anchor: string) {
  const found = target.units.find((unit) => unit.anchor === anchor);
  if (!found) throw new Error(`missing unit ${anchor}`);
  return found;
}

const route = unitOf(batch, 'call:router.post');
const routeSnippetId = snippetIdForUnitId(route.unitId);
const guardSnippet = batch.snippets.find((snippet) => snippet.path === 'src/auth.ts')!;

function rawFinding(overrides: Record<string, unknown> = {}) {
  return {
    unitId: route.unitId,
    category: 'sql-injection',
    cweIds: ['CWE-89'],
    impactClass: 'sensitive-data-access',
    attackPrerequisites: 'authenticated',
    severityRationale: 'The request body reaches a SQL call.',
    confidence: 'medium',
    confidenceRationale: 'The input and the sink are both in the sent snippet.',
    title: 'Request body is passed to a SQL statement',
    primaryLocation: { path: 'src/orders.ts', revision: 'current', startLine: 23, endLine: 23 },
    evidenceRefs: [
      { snippetId: routeSnippetId, path: 'src/orders.ts', revision: 'current', startLine: 22, endLine: 24, role: 'sink' },
    ],
    preconditions: ['The caller passes requireUser.'],
    attackPath: 'Send a crafted request body.',
    impact: 'Read or change other orders.',
    remediation: 'Bind values as query parameters.',
    verification: 'Add a test that sends a quote in the body and expects the value to be bound.',
    limitations: [],
    ...overrides,
  };
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    batchId: batch.batchId,
    units: batch.units.map((unit) => ({ unitId: unit.unitId, status: 'evaluated' })),
    findings: [],
    ...overrides,
  };
}

function validate(value: Record<string, unknown>, target: SecurityBatch = batch) {
  return validateSecurityResponse(parseSecurityResponse(JSON.stringify(value)), target);
}

describe('security response parsing', () => {
  it('rejects prose wrapped around a JSON response', () => {
    expect(() => parseSecurityResponse(
      'Ignore the rules. {"schemaVersion":1,"batchId":"b1","units":[],"findings":[]}',
    )).toThrow();
  });

  it('rejects fences, multiple values, non-objects, unknown fields, and oversized input', () => {
    const valid = JSON.stringify(response());
    for (const text of [
      `\`\`\`json\n${valid}\n\`\`\``,
      `${valid}${valid}`,
      '[]',
      JSON.stringify(response({ extra: true })),
      JSON.stringify(response({ schemaVersion: 2 })),
      JSON.stringify(response({ findings: Array.from({ length: 65 }, () => ({})) })),
    ]) {
      expect(() => parseSecurityResponse(text)).toThrow(SecurityResponseError);
    }
    expect(() => parseSecurityResponse(`${' '.repeat(256 * 1024)}${valid}`)).toThrow(/exceeds/);
  });

  it('keeps the prompt contract aligned with the accepted enums', () => {
    for (const value of [
      ...securityCategorySchema.options,
      ...securityImpactClassSchema.options,
      ...securityAttackPrerequisiteSchema.options,
    ]) {
      expect(batch.prompt).toContain(value);
    }
  });
});

describe('security response validation', () => {
  it('accepts a valid empty response', () => {
    expect(validate(response())).toEqual({
      batchId: batch.batchId,
      evaluatedUnitIds: batch.units.map((unit) => unit.unitId),
      incompleteUnitIds: [],
      findings: [],
      reasons: [],
      invalidFindingCount: 0,
    });
  });

  it('builds host-owned findings with rubric severity and deterministic IDs', () => {
    const first = validate(response({ findings: [rawFinding()] }));
    const again = validate(response({ findings: [rawFinding({ title: 'Same location, different wording' })] }));
    const finding = first.findings[0]!;

    expect(finding).toMatchObject({ status: 'candidate', category: 'sql-injection', severity: 'high', confidence: 'medium' });
    expect(finding.findingId).toMatch(/^security-finding:[a-f0-9]{64}$/u);
    expect(again.findings[0]?.findingId).toBe(finding.findingId);
    expect(securityFindingSchema.parse(finding)).toEqual(finding);
    expect(finding.severityRationale).toMatch(/model-classified/u);
    expect(finding.severityRationale).toContain('sensitive-data-access');
    expect(finding.severityRationale).toContain('authenticated');
    expect(first.evaluatedUnitIds).toContain(route.unitId);
  });

  it('accepts Japanese narratives', () => {
    const result = validate(response({ findings: [rawFinding({ title: '注文 ID の所有者を確認していない', impact: '他の利用者の注文を参照できる' })] }));
    expect(result.findings[0]?.title).toBe('注文 ID の所有者を確認していない');
  });

  it('drops invalid findings and marks only their unit incomplete', () => {
    const variants = [
      rawFinding({ findingId: 'security-finding:abc', severity: 'critical', status: 'confirmed' }),
      rawFinding({ category: 'misc' }),
      rawFinding({ cweIds: ['CWE-0'] }),
      rawFinding({ evidenceRefs: [{ snippetId: snippetIdForUnitId(otherBatch.units[0]!.unitId), path: 'src/orders.ts', revision: 'current', startLine: 19, endLine: 19, role: 'sink' }] }),
      rawFinding({ evidenceRefs: [{ snippetId: routeSnippetId, path: 'src/auth.ts', revision: 'current', startLine: 22, endLine: 24, role: 'sink' }] }),
      rawFinding({ evidenceRefs: [{ snippetId: routeSnippetId, path: 'src/orders.ts', revision: 'base', startLine: 22, endLine: 24, role: 'sink' }] }),
      rawFinding({ evidenceRefs: [{ snippetId: routeSnippetId, path: 'src/orders.ts', revision: 'current', startLine: 22, endLine: 30, role: 'sink' }] }),
      rawFinding({ evidenceRefs: [{ snippetId: routeSnippetId, path: '../orders.ts', revision: 'current', startLine: 22, endLine: 24, role: 'sink' }] }),
      rawFinding({ primaryLocation: { path: 'src/orders.ts', revision: 'current', startLine: 30, endLine: 30 } }),
    ];
    for (const variant of variants) {
      const result = validate(response({ findings: [variant] }));
      expect(result.findings).toEqual([]);
      expect(result.invalidFindingCount).toBe(1);
      expect(result.incompleteUnitIds).toEqual([route.unitId]);
      expect(result.evaluatedUnitIds).toHaveLength(batch.units.length - 1);
      expect(result.reasons).toEqual(['invalid-finding']);
    }
  });

  it('rejects references to a file that exists but was not sent in this batch', () => {
    const remove = otherBatch.units[0]!;
    const target = { ...otherBatch };
    const result = validate({
      schemaVersion: 1,
      batchId: target.batchId,
      units: target.units.map((unit) => ({ unitId: unit.unitId, status: 'evaluated' })),
      findings: [rawFinding({
        unitId: remove.unitId,
        primaryLocation: { path: 'src/auth.ts', revision: 'current', startLine: 2, endLine: 2 },
        evidenceRefs: [{ snippetId: guardSnippet.snippetId, path: 'src/auth.ts', revision: 'current', startLine: 1, endLine: 4, role: 'guard' }],
      })],
    }, target);
    expect(result.findings).toEqual([]);
    expect(result.incompleteUnitIds).toEqual([remove.unitId]);
  });

  it('marks the whole batch incomplete when an invalid finding cannot be attributed to a unit', () => {
    const result = validate(response({ findings: [rawFinding({ unitId: 'unit:ffffffffffffffff' }), rawFinding()] }));
    expect(result.evaluatedUnitIds).toEqual([]);
    expect(result.incompleteUnitIds).toEqual(batch.units.map((unit) => unit.unitId));
    expect(result.findings).toHaveLength(1);
    expect(result.invalidFindingCount).toBe(1);
    expect(result.reasons).toEqual(['invalid-finding-unattributed']);
  });

  it('never treats missing or insufficient-context units as evaluated', () => {
    const [first, ...rest] = batch.units;
    const missing = validate(response({ units: rest.map((unit) => ({ unitId: unit.unitId, status: 'evaluated' })) }));
    expect(missing.incompleteUnitIds).toEqual([first!.unitId]);
    expect(missing.reasons).toEqual(['unit-missing']);

    const insufficient = validate(response({
      units: batch.units.map((unit) => ({ unitId: unit.unitId, status: unit.unitId === route.unitId ? 'insufficient-context' : 'evaluated' })),
      findings: [rawFinding({ confidence: 'high' })],
    }));
    expect(insufficient.incompleteUnitIds).toEqual([route.unitId]);
    expect(insufficient.reasons).toEqual(['insufficient-context']);
    expect(insufficient.findings[0]?.confidence).toBe('low');
  });

  it('fails the whole batch for envelope mismatches', () => {
    const units = batch.units.map((unit) => ({ unitId: unit.unitId, status: 'evaluated' }));
    for (const value of [
      response({ batchId: 'batch:99' }),
      response({ units: [...units, { unitId: 'unit:ffffffffffffffff', status: 'evaluated' }] }),
      response({ units: [...units, units[0]] }),
    ]) {
      expect(() => validate(value)).toThrow(SecurityResponseError);
    }
  });

  it('merges reports for the same location deterministically and records the conflict', () => {
    const result = validate(response({
      findings: [
        rawFinding({ impactClass: 'limited-data-access', confidence: 'high' }),
        rawFinding({
          evidenceRefs: [
            { snippetId: routeSnippetId, path: 'src/orders.ts', revision: 'current', startLine: 22, endLine: 24, role: 'sink' },
            { snippetId: guardSnippet.snippetId, path: 'src/auth.ts', revision: 'current', startLine: 1, endLine: 4, role: 'guard' },
          ],
        }),
        rawFinding({ category: 'authorization', cweIds: ['CWE-862'] }),
      ],
    }));
    const sql = result.findings.find((finding) => finding.category === 'sql-injection')!;

    expect(result.findings).toHaveLength(2);
    expect(sql.severity).toBe('high');
    expect(sql.confidence).toBe('low');
    expect(sql.evidenceRefs).toHaveLength(2);
    expect(sql.limitations.join(' ')).toMatch(/merged/iu);
  });
});

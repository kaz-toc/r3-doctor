import { describe, expect, it } from 'vitest';

import { filterSecuritySnippet } from '../../src/addons/security/outbound-filter.js';
import { buildSecurityPlan } from '../../src/addons/security/plan.js';
import { snippetIdForUnitId } from '../../src/addons/security/prompt.js';
import { parseSecurityResponse, validateSecurityResponse } from '../../src/addons/security/response.js';
import type { SecurityBatch, SecurityUnit } from '../../src/addons/security/types.js';
import { securityPolicy, securitySnapshot, sha256 } from '../helpers/security-snapshot.js';

function findingFor(unit: SecurityUnit) {
  const location = { path: unit.path, revision: unit.revision, startLine: unit.startLine, endLine: unit.endLine };
  return {
    unitId: unit.unitId, category: 'authorization', cweIds: ['CWE-862'],
    impactClass: 'sensitive-data-access', attackPrerequisites: 'none',
    severityRationale: 'Request input selects sensitive records.',
    confidence: 'high', confidenceRationale: 'The request and query are visible.',
    title: `Missing authorization at line ${unit.startLine}`,
    primaryLocation: location,
    evidenceRefs: [{ ...location, snippetId: snippetIdForUnitId(unit.unitId), role: 'sink' }],
    preconditions: [], attackPath: 'Send a crafted request.', impact: 'Read another user record.',
    remediation: 'Check ownership.', verification: 'Test access by another user.', limitations: [],
  };
}

function validate(batch: SecurityBatch, findings: unknown[]) {
  return validateSecurityResponse(parseSecurityResponse(JSON.stringify({
    schemaVersion: 1, batchId: batch.batchId,
    units: batch.units.map((unit) => ({ unitId: unit.unitId, status: 'evaluated' })), findings,
  })), batch);
}

describe('PR 28 security context regressions', () => {
  it.each([
    'export const password: string = "example-secret";',
    'export const password =\n  "example-secret";',
    'export const password: string =\n  "example-secret";',
    'export const password = `example-secret\nsecond-secret-line`;',
    'export class Config { private password: string = "example-secret"; }',
    'export const config = { password:\n  "example-secret" };',
  ])('REG-2026-030 masks typed and multiline secret assignments: %s', (assignment) => {
    const content = `${assignment}\nexport const ok = true;`;
    const filtered = filterSecuritySnippet({
      snippetId: 'snippet:1', path: 'src/config.ts', revision: 'current',
      startLine: 1, endLine: content.split('\n').length, content, contentHash: sha256(content),
    });
    expect(filtered.snippet).not.toBeNull();
    expect(filtered.snippet!.content).not.toContain('example-secret');
    expect(filtered.snippet!.content).not.toContain('second-secret-line');
    expect(filtered.snippet!.content.split('\n')).toHaveLength(content.split('\n').length);
    expect(filtered.snippet!.content.split('\n').at(-1)).toBe('export const ok = true;');
    expect(filtered.snippet!.contentHash).toBe(sha256(filtered.snippet!.content));
    expect(filtered.redactedLines.length).toBeGreaterThan(0);

    const plan = buildSecurityPlan({ snapshot: securitySnapshot({ 'src/config.ts': content }), policy: securityPolicy() });
    expect(plan.batches.length).toBeGreaterThan(0);
    for (const batch of plan.batches) {
      expect(batch.prompt).not.toContain('example-secret');
      expect(batch.prompt).not.toContain('second-secret-line');
    }
  });

  it.each([
    ['current', 30], ['base', 30], ['current', 210], ['base', 210],
  ] as const)('REG-2026-031 masks PEM across windows (%s, %i payload lines)', (revision, payloadLines) => {
    const payload = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=';
    const content = [
      'export function config() {',
      ...Array.from({ length: 118 }, () => '  // padding'),
      '  const key = `-----BEGIN PRIVATE KEY-----',
      ...Array.from({ length: payloadLines }, () => payload),
      '-----END PRIVATE KEY-----`;',
      ...Array.from({ length: 25 }, () => '  // padding'),
      '  return key;', '}',
    ].join('\n');
    const plan = buildSecurityPlan({
      snapshot: securitySnapshot(revision === 'current' ? { 'src/config.ts': content } : {}),
      policy: securityPolicy(),
      ...(revision === 'base' ? { changes: {
        status: 'complete' as const, baseSha: 'a'.repeat(40), reasons: [],
        changes: [{ kind: 'deleted' as const, currentPath: null, current: null,
          basePath: 'src/config.ts', base: { startLine: 1, endLine: content.split('\n').length },
          baseContent: content, baseContentHash: sha256(content) }],
      } } : {}),
    });
    const snippets = plan.batches.flatMap((batch) => batch.snippets);
    expect(snippets.length).toBeGreaterThanOrEqual(2);
    expect(snippets.some((snippet) => snippet.startLine > 120)).toBe(true);
    for (const batch of plan.batches) expect(batch.prompt).not.toContain(payload);
    for (const snippet of snippets) {
      expect(snippet.content).not.toContain(payload);
      expect(snippet.revision).toBe(revision);
      expect(snippet.content.split('\n')).toHaveLength(snippet.endLine - snippet.startLine + 1);
      expect(snippet.contentHash).toBe(sha256(snippet.content));
      expect(snippet.redactedLines).toContain(Math.max(snippet.startLine, 120));
      expect(snippet.redactedLines!.every((line) => line >= snippet.startLine && line <= snippet.endLine)).toBe(true);
    }
    if (payloadLines === 210) {
      expect(plan.coverage.incompleteByReason['masked-unanalyzable']).toBe(1);
      expect(plan.coverage.selectedUnits).toBe(2);
    }
  });

  it('REG-2026-032 sends class field initializers and static blocks alongside methods', () => {
    const plan = buildSecurityPlan({ snapshot: securitySnapshot({ 'src/service.ts': [
      'export class Service {',
      '  value = eval(process.argv[2]);',
      '  static seed = eval(process.argv[3]);',
      '  static { eval(process.argv[4]); }',
      '  run() { return 1; }',
      '}',
    ].join('\n') }), policy: securityPolicy() });
    const units = plan.batches.flatMap((batch) => batch.units);
    expect(units.map((unit) => unit.startLine).sort()).toEqual([2, 3, 4, 5]);
    expect(plan.coverage).toMatchObject({ eligibleUnits: 4, selectedUnits: 4, incompleteByReason: {} });
    for (const argument of [2, 3, 4]) {
      expect(plan.batches.some((batch) => batch.prompt.includes(`eval(process.argv[${argument}])`))).toBe(true);
    }
  });

  it('REG-2026-033 retains findings from distinct handlers while merging duplicate reports', () => {
    const content = [
      'router.get("/a", (req, res) => {', '  res.send(db.query(req.query.a));', '});',
      'router.get("/b", (req, res) => {', '  res.send(db.query(req.query.b));', '});',
    ].join('\n');
    const planFor = (source: string) => buildSecurityPlan({ snapshot: securitySnapshot({ 'src/routes.ts': source }), policy: securityPolicy() });
    const batch = planFor(content).batches[0]!;
    expect(batch.units).toHaveLength(2);
    const findings = batch.units.map(findingFor);
    const result = validate(batch, [...findings, { ...findings[0], title: 'Duplicate report of first handler' }]);
    expect(result.invalidFindingCount).toBe(0);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((finding) => finding.primaryLocation.startLine).sort()).toEqual([1, 4]);
    expect(new Set(result.findings.map((finding) => finding.findingId)).size).toBe(2);
    expect(result.findings.every((finding) => finding.evidenceRefs.length === 1)).toBe(true);
    expect(result.findings.filter((finding) => finding.limitations.some((note) => note.includes('Merged 2')))).toHaveLength(1);

    const shifted = planFor(`\n${content}`).batches[0]!;
    expect(validate(shifted, shifted.units.map(findingFor)).findings.map((finding) => finding.findingId))
      .toEqual(result.findings.map((finding) => finding.findingId));
  });

  it.each([
    "static roles = ['admin'];",
    "static { registerGuard(Auth, ['admin']); }",
  ])('REG-2026-032 preserves imports of classes split into initialization units: %s', (member) => {
    const snapshot = securitySnapshot({
      'src/auth.ts': `export class Auth { ${member} }`,
      'src/route.ts': "import { Auth } from './auth';\nexport function route(req) { if (!Auth.roles.includes(req.user.role)) throw new Error(); return db.query(req.query.q); }",
    });
    const complete = buildSecurityPlan({ snapshot, policy: securityPolicy() });
    const route = complete.batches.flatMap((batch) => batch.units).find((unit) => unit.path === 'src/route.ts')!;
    expect(route.relatedPaths).toContain('src/auth.ts');
    const routeBatch = complete.batches.find((batch) => batch.units.some((unit) => unit.unitId === route.unitId))!;
    expect(routeBatch.snippets.some((snippet) => snippet.path === 'src/auth.ts' && snippet.content.includes(member))).toBe(true);

    const limited = buildSecurityPlan({ snapshot, policy: securityPolicy({}, { maxFiles: 1 }) });
    const batch = limited.batches[0]!;
    expect(batch.snippets.map((snippet) => snippet.path)).toEqual(['src/route.ts']);
    expect(batch.units[0]!.limitations).toContain('related-context-omitted');
    expect(validate(batch, [findingFor(batch.units[0]!)]).findings[0]!.confidence).toBe('low');
  });

  it.each(['generated/auth', 'secrets', 'auth'])('REG-2026-034 caps confidence when the imported guard is excluded: %s', (target) => {
    const plan = buildSecurityPlan({ snapshot: securitySnapshot({
      'src/route.ts': `import { requireUser } from './${target}';\nexport function route(req) { requireUser(req); return db.query(req.query.q); }`,
      [`src/${target}.ts`]: 'export function requireUser(req) { if (!req.user) throw new Error(); }'
        + (target === 'auth' ? `\n//${'a'.repeat(1_048_576)}` : ''),
    }), policy: securityPolicy() });
    const batch = plan.batches[0]!;
    const route = batch.units.find((unit) => unit.path === 'src/route.ts')!;
    expect(batch.snippets.map((snippet) => snippet.path)).toEqual(['src/route.ts']);
    expect(route.limitations).toContain('unresolved-import');
    const result = validate(batch, [findingFor(route)]);
    expect(result.invalidFindingCount).toBe(0);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.confidence).toBe('low');
  });
});

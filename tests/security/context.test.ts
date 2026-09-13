import { describe, expect, it } from 'vitest';

import {
  collectSecurityUnits,
  SECURITY_UNIT_WINDOW_LINES,
  SECURITY_UNIT_WINDOW_OVERLAP,
} from '../../src/addons/security/context.js';
import { defaultConfig } from '../../src/shared/config.js';
import { AUTH_SOURCE, DB_SOURCE, ORDERS_SOURCE, securitySnapshot } from '../helpers/security-snapshot.js';

const snapshot = securitySnapshot({ 'src/orders.ts': ORDERS_SOURCE, 'src/auth.ts': AUTH_SOURCE, 'src/db.ts': DB_SOURCE });

function unit(units: ReturnType<typeof collectSecurityUnits>, path: string, anchor: string) {
  const found = units.find((candidate) => candidate.path === path && candidate.anchor === anchor);
  if (!found) throw new Error(`missing unit ${path} ${anchor}`);
  return found;
}

describe('security unit collection', () => {
  it('splits functions, methods, handlers, and unowned top-level statements into units', () => {
    const units = collectSecurityUnits(snapshot).filter((candidate) => candidate.path === 'src/orders.ts');

    expect(units.map((candidate) => [candidate.anchor, candidate.startLine, candidate.endLine])).toEqual([
      ['statements', 5, 6],
      ['function:getOrder', 8, 11],
      ['function:formatOrder', 13, 15],
      ['constructor:OrderService', 18, 18],
      ['method:OrderService.remove', 19, 19],
      ['call:router.post', 22, 24],
      ['function:dispatch', 26, 29],
    ]);
    expect(units.every((candidate) => candidate.revision === 'current' && /^unit:[a-f0-9]{16}$/u.test(candidate.unitId)))
      .toBe(true);
  });

  it('relates imports, callers, guards, and local calls, and records unresolved dispatch', () => {
    const units = collectSecurityUnits(snapshot);
    const route = unit(units, 'src/orders.ts', 'call:router.post');
    const guard = unit(units, 'src/auth.ts', 'function:requireUser');

    expect(route.relatedUnitIds).toContain(guard.unitId);
    expect(route.relatedPaths).toEqual(['src/auth.ts', 'src/db.ts']);
    expect(guard.relatedUnitIds).toContain(route.unitId);
    expect(unit(units, 'src/orders.ts', 'function:getOrder').relatedUnitIds)
      .toContain(unit(units, 'src/orders.ts', 'function:formatOrder').unitId);
    expect(unit(units, 'src/orders.ts', 'function:dispatch').limitations)
      .toEqual(expect.arrayContaining(['dynamic-import', 'computed-call']));
    expect(unit(units, 'src/orders.ts', 'statements').limitations).toContain('external-middleware');
  });

  it('records unresolved relative imports instead of guessing a target', () => {
    const units = collectSecurityUnits(securitySnapshot({
      'src/a.ts': "import { check } from './missing';\nexport function handle(req) {\n  return check(req);\n}\n",
    }));
    expect(unit(units, 'src/a.ts', 'function:handle').limitations).toContain('unresolved-import');
  });

  it('splits large functions into overlapping windows without dropping lines', () => {
    const body = Array.from({ length: 400 }, (_, index) => `  const value${index} = ${index};`);
    const windows = collectSecurityUnits(securitySnapshot({
      'src/big.ts': ['export function big() {', ...body, '}'].join('\n'),
    }));

    expect(windows[0]).toMatchObject({ startLine: 1, endLine: SECURITY_UNIT_WINDOW_LINES });
    windows.slice(1).forEach((window, index) => {
      expect(window.startLine).toBe(windows[index]!.endLine - SECURITY_UNIT_WINDOW_OVERLAP + 1);
      expect(window.endLine - window.startLine + 1).toBeLessThanOrEqual(SECURITY_UNIT_WINDOW_LINES);
    });
    expect(windows.at(-1)?.endLine).toBe(402);
    expect(new Set(windows.map((window) => window.anchor.split('#')[0]))).toEqual(new Set(['function:big']));
  });

  it('prioritizes handlers with external input and sinks but still lists plain code', () => {
    const units = collectSecurityUnits(securitySnapshot(
      {
        'src/orders.ts': ORDERS_SOURCE,
        'src/auth.ts': AUTH_SOURCE,
        'src/db.ts': DB_SOURCE,
        'src/math.ts': 'export function add(a, b) {\n  return a + b;\n}\n',
      },
      { config: { ...defaultConfig, diagnosticSkipRoots: ['src'] } },
    ));
    const add = unit(units, 'src/math.ts', 'function:add');

    expect(add.priority).toBe(0);
    expect(unit(units, 'src/orders.ts', 'function:getOrder').priority).toBeGreaterThan(add.priority);
    expect(unit(units, 'src/orders.ts', 'call:router.post').priority)
      .toBeGreaterThan(unit(units, 'src/orders.ts', 'function:formatOrder').priority);
  });

  it('collects no units from empty or non TypeScript/JavaScript sources', () => {
    expect(collectSecurityUnits(securitySnapshot({ 'src/empty.ts': '', 'tools/build.py': 'print(1)\n' }))).toEqual([]);
  });
});

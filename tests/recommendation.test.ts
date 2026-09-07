import { describe, expect, it } from 'vitest';

import {
  buildInterventions,
  computePriorityScore,
  computeScopeFactor,
  displayTargetPaths,
} from '../src/recommendation/rules.js';
import type { Evidence, RiskCluster } from '../src/schema/report.v1.js';
import { provisionalEvidenceDetails } from '../src/schema/report.v1.js';

function makeEvidence(
  overrides: Partial<Evidence> & Pick<Evidence, 'evidenceId' | 'signalId' | 'axisId' | 'severity' | 'message'>,
): Evidence {
  const details = provisionalEvidenceDetails(overrides.severity, overrides.path);
  return {
    ...details,
    source: 'deterministic',
    ...overrides,
    strength: overrides.strength ?? details.strength,
    severity: overrides.severity,
  };
}

function makeCluster(overrides: Partial<RiskCluster> & Pick<RiskCluster, 'clusterId' | 'mechanismId' | 'score'>): RiskCluster {
  return {
    title: `${overrides.mechanismId} cluster`,
    confidence: 0.67,
    axisId: 'structural-fragility',
    paths: ['src/a.ts'],
    failureMechanism: overrides.mechanismId,
    triggerChanges: [],
    evidenceIds: ['evidence:dep-cycle:src/a.ts'],
    ...overrides,
  };
}

describe('intervention target path filtering', () => {
  it('excludes harness and fixture paths from intervention targets', () => {
    const evidence: Evidence[] = [
      makeEvidence({
        evidenceId: 'evidence:dep-cycle:harness/governance.mjs->harness/paths.mjs',
        signalId: 'dep-cycle',
        axisId: 'structural-fragility',
        path: 'harness/governance.mjs',
        severity: 'high',
        message: 'cycle',
      }),
      makeEvidence({
        evidenceId: 'evidence:dep-cycle:src/core.ts->src/util.ts',
        signalId: 'dep-cycle',
        axisId: 'structural-fragility',
        path: 'src/core.ts',
        severity: 'high',
        message: 'cycle',
        metrics: { cycle: 'src/core.ts->src/util.ts' },
      }),
    ];
    const clusters: RiskCluster[] = [
      makeCluster({
        clusterId: 'cluster:structural-fragility:dependency-cycle:1',
        mechanismId: 'dependency-cycle',
        score: 75,
        paths: ['src/core.ts'],
        evidenceIds: ['evidence:dep-cycle:src/core.ts->src/util.ts'],
      }),
    ];

    const interventions = buildInterventions(evidence, clusters, ['harness']);

    expect(interventions).toHaveLength(1);
    expect(interventions[0]?.targetPaths).toEqual(['src/core.ts']);
    expect(interventions[0]?.targetPaths).not.toContain('harness/governance.mjs');
  });

  it('omits interventions when only non-product paths remain', () => {
    const evidence: Evidence[] = [
      makeEvidence({
        evidenceId: 'evidence:dep-cycle:tests/fixtures/fragile-cart/src/index.ts',
        signalId: 'dep-cycle',
        axisId: 'structural-fragility',
        path: 'tests/fixtures/fragile-cart/src/index.ts',
        severity: 'high',
        message: 'cycle',
      }),
    ];

    const interventions = buildInterventions(evidence, [], []);
    expect(interventions).toHaveLength(0);
  });
});

describe('cluster-specific intervention ranking', () => {
  it('uses one Evidence for both primary path and strongest metric', () => {
    const evidence = [
      makeEvidence({
        evidenceId: 'evidence:high-fan-out:src/a.ts',
        signalId: 'high-fan-out',
        axisId: 'change-blast-radius',
        path: 'src/a.ts',
        severity: 'high',
        strength: 100,
        message: 'fan-out',
        metrics: { fanOut: 25 },
      }),
      makeEvidence({
        evidenceId: 'evidence:high-fan-in:src/b.ts',
        signalId: 'high-fan-in',
        axisId: 'change-blast-radius',
        path: 'src/b.ts',
        severity: 'high',
        strength: 100,
        message: 'fan-in',
        metrics: { fanIn: 33 },
      }),
    ];
    const cluster = makeCluster({
      clusterId: 'cluster:change-blast-radius:high-connectivity:1',
      mechanismId: 'high-connectivity',
      axisId: 'change-blast-radius',
      score: 90,
      paths: ['src/a.ts', 'src/b.ts'],
      evidenceIds: evidence.map((item) => item.evidenceId),
    });

    const [action] = buildInterventions(evidence, [cluster], [], 1);

    expect(action?.rationale).toContain('src/b.ts');
    expect(action?.rationale).toContain('fan-in=33');
    expect(action?.rationale).not.toContain('src/a.ts');
  });

  it('uses the lower repository and cluster confidence for priority', () => {
    const evidence = [makeEvidence({
      evidenceId: 'evidence:large-file:src/a.ts',
      signalId: 'large-file',
      axisId: 'structural-fragility',
      path: 'src/a.ts',
      severity: 'high',
      message: 'large',
      metrics: { lines: 900 },
    })];
    const cluster = makeCluster({
      clusterId: 'cluster:structural-fragility:large-file:1',
      mechanismId: 'large-file',
      score: 80,
      confidence: 0.4,
      paths: ['src/a.ts'],
      evidenceIds: [evidence[0]!.evidenceId],
    });

    const [action] = buildInterventions(evidence, [cluster], [], 0.9);

    expect(action?.priorityScore).toBe(computePriorityScore(80, 0.4, 1, 'medium'));
  });

  it('assigns sequential priorities from priorityScore', () => {
    const evidence: Evidence[] = [
      makeEvidence({
        evidenceId: 'evidence:dep-cycle:src/a.ts',
        signalId: 'dep-cycle',
        axisId: 'structural-fragility',
        path: 'src/a.ts',
        severity: 'high',
        strength: 90,
        message: 'cycle a',
        metrics: { cycle: 'src/a.ts->src/b.ts' },
      }),
      makeEvidence({
        evidenceId: 'evidence:large-file:src/b.ts',
        signalId: 'large-file',
        axisId: 'structural-fragility',
        path: 'src/b.ts',
        severity: 'medium',
        strength: 60,
        message: 'large',
        metrics: { lines: 500 },
      }),
      makeEvidence({
        evidenceId: 'evidence:barrel-reexport:src/c.ts',
        signalId: 'barrel-reexport',
        axisId: 'structural-fragility',
        path: 'src/c.ts',
        severity: 'medium',
        strength: 50,
        message: 'barrel',
      }),
    ];
    const topCluster = makeCluster({
      clusterId: 'cluster:structural-fragility:dependency-cycle:1',
      mechanismId: 'dependency-cycle',
      score: 80,
      paths: ['src/a.ts'],
      evidenceIds: ['evidence:dep-cycle:src/a.ts'],
    });
    const middleCluster = makeCluster({
      clusterId: 'cluster:structural-fragility:large-file:1',
      mechanismId: 'large-file',
      score: 60,
      paths: ['src/b.ts'],
      evidenceIds: ['evidence:large-file:src/b.ts'],
    });
    const lowCluster = makeCluster({
      clusterId: 'cluster:structural-fragility:barrel-export:1',
      mechanismId: 'barrel-export',
      score: 40,
      paths: ['src/c.ts'],
      evidenceIds: ['evidence:barrel-reexport:src/c.ts'],
    });
    const clusters = [topCluster, middleCluster, lowCluster];

    const actions = buildInterventions(evidence, clusters, [], 0.9);

    expect(actions.map((action) => action.priority)).toEqual([1, 2, 3]);
    const topAction = actions.find((action) => action.linkedClusterIds.includes(topCluster.clusterId));
    expect(topAction).toMatchObject({
      linkedClusterIds: [topCluster.clusterId],
      targetPaths: expect.arrayContaining([topCluster.paths[0]]),
      rationale: expect.stringContaining(topCluster.mechanismId),
      firstStep: expect.stringContaining(topCluster.paths[0]!),
    });
    expect(actions[0]?.priorityScore).toBeGreaterThan(actions[1]?.priorityScore ?? 0);
    expect(actions[1]?.priorityScore).toBeGreaterThan(actions[2]?.priorityScore ?? 0);
  });

  it('creates one intervention per cluster', () => {
    const evidence: Evidence[] = [
      makeEvidence({
        evidenceId: 'evidence:dep-cycle:src/a.ts',
        signalId: 'dep-cycle',
        axisId: 'structural-fragility',
        path: 'src/a.ts',
        severity: 'high',
        message: 'cycle',
      }),
      makeEvidence({
        evidenceId: 'evidence:large-file:src/b.ts',
        signalId: 'large-file',
        axisId: 'structural-fragility',
        path: 'src/b.ts',
        severity: 'medium',
        message: 'large',
        metrics: { lines: 500 },
      }),
    ];
    const clusters = [
      makeCluster({
        clusterId: 'cluster:structural-fragility:dependency-cycle:1',
        mechanismId: 'dependency-cycle',
        score: 70,
        paths: ['src/a.ts'],
        evidenceIds: ['evidence:dep-cycle:src/a.ts'],
      }),
      makeCluster({
        clusterId: 'cluster:structural-fragility:large-file:1',
        mechanismId: 'large-file',
        score: 55,
        paths: ['src/b.ts'],
        evidenceIds: ['evidence:large-file:src/b.ts'],
      }),
    ];

    const actions = buildInterventions(evidence, clusters, [], 1);
    expect(actions).toHaveLength(2);
    expect(new Set(actions.flatMap((action) => action.linkedClusterIds))).toEqual(
      new Set(clusters.map((cluster) => cluster.clusterId)),
    );
  });

  it('computes priorityScore from cluster score, confidence, scope, and cost', () => {
    const scopeFactor = computeScopeFactor(3);
    expect(scopeFactor).toBeCloseTo(1 + Math.min(0.5, Math.log2(4) / 10), 5);
    expect(computePriorityScore(80, 0.9, 3, 'medium')).toBe(
      Number(((80 * 0.9 * scopeFactor) / 2).toFixed(2)),
    );
  });

  it('keeps all target paths in data and limits display to top 3', () => {
    const targetPaths = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'];
    expect(displayTargetPaths(targetPaths)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(targetPaths).toHaveLength(5);
  });

  it('separates immediate verification from verification horizon', () => {
    const evidence = [
      makeEvidence({
        evidenceId: 'evidence:dep-cycle:src/a.ts',
        signalId: 'dep-cycle',
        axisId: 'structural-fragility',
        path: 'src/a.ts',
        severity: 'high',
        message: 'cycle',
        metrics: { cycle: 'src/a.ts->src/b.ts' },
      }),
    ];
    const clusters = [
      makeCluster({
        clusterId: 'cluster:structural-fragility:dependency-cycle:1',
        mechanismId: 'dependency-cycle',
        score: 70,
        paths: ['src/a.ts'],
        evidenceIds: ['evidence:dep-cycle:src/a.ts'],
      }),
    ];

    const actions = buildInterventions(evidence, clusters, [], 1);
    for (const action of actions) {
      expect(action.verification.length).toBeGreaterThan(0);
      expect(action.verificationHorizon.length).toBeGreaterThan(0);
      expect(action.verification).not.toEqual(action.verificationHorizon);
      expect(action.verification).toContain('r3-doctor scan . --format json');
      expect(action.verification).toContain(evidence[0]!.evidenceId);
    }
  });

  it('uses churnDays in churn cluster verification horizon', () => {
    const evidence = [
      makeEvidence({
        evidenceId: 'evidence:git-churn:src/hot.ts',
        signalId: 'git-churn',
        axisId: 'change-volatility',
        path: 'src/hot.ts',
        severity: 'medium',
        message: 'churn',
        metrics: { churn: 12, days: 30 },
      }),
    ];
    const clusters = [
      makeCluster({
        clusterId: 'cluster:change-volatility:volatility:1',
        mechanismId: 'volatility',
        score: 65,
        axisId: 'change-volatility',
        paths: ['src/hot.ts'],
        evidenceIds: ['evidence:git-churn:src/hot.ts'],
      }),
    ];

    const actions = buildInterventions(evidence, clusters, [], 1, 30);
    expect(actions[0]?.verificationHorizon).toContain('30');
    expect(actions[0]?.firstStep).toContain('churn=');
  });
});

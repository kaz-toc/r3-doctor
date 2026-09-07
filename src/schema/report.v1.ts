import { z } from 'zod';

export const ASSESSMENT_CONTRACT_VERSION = 3;
export const REPORT_SCHEMA_VERSION = 1;
export const BASELINE_SCHEMA_VERSION = 3;
export const DIFF_SCHEMA_VERSION = 2;

export const riskAxisIdSchema = z.enum([
  'structural-fragility',
  'change-blast-radius',
  'verification-gap',
  'change-volatility',
  'semantic-ambiguity',
]);

export const signalIdSchema = z.enum([
  'dep-cycle',
  'high-fan-out',
  'high-fan-in',
  'large-file',
  'missing-test-pair',
  'git-churn',
  'barrel-reexport',
  'deep-nesting',
  'unresolved-import',
  'semantic-ambiguity',
]);

export const sourceLanguageSchema = z.enum(['typescript-javascript', 'python', 'go']);

export const evidenceIdSchema = z.string().regex(/^evidence:/);
export const clusterIdSchema = z.string().regex(/^cluster:/);
export const interventionIdSchema = z.string().regex(/^intervention:/);
export const findingIdSchema = z.string().regex(/^finding:/);

export const evidenceSchema = z
  .object({
    evidenceId: evidenceIdSchema,
    signalId: signalIdSchema,
    axisId: riskAxisIdSchema,
    path: z.string().optional(),
    severity: z.enum(['low', 'medium', 'high']),
    message: z.string(),
    metrics: z.record(z.union([z.number(), z.string(), z.boolean()])).optional(),
    source: z.enum(['deterministic', 'semantic']),
  })
  .strict();

export const semanticFindingSchema = z
  .object({
    findingId: findingIdSchema,
    axisId: riskAxisIdSchema,
    path: z.string().optional(),
    summary: z.string(),
    relatedEvidenceIds: z.array(evidenceIdSchema),
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((finding, ctx) => {
    if (!finding.path && finding.relatedEvidenceIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'semantic finding requires path or relatedEvidenceIds',
      });
    }
  });

export const riskClusterSchema = z
  .object({
    clusterId: clusterIdSchema,
    title: z.string(),
    score: z.number().min(0).max(100),
    confidence: z.number().min(0).max(1),
    axisId: riskAxisIdSchema,
    mechanismId: z.string(),
    paths: z.array(z.string()),
    failureMechanism: z.string(),
    triggerChanges: z.array(z.string()),
    evidenceIds: z.array(evidenceIdSchema),
  })
  .strict();

export const axisAssessmentSchema = z
  .object({
    axisId: riskAxisIdSchema,
    name: z.string(),
    score: z.number().min(0).max(100),
    contribution: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    unevaluated: z.boolean().default(false),
  })
  .strict();

export const interventionSchema = z
  .object({
    interventionId: interventionIdSchema,
    priority: z.number().int().positive(),
    title: z.string(),
    description: z.string(),
    kind: z.enum(['test', 'structure', 'process']),
    targetPaths: z.array(z.string()),
    linkedSignalIds: z.array(signalIdSchema),
    linkedClusterIds: z.array(clusterIdSchema),
    expectedEffect: z.string(),
    verification: z.string(),
    cost: z.enum(['low', 'medium', 'high']),
  })
  .strict();

export const repositoryAssessmentSchema = z
  .object({
    regressionRiskScore: z.number().min(0).max(100),
    confidence: z.number().min(0).max(1),
    disclaimer: z.string(),
  })
  .strict();

export const capabilityResultSchema = z
  .object({
    language: sourceLanguageSchema,
    contractVersion: z.number().int().positive(),
    completeness: z.enum(['full', 'partial']),
    supportedSignals: z.array(signalIdSchema),
    unevaluatedSignals: z.array(signalIdSchema),
    analyzerId: z.string(),
    analyzerImplementationVersion: z.string().trim().min(1),
  })
  .strict();

export const reportMetadataSchema = z
  .object({
    schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
    assessmentContractVersion: z.literal(ASSESSMENT_CONTRACT_VERSION),
    generatedAt: z.string(),
    inputId: z.string(),
    repositoryPath: z.string(),
    unitId: z.string().optional(),
    analyzers: z.array(z.string()),
    llmProvider: z.string().optional(),
    semanticProviderImplementationVersion: z.string().trim().min(1).optional(),
    truncated: z.boolean(),
    unevaluatedAreas: z.array(z.string()),
    semanticProviderStatus: z.enum(['available', 'unavailable', 'not-configured', 'failed']).optional(),
    semanticProviderReason: z.string().optional(),
    redactionPolicyFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .strict();

export const diagnosisReportSchema = z
  .object({
    metadata: reportMetadataSchema,
    repository: repositoryAssessmentSchema,
    axes: z.array(axisAssessmentSchema),
    clusters: z.array(riskClusterSchema),
    evidence: z.array(evidenceSchema),
    semanticFindings: z.array(semanticFindingSchema),
    interventions: z.array(interventionSchema),
    capabilities: z.array(capabilityResultSchema),
  })
  .strict()
  .superRefine((report, ctx) => {
    if (
      report.metadata.semanticProviderStatus === 'available' &&
      (!report.metadata.llmProvider || !report.metadata.semanticProviderImplementationVersion)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'available semantic provider requires a name and implementation version',
      });
    }
    const evidenceIdList = report.evidence.map((item) => item.evidenceId);
    const clusterIdList = report.clusters.map((item) => item.clusterId);
    const findingIdList = report.semanticFindings.map((item) => item.findingId);
    const interventionIdList = report.interventions.map((item) => item.interventionId);
    const evidenceIds = new Set(evidenceIdList);
    const clusterIds = new Set(clusterIdList);
    const findingIds = new Set(findingIdList);
    const interventionIds = new Set(interventionIdList);

    const collections: Array<[string, string[], Set<string>]> = [
      ['evidence', evidenceIdList, evidenceIds],
      ['cluster', clusterIdList, clusterIds],
      ['finding', findingIdList, findingIds],
      ['intervention', interventionIdList, interventionIds],
    ];
    for (const [label, ids, uniqueIds] of collections) {
      if (ids.length !== uniqueIds.size) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate ${label} entity IDs` });
      }
    }

    for (const finding of report.semanticFindings) {
      for (const evidenceId of finding.relatedEvidenceIds) {
        if (!evidenceIds.has(evidenceId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `dangling evidence reference in finding ${finding.findingId}: ${evidenceId}`,
          });
        }
      }
    }

    for (const cluster of report.clusters) {
      for (const evidenceId of cluster.evidenceIds) {
        if (!evidenceIds.has(evidenceId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `dangling evidence reference in cluster ${cluster.clusterId}: ${evidenceId}`,
          });
        }
      }
    }

    for (const intervention of report.interventions) {
      for (const clusterId of intervention.linkedClusterIds) {
        if (!clusterIds.has(clusterId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `dangling cluster reference in intervention ${intervention.interventionId}: ${clusterId}`,
          });
        }
      }
    }

    const allIds = [...evidenceIds, ...clusterIds, ...findingIds, ...interventionIds];
    const unique = new Set(allIds);
    if (unique.size !== allIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'report entity IDs must be distinct across evidence, clusters, findings, and interventions',
      });
    }
  });

export const evidenceChangeSchema = z
  .object({
    evidenceId: evidenceIdSchema,
    signalId: signalIdSchema,
    path: z.string().optional(),
    previousSeverity: z.enum(['low', 'medium', 'high']).optional(),
    currentSeverity: z.enum(['low', 'medium', 'high']).optional(),
    message: z.string(),
  })
  .strict();

export const blastRadiusEntrySchema = z
  .object({
    changedFile: z.string(),
    directDependents: z.array(z.string()),
    directDependencies: z.array(z.string()),
    transitiveDependents: z.array(z.string()),
    transitiveDependencies: z.array(z.string()),
    paths: z.array(z.object({ from: z.string(), to: z.string() }).strict()),
  })
  .strict();

export const diffComparisonSchema = z
  .object({
    compatible: z.boolean(),
    reason: z.string().optional(),
    riskDelta: z.number().optional(),
    baselineId: z.string().optional(),
    changedFiles: z.array(z.string()),
    blastRadius: z.array(blastRadiusEntrySchema),
    newSignals: z.array(evidenceChangeSchema),
    worsenedSignals: z.array(evidenceChangeSchema),
    improvedSignals: z.array(evidenceChangeSchema),
  })
  .strict();

export const diffReportSchema = z
  .object({
    schemaVersion: z.literal(DIFF_SCHEMA_VERSION),
    redactionPolicyFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    current: diagnosisReportSchema,
    base: diagnosisReportSchema.optional(),
    comparison: diffComparisonSchema,
  })
  .strict()
  .superRefine((diff, ctx) => {
    const baselineFieldsPresent =
      diff.base !== undefined ||
      diff.comparison.baselineId !== undefined ||
      diff.comparison.riskDelta !== undefined;
    if (diff.comparison.compatible) {
      if (!diff.base || diff.comparison.baselineId === undefined || diff.comparison.riskDelta === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'compatible diff requires base, baselineId, and riskDelta',
        });
      } else {
        if (diff.comparison.baselineId !== diff.base.metadata.inputId) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'baselineId must match base report inputId' });
        }
        const expectedDelta =
          diff.current.repository.regressionRiskScore - diff.base.repository.regressionRiskScore;
        if (diff.comparison.riskDelta !== expectedDelta) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'riskDelta must equal current score minus base score' });
        }
        if (diff.comparison.reason !== undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'compatible diff forbids an incompatibility reason' });
        }

        const severityRank = { low: 1, medium: 2, high: 3 } as const;
        const currentEvidence = new Map(diff.current.evidence.map((item) => [item.evidenceId, item]));
        const baseEvidence = new Map(diff.base.evidence.map((item) => [item.evidenceId, item]));
        const expectedNew = new Set<string>();
        const expectedWorsened = new Set<string>();
        const expectedImproved = new Set<string>();
        for (const [id, current] of currentEvidence) {
          const previous = baseEvidence.get(id);
          if (!previous) {
            expectedNew.add(id);
          } else if (severityRank[current.severity] > severityRank[previous.severity]) {
            expectedWorsened.add(id);
          } else if (severityRank[current.severity] < severityRank[previous.severity]) {
            expectedImproved.add(id);
          }
        }
        for (const id of baseEvidence.keys()) {
          if (!currentEvidence.has(id)) {
            expectedImproved.add(id);
          }
        }

        const changeSets = [
          ['newSignals', diff.comparison.newSignals, expectedNew],
          ['worsenedSignals', diff.comparison.worsenedSignals, expectedWorsened],
          ['improvedSignals', diff.comparison.improvedSignals, expectedImproved],
        ] as const;
        const allChangeIds: string[] = [];
        for (const [label, changes, expected] of changeSets) {
          const actual = changes.map((change) => change.evidenceId);
          allChangeIds.push(...actual);
          if (
            new Set(actual).size !== actual.length ||
            actual.length !== expected.size ||
            actual.some((id) => !expected.has(id))
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `${label} must exactly match the evidence delta`,
            });
          }
          for (const change of changes) {
            const current = currentEvidence.get(change.evidenceId);
            const previous = baseEvidence.get(change.evidenceId);
            const evidence = current ?? previous;
            const severitiesMatch =
              label === 'newSignals'
                ? change.previousSeverity === undefined && change.currentSeverity === current?.severity
                : label === 'worsenedSignals'
                  ? change.previousSeverity === previous?.severity && change.currentSeverity === current?.severity
                  : change.previousSeverity === previous?.severity && change.currentSeverity === current?.severity;
            if (
              !evidence ||
              change.signalId !== evidence.signalId ||
              !severitiesMatch ||
              change.path !== evidence.path ||
              change.message !== evidence.message
            ) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `${label} must describe the matching report evidence`,
              });
            }
          }
        }
        if (new Set(allChangeIds).size !== allChangeIds.length) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'compatible signal change sets must be disjoint' });
        }
      }
    } else if (baselineFieldsPresent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'incompatible diff forbids base, baselineId, and riskDelta',
      });
    } else {
      if (!diff.comparison.reason?.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'incompatible diff requires a reason' });
      }
      if (
        diff.comparison.newSignals.length > 0 ||
        diff.comparison.worsenedSignals.length > 0 ||
        diff.comparison.improvedSignals.length > 0
      ) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'incompatible diff forbids signal changes' });
      }
    }
    if (diff.redactionPolicyFingerprint) {
      if (diff.current.metadata.redactionPolicyFingerprint !== diff.redactionPolicyFingerprint) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'diff redaction policy must match current report metadata' });
      }
      if (diff.base && diff.base.metadata.redactionPolicyFingerprint !== diff.redactionPolicyFingerprint) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'diff redaction policy must match base report metadata' });
      }
    }
  });

export const baselineEntrySchema = z
  .object({
    schemaVersion: z.literal(BASELINE_SCHEMA_VERSION),
    kind: z.literal('r3-doctor/baseline'),
    inputId: z.string(),
    generatedAt: z.string(),
    assessmentContractVersion: z.literal(ASSESSMENT_CONTRACT_VERSION),
    sourceCommitSha: z.string().optional(),
    redactionPolicyFingerprint: z.string(),
    analysisContextFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    report: diagnosisReportSchema,
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.inputId !== entry.report.metadata.inputId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'baseline inputId must match report metadata' });
    }
    if (entry.generatedAt !== entry.report.metadata.generatedAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'baseline generatedAt must match report metadata' });
    }
    if (entry.assessmentContractVersion !== entry.report.metadata.assessmentContractVersion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'baseline assessment contract must match report metadata',
      });
    }
    if (entry.redactionPolicyFingerprint !== entry.report.metadata.redactionPolicyFingerprint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'baseline redaction policy must match report metadata',
      });
    }
  });

export const trendEntrySchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string(),
    inputId: z.string(),
    score: z.number().min(0).max(100),
    confidence: z.number().min(0).max(1),
    contractVersion: z.literal(ASSESSMENT_CONTRACT_VERSION),
    commitSha: z.string().optional(),
    changedFiles: z.array(z.string()).optional(),
    topClusters: z.array(z.object({ clusterId: clusterIdSchema, score: z.number() }).strict()),
  })
  .strict();

export type RiskAxisId = z.infer<typeof riskAxisIdSchema>;
export type SignalId = z.infer<typeof signalIdSchema>;
export type SourceLanguage = z.infer<typeof sourceLanguageSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type SemanticFinding = z.infer<typeof semanticFindingSchema>;
export type RiskCluster = z.infer<typeof riskClusterSchema>;
export type AxisAssessment = z.infer<typeof axisAssessmentSchema>;
export type Intervention = z.infer<typeof interventionSchema>;
export type RepositoryAssessment = z.infer<typeof repositoryAssessmentSchema>;
export type CapabilityResult = z.infer<typeof capabilityResultSchema>;
export type DiagnosisReport = z.infer<typeof diagnosisReportSchema>;
export type EvidenceChange = z.infer<typeof evidenceChangeSchema>;
export type BlastRadiusEntry = z.infer<typeof blastRadiusEntrySchema>;
export type DiffReport = z.infer<typeof diffReportSchema>;
export type BaselineEntry = z.infer<typeof baselineEntrySchema>;
export type TrendEntry = z.infer<typeof trendEntrySchema>;

export const SCORE_DISCLAIMER =
  'Regression Risk Score は将来のデグレ発生確率を保証しません。根拠と確信度とともに優先順位付けに使用してください。';

export const ALL_SIGNAL_IDS = signalIdSchema.options.filter((id) => id !== 'semantic-ambiguity');

export const SIGNAL_AXIS: Record<Exclude<SignalId, 'semantic-ambiguity'>, RiskAxisId> = {
  'dep-cycle': 'structural-fragility',
  'high-fan-out': 'change-blast-radius',
  'high-fan-in': 'change-blast-radius',
  'large-file': 'structural-fragility',
  'missing-test-pair': 'verification-gap',
  'git-churn': 'change-volatility',
  'barrel-reexport': 'structural-fragility',
  'deep-nesting': 'structural-fragility',
  'unresolved-import': 'structural-fragility',
};

export const MECHANISM_FOR_SIGNAL: Record<Exclude<SignalId, 'semantic-ambiguity'>, string> = {
  'dep-cycle': 'dependency-cycle',
  'high-fan-out': 'high-connectivity',
  'high-fan-in': 'high-connectivity',
  'large-file': 'large-file',
  'missing-test-pair': 'verification-gap',
  'git-churn': 'volatility',
  'barrel-reexport': 'barrel-export',
  'deep-nesting': 'deep-nesting',
  'unresolved-import': 'unresolved-import',
};

import type { DiagnosisReport } from '../schema/report.v1.js';
import { diagnosisReportSchema } from '../schema/report.v1.js';
import type { RepositorySnapshot } from '../intake/snapshot.js';
import { assessRisk } from '../assessment/risk.js';
import { capabilityApprovedEvidence } from '../assessment/capability.js';
import { buildInterventions } from '../recommendation/rules.js';
import { getDefaultPlugins, extractEvidenceWithPlugins, selectPlugins } from '../plugins/analyzer.js';
import type { AnalyzerPlugin } from '../plugins/analyzer.js';
import { runSemanticAnalysis } from '../semantic/provider.js';
import type { SemanticProviderFactory } from '../semantic/provider.js';
import { resolveCalibrationQuality } from '../calibration/quality.js';
import { resolveLocale } from '../i18n/locale.js';

export type DiagnosisDependencies = {
  semanticProviderFactory?: SemanticProviderFactory;
  analyzerPlugins?: AnalyzerPlugin[];
  skipCalibrationResolution?: boolean;
};

export async function runDiagnosis(
  snapshot: RepositorySnapshot,
  dependencies: DiagnosisDependencies = {},
): Promise<DiagnosisReport> {
  const plugins = dependencies.analyzerPlugins ?? getDefaultPlugins();
  const selected = selectPlugins(snapshot, plugins);
  const { evidence, analyzerIds, capabilities } = await extractEvidenceWithPlugins(snapshot, plugins);
  const { findings: semanticFindings, resolution: semanticResolution } = await runSemanticAnalysis(
    snapshot,
    evidence,
    dependencies.semanticProviderFactory,
  );

  const report = assessRisk({
    snapshot,
    evidence,
    semanticFindings,
    capabilities,
    analyzers: analyzerIds,
    selectedAnalyzers: selected.length,
    successfulAnalyzers: selected.length,
    semanticResolution,
    llmProvider:
      semanticResolution.status === 'available'
        ? semanticResolution.provider.name
        : snapshot.config.llm.enabled
          ? snapshot.config.llm.provider
          : 'none',
    semanticProviderImplementationVersion:
      semanticResolution.status === 'available' ? semanticResolution.provider.implementationVersion : undefined,
  });

  report.interventions = buildInterventions(
    capabilityApprovedEvidence(report.evidence, report.capabilities),
    report.clusters,
    snapshot.config.diagnosticSkipRoots,
    report.repository.confidence,
    snapshot.config.churnDays,
    resolveLocale(snapshot.config),
  );
  if (!dependencies.skipCalibrationResolution) {
    report.repository.calibration = await resolveCalibrationQuality(
      snapshot.repositoryPath,
      snapshot.config.policyFile,
    );
  }
  return diagnosisReportSchema.parse(report);
}
